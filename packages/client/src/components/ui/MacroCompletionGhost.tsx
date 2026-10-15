import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { completeMacro } from "../../lib/macro-completion";
import { insertTextAtCaret } from "../../lib/textarea-editing";
import { InlineGhostText } from "./InlineGhostText";

export interface MacroCompletion {
  /** Field text up to the caret; drawn transparent so the suffix lands at the caret. */
  before: string;
  suffix: string;
  /** Where the textarea sits inside its positioned wrapper. */
  box: CSSProperties;
  /** The textarea's own font and padding, so the ghost wraps exactly like the field. */
  text: CSSProperties;
  scrollLeft: number;
  scrollTop: number;
}

// Prompt fields get their font and padding from many callers' classes, so the
// ghost copies the computed values instead of repeating the class names.
const MIRRORED_PROPERTIES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "textIndent",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const;

function measure(textarea: HTMLTextAreaElement): Pick<MacroCompletion, "box" | "text"> {
  const computed = getComputedStyle(textarea);
  const text: Record<string, string> = {
    boxSizing: "border-box",
    borderStyle: "solid",
    borderColor: "transparent",
    // Grow with the text and let the outer box clip, so a scrolled field still shows the caret line.
    bottom: "auto",
    minHeight: "100%",
    overflow: "visible",
  };
  for (const property of MIRRORED_PROPERTIES) text[property] = computed[property];
  // A vertical scrollbar narrows the textarea's text column; widen the padding to wrap at the same place.
  const borders = parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth);
  const scrollbar = textarea.offsetWidth - textarea.clientWidth - borders;
  if (scrollbar > 0) text.paddingRight = `${parseFloat(computed.paddingRight) + scrollbar}px`;
  return {
    box: {
      top: textarea.offsetTop,
      left: textarea.offsetLeft,
      width: textarea.offsetWidth,
      height: textarea.offsetHeight,
    },
    text,
  };
}

/**
 * Macro ghost-text for a textarea: typing `{{ch` greys in `ar}}` and Tab accepts it,
 * like the omnibar and the Professor Mari composer; tapping the ghost accepts it too,
 * for phone keyboards without Tab. Attach `textareaRef`, call
 * `refresh` on focus, select and scroll, `clear` on blur, and `accept` first in keydown.
 */
export function useMacroCompletion(enabled: boolean, value: string) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [completion, setCompletion] = useState<MacroCompletion | null>(null);

  const refresh = useCallback(() => {
    const textarea = textareaRef.current;
    if (
      !enabled ||
      !textarea ||
      textarea.ownerDocument.activeElement !== textarea ||
      textarea.selectionStart !== textarea.selectionEnd
    ) {
      setCompletion(null);
      return;
    }
    const caret = textarea.selectionStart;
    const suffix = completeMacro(textarea.value, caret);
    if (!suffix) {
      setCompletion(null);
      return;
    }
    setCompletion({
      before: textarea.value.slice(0, caret),
      suffix,
      ...measure(textarea),
      scrollLeft: textarea.scrollLeft,
      scrollTop: textarea.scrollTop,
    });
  }, [enabled]);

  // The field is controlled, so check again once the new value is in the DOM.
  useLayoutEffect(refresh, [refresh, value]);

  const clear = useCallback(() => setCompletion(null), []);

  const insert = useCallback(() => {
    const textarea = textareaRef.current;
    if (completion && textarea) insertTextAtCaret(textarea, completion.suffix);
  }, [completion]);

  /** Accepts the ghost on a plain Tab. Returns true when it handled the key. */
  const accept = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (
        !completion ||
        event.defaultPrevented ||
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.nativeEvent.isComposing
      ) {
        return false;
      }
      event.preventDefault();
      insert();
      return true;
    },
    [completion, insert],
  );

  return { textareaRef, completion, refresh, clear, accept, insert };
}

/** Draws the macro ghost over its textarea. Render it right after the textarea, inside a positioned wrapper. */
export function MacroCompletionGhost({
  completion,
  onAccept,
}: {
  completion: MacroCompletion | null;
  /** Tapping the ghost accepts it; pass the hook's `insert`. */
  onAccept: () => void;
}) {
  if (!completion) return null;
  return (
    <div
      data-component="MacroCompletionGhost"
      className="pointer-events-none absolute overflow-hidden"
      style={completion.box}
    >
      <InlineGhostText
        value={completion.before}
        suffix={completion.suffix}
        multiline
        scrollLeft={completion.scrollLeft}
        scrollTop={completion.scrollTop}
        style={completion.text}
        onAccept={onAccept}
      />
    </div>
  );
}
