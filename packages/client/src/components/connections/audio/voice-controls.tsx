// ──────────────────────────────────────────────
// Voice controls
// ──────────────────────────────────────────────
// The pickers an audio engine needs, shared by the connection editor and the
// playback card.
//
// Which control fits depends on the source rather than on the screen: a
// searchable list where voices are an account-scoped catalog, a datalist where
// a short built-in set covers most cases, and a list beside a free-text field
// where a catalog exists but cloned or routed voice ids also have to be
// typeable.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, UserRound, Volume2 } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";

export const INPUT_CLS = "mari-chrome-field w-full px-3 py-2.5 text-sm placeholder:text-[var(--muted-foreground)]";

export const ELEVENLABS_DEFAULT_VOICE_OPTIONS: VoiceOption[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", category: "ElevenLabs default" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", category: "ElevenLabs default" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", category: "ElevenLabs default" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni", category: "ElevenLabs default" },
  { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli", category: "ElevenLabs default" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", category: "ElevenLabs default" },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold", category: "ElevenLabs default" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", category: "ElevenLabs default" },
  { id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam", category: "ElevenLabs default" },
];

export type CharacterOption = {
  id: string;
  name: string;
  label: string;
};

export type VoiceOption = {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  labels?: Record<string, string | number | boolean | null> | null;
};

export function addSavedVoiceOption(options: VoiceOption[], voiceId: string): VoiceOption[] {
  const id = voiceId.trim();
  if (!id || options.some((option) => option.id === id)) return options;
  return [...options, { id, name: id, category: "saved" }];
}

export function formatVoiceOptionLabel(option: VoiceOption): string {
  if (option.category === "saved") return `${option.id} (saved; not in current voice list)`;
  return option.name === option.id ? option.id : `${option.name} (${option.id})`;
}

export const ELEVENLABS_DEFAULT_MALE_VOICE_NAMES = new Set([
  "adam",
  "antoni",
  "arnold",
  "baxter",
  "bill",
  "brian",
  "callum",
  "caleb",
  "charlie",
  "chris",
  "clyde",
  "daniel",
  "darian",
  "dave",
  "drew",
  "eddie",
  "eldrin",
  "eric",
  "ethan",
  "fin",
  "finley",
  "george",
  "giovanni",
  "harry",
  "james",
  "jeremy",
  "joseph",
  "josh",
  "kaelen",
  "kellan",
  "lawrence",
  "liam",
  "michael",
  "patrick",
  "paul",
  "roger",
  "river",
  "ryan",
  "sam",
  "sawyer",
  "thomas",
  "warren",
  "will",
  "wyatt",
]);

export const ELEVENLABS_DEFAULT_FEMALE_VOICE_NAMES = new Set([
  "alice",
  "alicia",
  "aria",
  "charlotte",
  "domi",
  "dorothy",
  "elli",
  "elara",
  "elowen",
  "emily",
  "florence",
  "freya",
  "gigi",
  "glinda",
  "grace",
  "jade",
  "jessica",
  "laura",
  "lily",
  "maisie",
  "matilda",
  "mimi",
  "nicole",
  "rachel",
  "river",
  "sarah",
  "serena",
  "talia",
]);

export function normalizeVoiceName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function readVoiceMetadata(option: VoiceOption): string {
  return [
    option.name,
    option.id,
    option.description,
    option.category,
    ...Object.entries(option.labels ?? {}).flatMap(([key, value]) => [key, String(value ?? "")]),
  ]
    .filter(Boolean)
    .map(String)
    .join(" ");
}

export function inferVoiceOptionGender(option: VoiceOption): "male" | "female" | null {
  const metadata = normalizeVoiceName(readVoiceMetadata(option));
  if (/\b(female|feminine|woman|girl|lady)\b/.test(metadata)) return "female";
  if (/\b(male|masculine|man|boy|gentleman)\b/.test(metadata)) return "male";
  return null;
}

export function isElevenLabsVoiceForGender(
  option: VoiceOption,
  gender: "male" | "female",
  names: Set<string>,
): boolean {
  const inferredGender = inferVoiceOptionGender(option);
  if (inferredGender) return inferredGender === gender;

  const normalizedName = normalizeVoiceName(option.name);
  const normalizedId = normalizeVoiceName(option.id);
  return names.has(normalizedName) || names.has(normalizedId);
}

export function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function TtsDropdownIcon({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        "mari-chrome-control mari-chrome-control--small pointer-events-none absolute right-1.5 top-1/2 flex min-w-0 -translate-y-1/2 items-center justify-center p-0",
        compact ? "h-6 w-6" : "h-7 w-7",
      )}
      aria-hidden="true"
    >
      <ChevronDown size={compact ? "0.6875rem" : "0.75rem"} />
    </span>
  );
}

export type TtsSearchableSelectOption = {
  id: string;
  label: string;
  searchText: string;
  disabled?: boolean;
};

export function TtsSearchableSelect({
  value,
  options,
  disabled,
  placeholder,
  ariaLabel,
  searchPlaceholder,
  emptyText,
  optionKind,
  testId,
  compact = false,
  onChange,
}: {
  value: string;
  options: TtsSearchableSelectOption[];
  disabled: boolean;
  placeholder: string;
  ariaLabel: string;
  searchPlaceholder: string;
  emptyText: string;
  optionKind: "character" | "voice";
  testId: string;
  compact?: boolean;
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(
    null,
  );
  const selected = options.find((option) => option.id === value);
  const normalizedSearch = search.trim().toLowerCase();
  const filteredOptions = normalizedSearch
    ? options.filter((option) => option.searchText.toLowerCase().includes(normalizedSearch))
    : options;
  const restoreFrameRef = useRef(0);
  const restoreFocusToTrigger = useCallback(() => {
    // Deferred one frame: focusing synchronously races the panel unmount and
    // any concurrent re-render of the trigger row — the focus call can land
    // on a node that detaches a beat later, dropping focus to <body> (#5633).
    // Retried across frames: focus() on a disabled button is a silent no-op,
    // and the trigger is transiently disabled whenever a voices refetch flips
    // `fetchingVoices` — a single-frame restore landing in that window
    // stranded keyboard focus on <body> for good (#5642). Bounded so an
    // indefinitely disabled trigger cannot leak a perpetual rAF loop.
    const startedAt = performance.now();
    cancelAnimationFrame(restoreFrameRef.current);
    const attempt = () => {
      const trigger = triggerRef.current;
      // If focus has legitimately landed somewhere else in the meantime
      // (the user tabbed on), the restore is stale — never steal from them.
      const active = document.activeElement;
      if (active && active !== document.body && active !== trigger && !panelRef.current?.contains(active)) return;
      if (trigger && !trigger.disabled) {
        trigger.focus();
        if (document.activeElement === trigger) return;
      }
      if (performance.now() - startedAt > 2000) return;
      restoreFrameRef.current = requestAnimationFrame(attempt);
    };
    restoreFrameRef.current = requestAnimationFrame(attempt);
  }, []);

  useEffect(() => () => cancelAnimationFrame(restoreFrameRef.current), []);

  const closePanel = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      setSearch("");
      if (restoreFocus) restoreFocusToTrigger();
    },
    [restoreFocusToTrigger],
  );

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        closePanel(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePanel();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closePanel, open]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const trigger = rootRef.current;
      if (!trigger) return;
      const triggerRect = trigger.getBoundingClientRect();
      const viewportPadding = 12;
      const gap = 6;
      const preferredWidth = compact ? 352 : 384;
      const width = Math.min(
        Math.max(triggerRect.width, preferredWidth),
        Math.max(0, window.innerWidth - viewportPadding * 2),
      );
      const left = Math.min(
        Math.max(triggerRect.left, viewportPadding),
        Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
      );
      const availableBelow = window.innerHeight - triggerRect.bottom - viewportPadding - gap;
      const availableAbove = triggerRect.top - viewportPadding - gap;
      const desiredHeight = Math.min(panelRef.current?.offsetHeight ?? 320, 320);
      const openAbove = availableBelow < Math.min(220, desiredHeight) && availableAbove > availableBelow;
      const maxHeight = Math.max(160, Math.min(320, openAbove ? availableAbove : availableBelow));
      const panelHeight = Math.min(panelRef.current?.offsetHeight ?? desiredHeight, maxHeight);
      const top = openAbove
        ? Math.max(viewportPadding, triggerRect.top - panelHeight - gap)
        : Math.min(triggerRect.bottom + gap, window.innerHeight - panelHeight - viewportPadding);

      setPosition({ left, top, width, maxHeight });
    };

    let frame = 0;
    const schedulePositionUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updatePosition();
      });
    };

    updatePosition();
    schedulePositionUpdate();
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
    };
  }, [compact, open]);

  useEffect(() => {
    if (!disabled || !open) return;
    // Force-closing because the control became disabled unmounts the panel —
    // and with it the autofocused search input — so without a restore,
    // keyboard focus silently falls to <body> (#5642). Only restore when the
    // user's focus was actually inside this control. Focus already sitting on
    // <body> counts as inside: with few options no search input renders, so
    // focus stays on the trigger, and the browser drops it to <body>
    // synchronously when the trigger's disabled attribute lands — before this
    // effect can observe it. An outside pointerdown closes the panel through
    // closePanel(false) before focus could legitimately be elsewhere, and the
    // restore's own guard aborts if any real element takes focus meanwhile.
    const active = document.activeElement;
    const focusWasInside =
      !active ||
      active === document.body ||
      active === triggerRef.current ||
      panelRef.current?.contains(active) === true;
    setOpen(false);
    setSearch("");
    if (focusWasInside) restoreFocusToTrigger();
  }, [disabled, open, restoreFocusToTrigger]);

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          INPUT_CLS,
          "relative flex min-w-0 cursor-pointer items-center text-left disabled:cursor-not-allowed disabled:opacity-50",
          compact ? "py-2 pr-3 text-xs" : "pr-10",
        )}
      >
        <span className={cn("truncate", !value && "text-[var(--muted-foreground)]")}>
          {(selected?.label ?? value) || placeholder}
        </span>
        {!compact && <TtsDropdownIcon />}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[10001] flex overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)] p-1.5 shadow-2xl shadow-black/40"
            style={{
              left: position?.left ?? -9999,
              top: position?.top ?? -9999,
              width: position?.width ?? 0,
              maxHeight: position?.maxHeight ?? 320,
              opacity: position ? 1 : 0,
            }}
          >
            <div className="flex min-h-0 w-full flex-col">
              {options.length > 8 && (
                <label className="relative mb-1.5 block shrink-0">
                  <Search
                    size="0.75rem"
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--primary)]"
                  />
                  <input
                    autoFocus
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={searchPlaceholder}
                    className={cn(INPUT_CLS, "py-2 pl-8 text-xs")}
                  />
                </label>
              )}
              <div
                id={listboxId}
                role="listbox"
                aria-label={ariaLabel}
                data-testid={testId}
                className="min-h-0 overflow-x-hidden overflow-y-scroll pr-1 [scrollbar-color:var(--primary)_var(--secondary)] [scrollbar-gutter:stable] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--primary)] [&::-webkit-scrollbar-track]:bg-[var(--secondary)] [&::-webkit-scrollbar]:w-2"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={!value}
                  onClick={() => {
                    onChange("");
                    closePanel();
                  }}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-[var(--secondary)]",
                    !value && "bg-[var(--primary)]/10 text-[var(--primary)]",
                  )}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--secondary)] text-[var(--primary)]">
                    {optionKind === "character" ? <UserRound size="0.75rem" /> : <Volume2 size="0.75rem" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{placeholder}</span>
                  {!value && <Check size="0.75rem" className="shrink-0" />}
                </button>
                {filteredOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={option.id === value}
                    aria-disabled={option.disabled || undefined}
                    disabled={option.disabled}
                    title={option.label}
                    onClick={() => {
                      onChange(option.id);
                      closePanel();
                    }}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-[var(--secondary)] disabled:cursor-not-allowed disabled:opacity-40",
                      option.id === value && "bg-[var(--primary)]/10 text-[var(--primary)]",
                    )}
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--secondary)] text-[var(--primary)]">
                      {optionKind === "character" ? <UserRound size="0.75rem" /> : <Volume2 size="0.75rem" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.id === value && <Check size="0.75rem" className="shrink-0" />}
                  </button>
                ))}
                {filteredOptions.length === 0 && (
                  <p className="px-2.5 py-3 text-center text-xs text-[var(--muted-foreground)]">{emptyText}</p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function VoiceSelect({
  value,
  options,
  disabled,
  placeholder,
  ariaLabel,
  compact = false,
  onChange,
}: {
  value: string;
  options: VoiceOption[];
  disabled: boolean;
  placeholder: string;
  ariaLabel: string;
  compact?: boolean;
  onChange: (value: string) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <TtsSearchableSelect
      value={value}
      options={options.map((option) => ({
        id: option.id,
        label: formatVoiceOptionLabel(option),
        searchText: readVoiceMetadata(option),
      }))}
      disabled={disabled}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      searchPlaceholder={localizeUi("ui.panels.ttsconfigcard.searchVoices")}
      emptyText={localizeUi("ui.panels.ttsconfigcard.noMatchingVoices")}
      optionKind="voice"
      testId="tts-voice-options"
      compact={compact}
      onChange={onChange}
    />
  );
}

export function CustomizableVoiceInput({
  value,
  options,
  placeholder,
  ariaLabel,
  testId,
  compact = false,
  onChange,
}: {
  value: string;
  options: VoiceOption[];
  placeholder: string;
  ariaLabel: string;
  testId: string;
  compact?: boolean;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  return (
    <div className="min-w-0 flex-1">
      <input
        type="text"
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(INPUT_CLS, compact && "py-2 text-xs")}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        data-testid={testId}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {formatVoiceOptionLabel(option)}
          </option>
        ))}
      </datalist>
    </div>
  );
}

export function CharacterSelect({
  value,
  options,
  assignedCharacterIds,
  onChange,
}: {
  value: string;
  options: CharacterOption[];
  assignedCharacterIds: Set<string>;
  onChange: (value: string) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <TtsSearchableSelect
      value={value}
      options={options.map((option) => ({
        id: option.id,
        label: option.label,
        searchText: `${option.name} ${option.label}`,
        disabled: assignedCharacterIds.has(option.id) && option.id !== value,
      }))}
      disabled={options.length === 0}
      placeholder={localizeUi("ui.panels.ttsconfigcard.selectCharacter")}
      ariaLabel={localizeUi("ui.panels.ttsconfigcard.selectCharacter")}
      searchPlaceholder={localizeUi("ui.panels.ttsconfigcard.searchCharacters")}
      emptyText={localizeUi("ui.panels.ttsconfigcard.noMatchingCharacters")}
      optionKind="character"
      testId="tts-character-options"
      compact
      onChange={onChange}
    />
  );
}

/**
 * A visible list of known voices beside a free-text field, for backends whose
 * catalog is real but not exhaustive: PocketTTS takes a server voice or a path,
 * NanoGPT takes a catalog voice or a MiniMax/Qwen/cloned id. A datalist input
 * alone hides the catalog, since the suggestions only appear once you type.
 */
export function PickOrTypeVoiceControl({
  value,
  options,
  fetching,
  selectLabel,
  inputLabel,
  choosePlaceholder,
  inputPlaceholder,
  onChange,
}: {
  value: string;
  options: VoiceOption[];
  fetching: boolean;
  selectLabel: string;
  inputLabel: string;
  choosePlaceholder?: string;
  inputPlaceholder?: string;
  onChange: (value: string) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const selectedServerVoice = options.some((option) => option.id === value) ? value : "";

  return (
    <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
      <div className="relative">
        <select
          aria-label={selectLabel}
          value={selectedServerVoice}
          onChange={(event) => {
            if (event.target.value) onChange(event.target.value);
          }}
          disabled={fetching || options.length === 0}
          className={cn(INPUT_CLS, "cursor-pointer appearance-none pr-10")}
        >
          <option value="">
            {fetching
              ? localizeUi("ui.panels.pocketttsvoicecontrol.loadingServerVoices")
              : (choosePlaceholder ?? localizeUi("ui.panels.pocketttsvoicecontrol.chooseServerVoice"))}
          </option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {formatVoiceOptionLabel(option)}
            </option>
          ))}
        </select>
        <TtsDropdownIcon />
      </div>
      <input
        aria-label={inputLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={INPUT_CLS}
        placeholder={inputPlaceholder ?? localizeUi("ui.panels.pocketttsvoicecontrol.voiceIdUrlOrPath")}
      />
    </div>
  );
}

export function NpcDefaultVoicePool({
  label,
  options,
  selected,
  onToggle,
  note,
}: {
  label: string;
  options: VoiceOption[];
  selected: string[];
  onToggle: (voiceId: string, checked: boolean) => void;
  note?: string;
}) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.6875rem] font-medium text-[var(--foreground)]">{label}</span>
        <span className="text-[0.625rem] text-[var(--muted-foreground)]">
          {selected.length} {localizeUi("ui.panels.npcdefaultvoicepool.selected")}
        </span>
      </div>
      {options.length > 0 ? (
        <div className="grid gap-1 sm:grid-cols-2">
          {options.map((option) => (
            <label
              key={option.id}
              className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg bg-black/10 px-2 py-1.5 text-xs transition-colors hover:bg-black/20"
            >
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={(e) => onToggle(option.id, e.target.checked)}
                className="h-3 w-3 shrink-0 rounded border-[var(--border)] accent-[var(--primary)]"
              />
              <span className="truncate">{formatVoiceOptionLabel(option)}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-[var(--border)] px-2.5 py-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {localizeUi("ui.panels.npcdefaultvoicepool.noProviderVoicesLoadedYet")}
        </p>
      )}
      {note && <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">{note}</p>}
    </div>
  );
}
