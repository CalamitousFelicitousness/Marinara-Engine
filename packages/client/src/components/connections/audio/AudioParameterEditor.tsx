// ──────────────────────────────────────────────
// Audio parameter editor
// ──────────────────────────────────────────────
// Extra request parameters for one lane, as fields or as raw JSON over the same
// record. Both views edit the same value, so a key typed in one appears in the
// other.
//
// The catalog decides only what is offered and how it renders. A key it does not
// know is a text row rather than a hidden one, because no backend's schema is
// knowable here and a value the user typed must never disappear from the screen
// that owns it.
//
// A cleared row removes the key rather than storing what looks like the default.
// That is the difference between following the backend and pinning a value it
// might change.

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import {
  audioParameterDefinition,
  audioParameterPaths,
  audioParameterSetsFor,
  readParameterPath,
  writeParameterPath,
  type AudioParameterDefinition,
  type AudioParameterRecord,
  type AudioPurpose,
  type TTSSourceId,
} from "@marinara-engine/shared";
import { cn } from "../../../lib/utils";
import { INPUT_CLS, TtsDropdownIcon } from "./voice-controls";

export interface AudioParameterEditorProps {
  source: TTSSourceId;
  purpose: AudioPurpose;
  value: AudioParameterRecord;
  onChange: (next: AudioParameterRecord) => void;
}

type ViewMode = "fields" | "json";

/** JSON literals, not copy: they are what the backend receives. */
const BOOLEAN_VALUES = ["true", "false"] as const;

/** A code sample rather than a sentence, so it stays the same in every language. */
const JSON_PLACEHOLDER = '{\n  "exaggeration": 0.7\n}';

function stringify(record: AudioParameterRecord): string {
  return Object.keys(record).length === 0 ? "" : JSON.stringify(record, null, 2);
}

/** An empty box means no parameters, which is how a lane is cleared entirely. */
function parseDraft(draft: string): { ok: true; value: AudioParameterRecord } | { ok: false; error: string } {
  const trimmed = draft.trim();
  if (!trimmed) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Parameters must be a JSON object" };
  }
  return { ok: true, value: parsed as AudioParameterRecord };
}

/** Rows to render: every catalog key for this lane, then anything else stored. */
function rowsFor(source: TTSSourceId, purpose: AudioPurpose, value: AudioParameterRecord) {
  const known = audioParameterSetsFor(source, purpose).flatMap((set) => set.parameters);
  const knownKeys = new Set(known.map((parameter) => parameter.key));
  const seeded = known.filter((parameter) => readParameterPath(value, parameter.key) !== undefined);
  const unknown = audioParameterPaths(value).filter((path) => !knownKeys.has(path));
  return { seeded, unknown, available: known.filter((parameter) => !seeded.includes(parameter)) };
}

function numberOrUndefined(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function KnownRow({
  definition,
  value,
  onChange,
}: {
  definition: AudioParameterDefinition;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const placeholder = definition.placeholder === undefined ? "" : String(definition.placeholder);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <code className="text-[0.6875rem] text-[var(--foreground)]">{definition.key}</code>
        <button
          type="button"
          onClick={() => onChange(undefined)}
          title={localizeUi("ui.connections.audioparametereditor.clear")}
          className="shrink-0 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        >
          <X size="0.6875rem" />
        </button>
      </div>
      {definition.kind === "boolean" ? (
        <div className="relative">
          <select
            value={value === undefined ? "" : String(value)}
            onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value === "true")}
            className={cn(INPUT_CLS, "appearance-none pr-10")}
          >
            <option value="">{localizeUi("ui.connections.audioparametereditor.engineDefault")}</option>
            {BOOLEAN_VALUES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <TtsDropdownIcon />
        </div>
      ) : definition.kind === "enum" ? (
        <div className="relative">
          <select
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value || undefined)}
            className={cn(INPUT_CLS, "appearance-none pr-10")}
          >
            <option value="">{localizeUi("ui.connections.audioparametereditor.engineDefault")}</option>
            {(definition.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <TtsDropdownIcon />
        </div>
      ) : definition.kind === "number" ? (
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={definition.min ?? 0}
            max={definition.max ?? 1}
            step={definition.step ?? 0.01}
            value={typeof value === "number" ? value : (definition.placeholder as number) || (definition.min ?? 0)}
            onChange={(event) => onChange(Number(event.target.value))}
            className={cn("flex-1 accent-sky-400", typeof value !== "number" && "opacity-50")}
          />
          <input
            type="number"
            min={definition.min}
            max={definition.max}
            step={definition.step}
            value={typeof value === "number" ? String(value) : ""}
            placeholder={placeholder}
            onChange={(event) => onChange(numberOrUndefined(event.target.value))}
            className={cn(INPUT_CLS, "w-20 text-right")}
          />
        </div>
      ) : (
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value || undefined)}
          className={INPUT_CLS}
        />
      )}
      <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">{localizeUi(definition.helpKey)}</p>
    </div>
  );
}

/** A stored key the catalog does not describe. Editable as text, never hidden. */
function UnknownRow({ path, value, onChange }: { path: string; value: unknown; onChange: (next: unknown) => void }) {
  const { t: localizeUi } = useUiTranslation();
  const [draft, setDraft] = useState(() => (typeof value === "string" ? value : JSON.stringify(value)));

  useEffect(() => {
    setDraft(typeof value === "string" ? value : JSON.stringify(value));
  }, [value]);

  const commit = () => {
    if (!draft.trim()) {
      onChange(undefined);
      return;
    }
    // A number or boolean typed here has to reach the provider as one, so the
    // JSON reading wins and plain text is the fallback.
    try {
      onChange(JSON.parse(draft));
    } catch {
      onChange(draft);
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <code className="text-[0.6875rem] text-[var(--foreground)]">{path}</code>
        <button
          type="button"
          onClick={() => onChange(undefined)}
          title={localizeUi("ui.connections.audioparametereditor.clear")}
          className="shrink-0 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        >
          <X size="0.6875rem" />
        </button>
      </div>
      <input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className={INPUT_CLS}
      />
    </div>
  );
}

export function AudioParameterEditor({ source, purpose, value, onChange }: AudioParameterEditorProps) {
  const { t: localizeUi } = useUiTranslation();
  const [mode, setMode] = useState<ViewMode>("fields");
  const [draft, setDraft] = useState(() => stringify(value));
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

  const serialized = stringify(value);
  useEffect(() => {
    if (mode === "json" && error === null) setDraft(serialized);
  }, [error, mode, serialized]);

  const { seeded, unknown, available } = rowsFor(source, purpose, value);
  const sets = audioParameterSetsFor(source, purpose);
  const write = (path: string, next: unknown) => onChange(writeParameterPath(value, path, next));

  const commitJson = () => {
    const parsed = parseDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onChange(parsed.value);
    setDraft(stringify(parsed.value));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {(["fields", "json"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                if (option === "json") setDraft(stringify(value));
                setError(null);
                setMode(option);
              }}
              aria-pressed={mode === option}
              className={cn(
                "rounded-md px-2 py-1 text-[0.625rem] font-medium transition-colors",
                mode === option
                  ? "bg-[var(--primary)]/15 text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
              )}
            >
              {option === "fields"
                ? localizeUi("ui.connections.audioparametereditor.fields")
                : localizeUi("ui.connections.audioparametereditor.json")}
            </button>
          ))}
        </div>
        {mode === "fields" && sets.length > 0 && (
          <div className="relative">
            <select
              value=""
              onChange={(event) => {
                const set = sets.find((candidate) => candidate.id === event.target.value);
                if (!set) return;
                // Seeded at the engine's own defaults, so the row appears set to
                // what the backend already does and the user tunes from there.
                let next = value;
                for (const parameter of set.parameters) {
                  if (readParameterPath(next, parameter.key) !== undefined) continue;
                  next = writeParameterPath(next, parameter.key, parameter.placeholder ?? parameter.min ?? "");
                }
                onChange(next);
              }}
              className={cn(INPUT_CLS, "w-auto appearance-none py-1 pr-8 text-[0.625rem]")}
            >
              <option value="">{localizeUi("ui.connections.audioparametereditor.addKnownSet")}</option>
              {sets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.name}
                </option>
              ))}
            </select>
            <TtsDropdownIcon />
          </div>
        )}
      </div>

      {mode === "json" ? (
        <div>
          <textarea
            value={draft}
            rows={6}
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-label={localizeUi("ui.connections.audioparametereditor.title")}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onBlur={commitJson}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.blur();
            }}
            placeholder={JSON_PLACEHOLDER}
            className={cn(INPUT_CLS, "font-mono text-[0.6875rem] leading-relaxed")}
          />
          <p className={cn("mt-1 text-[0.625rem]", error ? "text-amber-500" : "text-[var(--muted-foreground)]")}>
            {error ?? localizeUi("ui.connections.audioparametereditor.jsonHelp")}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {seeded.map((definition) => (
            <KnownRow
              key={definition.key}
              definition={definition}
              value={readParameterPath(value, definition.key)}
              onChange={(next) => write(definition.key, next)}
            />
          ))}
          {unknown.map((path) => (
            <UnknownRow
              key={path}
              path={path}
              value={readParameterPath(value, path)}
              onChange={(next) => write(path, next)}
            />
          ))}

          {seeded.length === 0 && unknown.length === 0 && (
            <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
              {localizeUi("ui.connections.audioparametereditor.emptyHelp")}
            </p>
          )}

          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={adding}
              placeholder={localizeUi("ui.connections.audioparametereditor.parameterName")}
              onChange={(event) => setAdding(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !adding.trim()) return;
                event.preventDefault();
                const definition = audioParameterDefinition(source, purpose, adding.trim());
                write(adding.trim(), definition?.placeholder ?? "");
                setAdding("");
              }}
              className={cn(INPUT_CLS, "flex-1 py-1 text-[0.6875rem]")}
            />
            <button
              type="button"
              disabled={!adding.trim()}
              onClick={() => {
                const definition = audioParameterDefinition(source, purpose, adding.trim());
                write(adding.trim(), definition?.placeholder ?? "");
                setAdding("");
              }}
              className="shrink-0 rounded-md bg-[var(--secondary)] p-1.5 text-[var(--foreground)] transition-colors hover:bg-[var(--secondary)]/70 disabled:opacity-40"
              title={localizeUi("ui.connections.audioparametereditor.addParameter")}
            >
              <Plus size="0.6875rem" />
            </button>
          </div>
          {available.length > 0 && (
            <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
              {localizeUi("ui.connections.audioparametereditor.knownHere", {
                value1: available.map((parameter) => parameter.key).join(", "),
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
