import { useRef, type KeyboardEvent } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

export type ParameterSource = "connection" | "override" | "off";

const SOURCE_LABEL_KEYS = {
  connection: "ui.ui.parametersourcecontrol.connection",
  override: "ui.ui.parametersourcecontrol.override",
  off: "ui.ui.parametersourcecontrol.off",
} as const satisfies Record<ParameterSource, string>;

const ALL_SOURCES: readonly ParameterSource[] = ["connection", "override", "off"];
const VALUE_SOURCES: readonly ParameterSource[] = ["connection", "override"];

/** Where a chat takes one parameter from: the layers below the chat, its own value, or nowhere. */
export function ParameterSourceControl({
  label,
  value,
  onChange,
  allowOff = true,
  disabled = false,
}: {
  /** Parameter name, used in the group's accessible label. */
  label: string;
  value: ParameterSource;
  onChange: (value: ParameterSource) => void;
  /** Fields that always have a value offer only Connection and Override. */
  allowOff?: boolean;
  disabled?: boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  const sources = allowOff ? ALL_SOURCES : VALUE_SOURCES;
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number) => {
    const next = sources[(index + sources.length) % sources.length]!;
    onChange(next);
    optionRefs.current[sources.indexOf(next)]?.focus();
  };

  // Radio-group keyboard pattern: arrows move and select, Home and End jump to the ends.
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") select(index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") select(index - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(sources.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      role="radiogroup"
      aria-label={localizeUi("ui.ui.parametersourcecontrol.groupLabel", { parameter: label })}
      aria-disabled={disabled || undefined}
      className={cn(
        "mt-1 grid gap-1 rounded-lg border border-[var(--border)] bg-[var(--background)]/75 p-1",
        allowOff ? "grid-cols-3" : "grid-cols-2",
        disabled && "opacity-50",
      )}
    >
      {sources.map((source, index) => {
        const checked = value === source;
        return (
          <button
            key={source}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(source)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              "flex min-h-7 items-center justify-center rounded-md px-2 py-1 text-center text-[0.625rem] font-semibold transition-all disabled:cursor-not-allowed",
              checked
                ? "bg-[var(--primary)]/12 text-[var(--foreground)] ring-1 ring-[var(--primary)]/35"
                : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
            )}
          >
            {localizeUi(SOURCE_LABEL_KEYS[source])}
          </button>
        );
      })}
    </div>
  );
}
