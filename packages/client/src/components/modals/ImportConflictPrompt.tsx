// What to do about each import whose name is already taken.
//
// One panel for the whole batch rather than one prompt per file: a folder drop
// can collide a dozen times, and answering the same question a dozen times is
// how people stop reading it. Each row still decides for itself, because a batch
// rarely wants one answer.
//
// The rows say which overwrites can be undone. Characters and personas keep a
// version of what they replace; lorebooks and presets keep nothing.

import { AlertTriangle, RotateCcw } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { ImportConflictResolution, ImportNameConflict } from "@marinara-engine/shared";
import type { ImportConflictChoices } from "../../lib/import-conflicts";
import { cn } from "../../lib/utils";

const RESOLUTION_LABEL_KEYS: Record<ImportConflictResolution, string> = {
  overwrite: "ui.modals.importconflictprompt.replace",
  additional: "ui.modals.importconflictprompt.keepBoth",
  skip: "ui.modals.importconflictprompt.skip",
};

const KIND_LABEL_KEYS: Record<string, string> = {
  character: "ui.modals.importconflictprompt.kindCharacter",
  persona: "ui.modals.importconflictprompt.kindPersona",
  lorebook: "ui.modals.importconflictprompt.kindLorebook",
  preset: "ui.modals.importconflictprompt.kindPreset",
};

const RESOLUTIONS: ImportConflictResolution[] = ["additional", "overwrite", "skip"];

/** Kept out of the markup so the localization audit does not read it as copy. */
const SEPARATOR = "·";

export interface ImportConflictPromptProps {
  conflicts: ImportNameConflict[];
  choices: ImportConflictChoices;
  onChange: (next: ImportConflictChoices) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ImportConflictPrompt({ conflicts, choices, onChange, onConfirm, onCancel }: ImportConflictPromptProps) {
  const { t: localizeUi } = useUiTranslation();
  const anyUnrecoverableReplace = conflicts.some(
    (conflict) => !conflict.recoverable && conflict.ref && choices[conflict.ref] === "overwrite",
  );

  const applyToAll = (resolution: ImportConflictResolution) => {
    const next: ImportConflictChoices = { ...choices };
    for (const conflict of conflicts) {
      if (conflict.ref) next[conflict.ref] = resolution;
    }
    onChange(next);
  };

  return (
    <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-4" data-component="ImportConflictPrompt">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 shrink-0 text-amber-400" size="1.125rem" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--foreground)]">
            {localizeUi("ui.modals.importconflictprompt.title", { count: conflicts.length })}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.modals.importconflictprompt.description")}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[0.625rem] font-medium text-[var(--muted-foreground)]">
              {localizeUi("ui.modals.importconflictprompt.applyToAll")}
            </span>
            {RESOLUTIONS.map((resolution) => (
              <button
                key={resolution}
                type="button"
                onClick={() => applyToAll(resolution)}
                className="rounded-md border border-[var(--border)] px-2 py-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
              >
                {localizeUi(RESOLUTION_LABEL_KEYS[resolution])}
              </button>
            ))}
          </div>

          <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-[var(--border)]/70 bg-[var(--background)]/40">
            {conflicts.map((conflict) => {
              const ref = conflict.ref ?? conflict.name;
              const chosen = choices[ref] ?? "additional";
              return (
                <div
                  key={`${conflict.kind}-${ref}`}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)]/60 px-3 py-2 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-[var(--foreground)]">{conflict.existingName}</p>
                    <p className="flex min-w-0 gap-1 text-[0.625rem] text-[var(--muted-foreground)]">
                      <span className="shrink-0">
                        {localizeUi(KIND_LABEL_KEYS[conflict.kind] ?? "ui.modals.importconflictprompt.kindCharacter")}
                      </span>
                      {conflict.ref && (
                        <>
                          <span aria-hidden="true">{SEPARATOR}</span>
                          <span className="truncate">{conflict.ref}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {RESOLUTIONS.map((resolution) => (
                      <button
                        key={resolution}
                        type="button"
                        aria-pressed={chosen === resolution}
                        onClick={() => onChange({ ...choices, [ref]: resolution })}
                        className={cn(
                          "rounded-md px-2 py-1 text-[0.625rem] font-medium transition-colors",
                          chosen === resolution
                            ? "bg-[var(--primary)]/15 text-[var(--foreground)]"
                            : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                        )}
                      >
                        {localizeUi(RESOLUTION_LABEL_KEYS[resolution])}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
            <RotateCcw className="mt-0.5 shrink-0" size="0.6875rem" />
            <span>{localizeUi("ui.modals.importconflictprompt.recoverableNote")}</span>
          </p>
          {anyUnrecoverableReplace && (
            <p className="mt-1 text-[0.625rem] font-medium leading-relaxed text-amber-400">
              {localizeUi("ui.modals.importconflictprompt.unrecoverableWarning")}
            </p>
          )}

          <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
            >
              {localizeUi("ui.modals.importconflictprompt.cancelImport")}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-lg bg-[var(--primary)] px-3 py-2 text-xs font-semibold text-[var(--primary-foreground)] transition-opacity hover:opacity-90"
            >
              {localizeUi("ui.modals.importconflictprompt.continue")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
