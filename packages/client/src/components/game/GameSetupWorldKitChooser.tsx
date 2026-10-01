// The Setting kit choice of the Game setup wizard (worldgen W0): none, one of the starter kits, or
// one the model writes for the player's own setting. A kit gives the Game Master the words this
// kind of world uses and the kinds of change it allows. Every word can be changed here before the
// game starts; the game keeps the kit it was created with.
import { useRef, useState } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import {
  WORLD_CHANGE_KINDS,
  WORLD_PACES,
  WORLD_SCALES,
  WORLD_STARTER_KITS,
  parseWorldKit,
  worldKitReworded,
  type WorldKit,
  type WorldKitInput,
} from "@marinara-engine/shared";
import { ApiError, api } from "../../lib/api-client";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui.store";
import { GAME_SETUP_GHOST_BUTTON_CLASS, GAME_SETUP_INPUT_CLASS as INPUT } from "./game-setup-classes";

export interface WorldKitWriteRequest {
  connectionId: string;
  genre: string;
  setting: string;
  tone: string;
  language?: string;
}

// A lighter label than the wizard's own, since these fields sit inside one choice of the World step.
const FIELD_LABEL = "mb-1 block text-xs text-[var(--muted-foreground)]";

const splitWords = (text: string) =>
  text
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);

/** A list of the kit's words, typed as one comma-separated line. The line is kept as typed, so a
 *  trailing comma survives the keystroke, and is reset only when the kit changes from outside. */
export function WordsField({
  id,
  label,
  words,
  onChange,
}: {
  id: string;
  label: string;
  words: string[];
  onChange: (words: string[]) => void;
}) {
  const joined = words.join(", ");
  const [text, setText] = useState(joined);
  const [shown, setShown] = useState(joined);
  if (joined !== shown) {
    setShown(joined);
    setText(joined);
  }
  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      <input
        id={id}
        value={text}
        onChange={(event) => {
          const next = splitWords(event.target.value);
          setText(event.target.value);
          setShown(next.join(", "));
          onChange(next);
        }}
        className={INPUT}
      />
    </div>
  );
}

export function GameSetupWorldKitChooser({
  kit,
  onChange,
  writeRequest,
}: {
  kit: WorldKitInput | null;
  onChange: (kit: WorldKitInput | null) => void;
  /** What the model writes a kit for; null until a connection is chosen. */
  writeRequest: WorldKitWriteRequest | null;
}) {
  const { t } = useUiTranslation();
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const checked = kit ? parseWorldKit(kit) : null;
  // The kit as last drawn, so a write that comes back late lands only on the kit it was asked for:
  // picking another kit, or changing a word, while it was out keeps what the player did.
  const latest = useRef(kit);
  latest.current = kit;
  // The kit as it came in (picked, written or imported), which retyped words are read against, so a
  // word's id depends only on that kit and the words now typed, never on the keystrokes in between.
  const base = useRef(kit);
  const lastEdit = useRef<WorldKitInput | null>(null);
  if (kit !== lastEdit.current && kit !== base.current) base.current = kit;
  const from = <K extends "layers" | "sizes" | "groupKinds" | "placeTags" | "travel">(key: K) =>
    (base.current?.[key] ?? []) as NonNullable<WorldKitInput[K]>;

  const cardClass = (selected: boolean) =>
    cn(
      "flex w-full flex-col justify-start rounded-lg p-3 text-left text-xs transition-colors ring-1",
      selected
        ? "bg-[var(--primary)]/10 ring-[var(--primary)]/40"
        : "bg-[var(--secondary)] ring-[var(--border)] hover:ring-[var(--primary)]/20",
    );
  // Choosing the kit already chosen keeps it as it is: a second click must not throw away edits.
  const choose = (next: WorldKitInput | null) => {
    if ((kit?.id ?? null) === (next?.id ?? null)) return;
    setWriteError(null);
    onChange(next ? structuredClone(next) : null);
  };
  const edit = (change: (draft: WorldKitInput) => void) => {
    if (!kit) return;
    const draft = structuredClone(kit);
    change(draft);
    lastEdit.current = draft;
    onChange(draft);
  };
  const settlementsIndex = Math.max(0, kit?.layers.findIndex((layer) => layer.settlements) ?? 0);

  const write = async () => {
    if (!writeRequest || writing) return;
    setWriting(true);
    setWriteError(null);
    try {
      const asked = kit;
      const start = kit ? parseWorldKit(kit) : null;
      const { kit: written } = await api.post<{ kit: WorldKit }>("/game/world-kit", {
        ...writeRequest,
        ...(start?.ok ? { start: start.kit } : {}),
        debugMode: useUIStore.getState().debugMode,
      });
      if (latest.current === asked) onChange(written);
    } catch (error) {
      const reasons =
        error instanceof ApiError &&
        error.payload &&
        typeof error.payload === "object" &&
        Array.isArray((error.payload as { issues?: unknown }).issues)
          ? ((error.payload as { issues: unknown[] }).issues.filter((issue) => typeof issue === "string") as string[])
          : [];
      setWriteError(
        [error instanceof Error ? error.message : t("game.worldKit.setup.writeFailed"), ...reasons.slice(0, 3)].join(
          " ",
        ),
      );
    } finally {
      setWriting(false);
    }
  };

  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-[var(--foreground)]">{t("game.worldKit.setup.label")}</span>
      <p className="mb-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">{t("game.worldKit.setup.help")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={() => choose(null)} aria-pressed={!kit} className={cardClass(!kit)}>
          <span className="block font-medium text-[var(--foreground)]">{t("game.worldKit.setup.none")}</span>
          <span className="mt-1 block text-[var(--muted-foreground)]">{t("game.worldKit.setup.noneDescription")}</span>
        </button>
        {WORLD_STARTER_KITS.map((starter) => {
          const selected = kit?.id === starter.id;
          return (
            <button
              key={starter.id}
              type="button"
              onClick={() => choose(starter)}
              aria-pressed={selected}
              className={cardClass(selected)}
            >
              <span className="block font-medium text-[var(--foreground)]">{starter.label}</span>
              <span className="mt-1 line-clamp-3 block text-[var(--muted-foreground)]">{starter.summary}</span>
            </button>
          );
        })}
      </div>

      {kit && (
        <div className="mt-2 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 text-xs">
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => void write()}
              disabled={!writeRequest || writing}
              className={cn(
                GAME_SETUP_GHOST_BUTTON_CLASS,
                "gap-2 ring-1 ring-[var(--border)] disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <Sparkles size={13} />
              {writing ? t("game.worldKit.setup.writing") : t("game.worldKit.setup.write")}
            </button>
            <p className="text-[var(--muted-foreground)]">
              {writeRequest ? t("game.worldKit.setup.writeHelp") : t("game.worldKit.setup.writeNeedsConnection")}
            </p>
            {writeError && (
              <p role="alert" className="text-[var(--destructive)]">
                {writeError}
              </p>
            )}
          </div>

          <details>
            <summary className="cursor-pointer py-1 text-xs font-medium text-[var(--foreground)]">
              {t("game.worldKit.setup.editWords")}
            </summary>
            <div className="mt-2 space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label htmlFor="world-kit-label" className={FIELD_LABEL}>
                    {t("game.worldKit.setup.name")}
                  </label>
                  <input
                    id="world-kit-label"
                    value={kit.label}
                    onChange={(event) => edit((draft) => (draft.label = event.target.value))}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor="world-kit-scale" className={FIELD_LABEL}>
                    {t("game.worldKit.setup.scale")}
                  </label>
                  <select
                    id="world-kit-scale"
                    value={kit.scale}
                    onChange={(event) => edit((draft) => (draft.scale = event.target.value as WorldKit["scale"]))}
                    className={INPUT}
                  >
                    {WORLD_SCALES.map((scale) => (
                      <option key={scale} value={scale}>
                        {t(`game.worldKit.setup.scales.${scale}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label htmlFor="world-kit-summary" className={FIELD_LABEL}>
                  {t("game.worldKit.setup.summary")}
                </label>
                <textarea
                  id="world-kit-summary"
                  value={kit.summary}
                  rows={2}
                  onChange={(event) => edit((draft) => (draft.summary = event.target.value))}
                  className={INPUT}
                />
              </div>

              <WordsField
                id="world-kit-layers"
                label={t("game.worldKit.setup.layers")}
                words={kit.layers.map((layer) => layer.label)}
                onChange={(words) =>
                  edit((draft) => {
                    // The settlements stay with the layer of that name while it is still in the list,
                    // and otherwise with the layer at the same place in it.
                    const named = words.indexOf(kit.layers[settlementsIndex]?.label ?? "");
                    const settled = named >= 0 ? named : Math.min(settlementsIndex, words.length - 1);
                    draft.layers = worldKitReworded(from("layers"), words).map(
                      ({ settlements: _was, ...entry }: { id: string; label: string; settlements?: true }, index) =>
                        index === settled ? { ...entry, settlements: true as const } : entry,
                    );
                  })
                }
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label htmlFor="world-kit-settlements" className={FIELD_LABEL}>
                    {t("game.worldKit.setup.settlements")}
                  </label>
                  <select
                    id="world-kit-settlements"
                    value={settlementsIndex}
                    onChange={(event) =>
                      edit((draft) => {
                        const chosen = Number(event.target.value);
                        draft.layers = draft.layers.map(({ settlements: _was, ...layer }, index) =>
                          index === chosen ? { ...layer, settlements: true } : layer,
                        );
                      })
                    }
                    className={INPUT}
                  >
                    {kit.layers.map((layer, index) => (
                      <option key={`${layer.id}-${index}`} value={index}>
                        {layer.label}
                      </option>
                    ))}
                  </select>
                </div>
                <WordsField
                  id="world-kit-sizes"
                  label={t("game.worldKit.setup.sizes")}
                  words={kit.sizes.map((size) => size.label)}
                  onChange={(words) => edit((draft) => (draft.sizes = worldKitReworded(from("sizes"), words)))}
                />
              </div>
              <WordsField
                id="world-kit-groups"
                label={t("game.worldKit.setup.groups")}
                words={kit.groupKinds.map((group) => group.label)}
                onChange={(words) => edit((draft) => (draft.groupKinds = worldKitReworded(from("groupKinds"), words)))}
              />
              <WordsField
                id="world-kit-tags"
                label={t("game.worldKit.setup.placeTags")}
                words={(kit.placeTags ?? []).map((tag) => tag.label)}
                onChange={(words) => edit((draft) => (draft.placeTags = worldKitReworded(from("placeTags"), words)))}
              />
              <WordsField
                id="world-kit-travel"
                label={t("game.worldKit.setup.travel")}
                words={kit.travel.map((way) => way.label)}
                onChange={(words) => edit((draft) => (draft.travel = worldKitReworded(from("travel"), words)))}
              />

              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <label htmlFor="world-kit-year" className={FIELD_LABEL}>
                    {t("game.worldKit.setup.year")}
                  </label>
                  <input
                    id="world-kit-year"
                    value={kit.calendar.year}
                    onChange={(event) => edit((draft) => (draft.calendar.year = event.target.value))}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor="world-kit-day" className={FIELD_LABEL}>
                    {t("game.worldKit.setup.day")}
                  </label>
                  <input
                    id="world-kit-day"
                    value={kit.calendar.day}
                    onChange={(event) => edit((draft) => (draft.calendar.day = event.target.value))}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor="world-kit-era" className={FIELD_LABEL}>
                    {t("game.worldKit.setup.era")}
                  </label>
                  <input
                    id="world-kit-era"
                    value={kit.calendar.era ?? ""}
                    onChange={(event) =>
                      edit((draft) => {
                        if (event.target.value) draft.calendar.era = event.target.value;
                        else delete draft.calendar.era;
                      })
                    }
                    className={INPUT}
                  />
                </div>
              </div>
              <WordsField
                id="world-kit-months"
                label={t("game.worldKit.setup.months")}
                words={kit.calendar.months ?? []}
                onChange={(words) =>
                  edit((draft) => {
                    if (words.length) draft.calendar.months = words;
                    else delete draft.calendar.months;
                  })
                }
              />

              <fieldset className="space-y-1.5">
                <legend className={FIELD_LABEL}>{t("game.worldKit.setup.change")}</legend>
                <p className="text-[var(--muted-foreground)]">{t("game.worldKit.setup.changeHelp")}</p>
                {WORLD_CHANGE_KINDS.map((kind) => (
                  <div key={kind} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`world-kit-change-${kind}`}
                      checked={kit.change.kinds[kind].on}
                      onChange={(event) => edit((draft) => (draft.change.kinds[kind].on = event.target.checked))}
                      aria-label={t(`game.worldKit.setup.kinds.${kind}`)}
                      className="size-4 shrink-0 accent-[var(--primary)]"
                    />
                    <label
                      htmlFor={`world-kit-change-${kind}`}
                      className="w-24 shrink-0 text-[var(--muted-foreground)]"
                    >
                      {t(`game.worldKit.setup.kinds.${kind}`)}
                    </label>
                    <input
                      value={kit.change.kinds[kind].label}
                      onChange={(event) => edit((draft) => (draft.change.kinds[kind].label = event.target.value))}
                      aria-label={t("game.worldKit.setup.kindWords", { kind: t(`game.worldKit.setup.kinds.${kind}`) })}
                      className={cn(INPUT, !kit.change.kinds[kind].on && "opacity-60")}
                    />
                  </div>
                ))}
                <div>
                  <label htmlFor="world-kit-pace" className={FIELD_LABEL}>
                    {t("game.worldKit.setup.pace")}
                  </label>
                  <select
                    id="world-kit-pace"
                    value={kit.change.pace}
                    onChange={(event) =>
                      edit((draft) => (draft.change.pace = event.target.value as WorldKit["change"]["pace"]))
                    }
                    className={INPUT}
                  >
                    {WORLD_PACES.map((pace) => (
                      <option key={pace} value={pace}>
                        {t(`game.worldKit.setup.paces.${pace}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className={FIELD_LABEL}>{t("game.worldKit.setup.cultures")}</legend>
                {kit.cultures.map((culture, index) => (
                  <div
                    key={`${culture.id}-${index}`}
                    className="space-y-1 rounded-md border border-[var(--border)] p-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        value={culture.label}
                        onChange={(event) => edit((draft) => (draft.cultures[index]!.label = event.target.value))}
                        aria-label={t("game.worldKit.setup.cultureName")}
                        className={INPUT}
                      />
                      {kit.cultures.length > 1 && (
                        <button
                          type="button"
                          onClick={() => edit((draft) => draft.cultures.splice(index, 1))}
                          className="shrink-0 rounded-md px-2 py-1 text-[var(--muted-foreground)] ring-1 ring-[var(--border)] hover:text-[var(--foreground)]"
                        >
                          {t("game.worldKit.setup.removeCulture")}
                        </button>
                      )}
                    </div>
                    <textarea
                      value={culture.naming}
                      rows={2}
                      onChange={(event) => edit((draft) => (draft.cultures[index]!.naming = event.target.value))}
                      aria-label={t("game.worldKit.setup.cultureNaming")}
                      className={INPUT}
                    />
                  </div>
                ))}
                {kit.cultures.length < 12 && (
                  <button
                    type="button"
                    onClick={() =>
                      edit((draft) => {
                        const ids = new Set(draft.cultures.map((culture) => culture.id));
                        let n = draft.cultures.length + 1;
                        while (ids.has(`culture_${n}`)) n++;
                        draft.cultures.push({ id: `culture_${n}`, label: "", naming: "" });
                      })
                    }
                    className="rounded-md px-2 py-1 text-[var(--muted-foreground)] ring-1 ring-[var(--border)] hover:text-[var(--foreground)]"
                  >
                    {t("game.worldKit.setup.addCulture")}
                  </button>
                )}
              </fieldset>
            </div>
          </details>
          {checked && !checked.ok && (
            <div role="status" className="text-[var(--destructive)]">
              <span className="block">{t("game.worldKit.setup.invalid")}</span>
              {checked.issues.slice(0, 5).map((issue) => (
                <span key={issue} className="block">
                  {issue}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
