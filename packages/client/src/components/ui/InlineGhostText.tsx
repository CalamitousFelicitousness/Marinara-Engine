import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";

/**
 * Greyed-out continuation drawn behind a text field. The typed part is rendered
 * transparent so the suffix lands exactly where the caret is; `className` must
 * repeat the field's own font, padding and border classes for that to line up.
 * Decorative: the field itself keeps the real value and the accept hint.
 * With `onAccept`, the suffix can also be tapped, for keyboards without Tab.
 */
export function InlineGhostText({
  value,
  suffix,
  className,
  multiline,
  scrollLeft = 0,
  scrollTop = 0,
  style,
  onAccept,
}: {
  value: string;
  suffix: string;
  className?: string;
  multiline?: boolean;
  scrollLeft?: number;
  scrollTop?: number;
  /** Extra inline styles, e.g. a field's computed font and padding when classes can't be repeated. */
  style?: CSSProperties;
  /** Makes the suffix tappable. Called on pointer down, so the field never loses focus. */
  onAccept?: () => void;
}) {
  if (!suffix) return null;
  return (
    <div
      aria-hidden="true"
      data-component="InlineGhostText"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden text-transparent",
        multiline ? "whitespace-pre-wrap break-words" : "whitespace-pre",
        className,
      )}
      style={multiline ? { ...style, transform: `translate(${-scrollLeft}px, ${-scrollTop}px)` } : style}
    >
      {value}
      <span
        className={cn(
          "text-[var(--muted-foreground)]/55",
          // Right padding cancelled by margin widens the tap target without moving the text.
          onAccept &&
            "pointer-events-auto -mr-2 cursor-pointer rounded-r py-1 pr-2 pointer-coarse:bg-[var(--accent)]/60",
        )}
        onPointerDown={
          onAccept
            ? (event) => {
                // Without this the tap blurs the field first, which clears the suggestion.
                event.preventDefault();
                onAccept();
              }
            : undefined
        }
      >
        {suffix}
      </span>
    </div>
  );
}
