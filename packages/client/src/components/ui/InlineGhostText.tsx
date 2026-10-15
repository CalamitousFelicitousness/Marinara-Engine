import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";

/**
 * Greyed-out continuation drawn behind a text field. The typed part is rendered
 * transparent so the suffix lands exactly where the caret is; `className` must
 * repeat the field's own font, padding and border classes for that to line up.
 * Decorative: the field itself keeps the real value and the accept hint.
 */
export function InlineGhostText({
  value,
  suffix,
  className,
  multiline,
  scrollLeft = 0,
  scrollTop = 0,
  style,
}: {
  value: string;
  suffix: string;
  className?: string;
  multiline?: boolean;
  scrollLeft?: number;
  scrollTop?: number;
  /** Extra inline styles, e.g. a field's computed font and padding when classes can't be repeated. */
  style?: CSSProperties;
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
      <span className="text-[var(--muted-foreground)]/55">{suffix}</span>
    </div>
  );
}
