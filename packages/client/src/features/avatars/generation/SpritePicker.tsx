// Sprite thumbnails to choose from, one or several (lane: generation).
import { Check } from "lucide-react";
import type { SpriteInfo } from "../../../hooks/use-characters";
import { cn } from "../../../lib/utils";

export function SpritePicker({
  sprites,
  selected,
  onToggle,
  disabled,
  label,
}: {
  sprites: SpriteInfo[];
  selected: readonly string[];
  onToggle: (expression: string) => void;
  disabled?: boolean;
  /** Accessible name of the group. */
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      {sprites.map((sprite) => {
        const isSelected = selected.includes(sprite.expression);
        return (
          <button
            key={sprite.expression}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled}
            onClick={() => onToggle(sprite.expression)}
            className={cn(
              "relative flex min-h-11 flex-col items-center gap-1 rounded-xl bg-[var(--secondary)] p-1.5 text-[0.625rem] ring-1 transition-colors active:scale-95 disabled:cursor-not-allowed disabled:opacity-50",
              isSelected ? "ring-2 ring-[var(--primary)]" : "ring-[var(--border)] hover:ring-[var(--primary)]/50",
            )}
          >
            <img
              src={sprite.url}
              alt=""
              loading="lazy"
              className="aspect-square w-full rounded-lg object-contain"
              draggable={false}
            />
            <span className="w-full truncate text-center text-[var(--foreground)]">
              {sprite.expression.replace(/_/gu, " ")}
            </span>
            {isSelected && (
              <span className="absolute right-1 top-1 rounded-full bg-[var(--primary)] p-0.5 text-[var(--primary-foreground)]">
                <Check size="0.625rem" aria-hidden />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
