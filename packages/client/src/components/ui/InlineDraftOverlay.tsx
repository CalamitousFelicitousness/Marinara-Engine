import type { CSSProperties } from "react";
import { draftSegments, type ComposerMark } from "../../lib/composer-triggers";
import { cn } from "../../lib/utils";

/**
 * InlineGhostText plus marks: a decorative layer behind a plain textarea that paints a background
 * under chosen character ranges (`@` references) while the textarea keeps drawing the glyphs.
 * All text here is transparent and a mark may only paint (background, shadow, underline), never change
 * layout, or the marks would drift from the typed text. `className` must repeat the field's own font,
 * padding and border classes, as for InlineGhostText.
 */
export function InlineDraftOverlay({
  value,
  suffix,
  marks,
  className,
  multiline,
  scrollLeft = 0,
  scrollTop = 0,
  style,
  onAccept,
}: {
  value: string;
  suffix: string;
  marks: ComposerMark[];
  className?: string;
  multiline?: boolean;
  scrollLeft?: number;
  scrollTop?: number;
  /** Extra inline styles, e.g. a field's computed font and padding when classes can't be repeated. */
  style?: CSSProperties;
  /** Makes the suffix tappable. Called on pointer down, so the field never loses focus. */
  onAccept?: () => void;
}) {
  if (!suffix && marks.length === 0) return null;
  return (
    <div
      aria-hidden="true"
      data-component="InlineDraftOverlay"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden text-transparent",
        multiline ? "whitespace-pre-wrap break-words" : "whitespace-pre",
        className,
      )}
      style={multiline ? { ...style, transform: `translate(${-scrollLeft}px, ${-scrollTop}px)` } : style}
    >
      {draftSegments(value, marks).map((segment, index) =>
        segment.tone ? (
          <span key={index} className={`mari-composer-mark mari-composer-mark--${segment.tone}`}>
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
      {suffix ? (
        <span
          className={cn(
            "text-[var(--muted-foreground)]/55",
            // Right padding cancelled by margin widens the tap target without moving the text,
            // and an invisible ::after stretches it to a 44px-tall touch target.
            onAccept &&
              "pointer-events-auto relative -mr-2 cursor-pointer rounded-r py-1 pr-2 after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] pointer-coarse:bg-[var(--accent)]/60",
          )}
          onPointerDown={
            onAccept
              ? (event) => {
                  // A right or middle click is not an accept.
                  if (event.button !== 0) return;
                  // Without this the tap blurs the field first, which clears the suggestion.
                  event.preventDefault();
                  onAccept();
                }
              : undefined
          }
        >
          {suffix}
        </span>
      ) : null}
    </div>
  );
}
