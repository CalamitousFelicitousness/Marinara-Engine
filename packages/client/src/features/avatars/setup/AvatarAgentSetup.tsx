// ──────────────────────────────────────────────
// Avatar setup on each avatar agent's Agent editor page (lane: base)
// ──────────────────────────────────────────────
// Pick a character or persona, turn its avatar on or off, choose the active kind and the lip sync,
// blink and idle-motion switches, preview it, then show AVATAR_KIND_SETUP_PANELS for the kinds this
// agent owns (AVATAR_KIND_AGENT) and, on the 2D page, AVATAR_GENERATION_PANEL. Not in Sprite Cards.
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, Trash2, Upload, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AVATAR_2D_AGENT_ID,
  AVATAR_IMPORT_EXTENSIONS,
  type AvatarAgentId,
  type AvatarConfigUpdate,
  type AvatarFeatureFlags,
  type AvatarImportResult,
  type AvatarKind,
  type AvatarKindDataMap,
  type AvatarOwnerRef,
  type AvatarOwnerType,
} from "@marinara-engine/shared";
import { SettingsSwitch } from "../../../components/panels/settings/SettingControls";
import {
  useAvatarModel,
  useAvatarModelList,
  useDeleteAvatarKind,
  useImportAvatarModel,
  useUpdateAvatarModel,
} from "../../../hooks/use-avatar-models";
import { useCharacterSprites, useCharacters, usePersonas } from "../../../hooks/use-characters";
import { showConfirmDialog } from "../../../lib/app-dialogs";
import { parseCharacterDisplayData } from "../../../lib/character-display";
import { cn } from "../../../lib/utils";
import { AVATAR_GENERATION_PANEL, AVATAR_KIND_SETUP_PANELS, type AvatarAgentSetupProps } from "../contract";
import {
  avatarAgentKinds,
  avatarBindingTargets,
  avatarEditableSlots,
  buildPngtuberFromSprites,
  withBindingOverride,
} from "./avatar-setup-logic";
import { AvatarSetupPreview } from "./AvatarSetupPreview";

const KIND_LABEL_KEYS: Record<AvatarKind, { name: string; help: string; import: string }> = {
  pngtuber: {
    name: "avatars.setup.kind.pngtuber",
    help: "avatars.setup.kind.pngtuberHelp",
    import: "avatars.setup.import.pngtuber",
  },
  "mesh-avatar": {
    name: "avatars.setup.kind.meshAvatar",
    help: "avatars.setup.kind.meshAvatarHelp",
    import: "avatars.setup.import.meshAvatar",
  },
  vrm: { name: "avatars.setup.kind.vrm", help: "avatars.setup.kind.vrmHelp", import: "avatars.setup.import.vrm" },
};

const SOURCE_LABEL_KEYS = {
  preset: "avatars.setup.expressions.source.found",
  "name-match": "avatars.setup.expressions.source.found",
  "sprite-label": "avatars.setup.expressions.source.found",
  user: "avatars.setup.expressions.source.user",
  missing: "avatars.setup.expressions.source.missing",
} as const;

const FEATURE_KEYS: ReadonlyArray<readonly [keyof AvatarFeatureFlags, string, string]> = [
  ["lipSync", "avatars.setup.features.lipSync", "avatars.setup.features.lipSyncHelp"],
  ["blink", "avatars.setup.features.blink", "avatars.setup.features.blinkHelp"],
  ["idleMotion", "avatars.setup.features.idleMotion", "avatars.setup.features.idleMotionHelp"],
];

const SELECT_CLASS =
  "w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]";
const CARD_CLASS = "rounded-xl bg-[var(--secondary)]/55 ring-1 ring-[var(--border)]";

function ownerValue(owner: AvatarOwnerRef): string {
  return `${owner.ownerType}:${owner.ownerId}`;
}

function parseOwnerValue(value: string): AvatarOwnerRef | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const ownerType = value.slice(0, separator) as AvatarOwnerType;
  const ownerId = value.slice(separator + 1);
  return (ownerType === "character" || ownerType === "persona") && ownerId ? { ownerType, ownerId } : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function AvatarAgentSetup({ agentId }: AvatarAgentSetupProps) {
  const { t } = useTranslation();
  const kinds = useMemo(() => avatarAgentKinds(agentId), [agentId]);
  const { data: rawCharacters = [] } = useCharacters();
  const { data: personas = [] } = usePersonas();
  const { data: summaries } = useAvatarModelList();
  const [selectedOwner, setSelectedOwner] = useState("");
  const owner = useMemo(() => parseOwnerValue(selectedOwner), [selectedOwner]);

  const owners = useMemo(() => {
    const avatarOwners = new Set(
      (summaries ?? [])
        .filter((summary) => summary.kinds.some((kind) => kinds.includes(kind)))
        .map((summary) => ownerValue(summary.owner)),
    );
    const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name);
    const characters = rawCharacters
      .filter((row): row is { id: string; data: unknown } => typeof row.id === "string" && "data" in row)
      .map((row) => ({ value: `character:${row.id}`, name: parseCharacterDisplayData(row).name || row.id }))
      .sort(byName);
    const personaOptions = personas
      .map((persona) => ({ value: `persona:${persona.id}`, name: persona.name }))
      .sort(byName);
    return { characters, personas: personaOptions, avatarOwners };
  }, [kinds, personas, rawCharacters, summaries]);

  // Start on someone who already has an avatar for this agent, when there is one.
  useEffect(() => {
    if (selectedOwner || owners.avatarOwners.size === 0) return;
    const first = [...owners.characters, ...owners.personas].find((option) => owners.avatarOwners.has(option.value));
    if (first) setSelectedOwner(first.value);
  }, [owners, selectedOwner]);

  return (
    <div className="space-y-4" data-avatar-setup={agentId}>
      <label className="block space-y-1.5">
        <span className="text-xs font-semibold text-[var(--foreground)]">{t("avatars.setup.owner.label")}</span>
        <select
          value={selectedOwner}
          onChange={(event) => setSelectedOwner(event.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">{t("avatars.setup.owner.placeholder")}</option>
          {(
            [
              ["avatars.setup.owner.characters", owners.characters],
              ["avatars.setup.owner.personas", owners.personas],
            ] as const
          ).map(([groupKey, options]) =>
            options.length > 0 ? (
              <optgroup key={groupKey} label={t(groupKey)}>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {owners.avatarOwners.has(option.value)
                      ? t("avatars.setup.owner.hasAvatar", { name: option.name })
                      : option.name}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
      </label>
      {owner ? (
        <OwnerAvatarSetup key={selectedOwner} agentId={agentId} kinds={kinds} owner={owner} />
      ) : (
        <p className="text-xs text-[var(--muted-foreground)]">{t("avatars.setup.owner.empty")}</p>
      )}
    </div>
  );
}

/** One character's or persona's setup; remounted per owner, so its focus, messages and import notes reset. */
function OwnerAvatarSetup({
  agentId,
  kinds,
  owner,
}: {
  agentId: AvatarAgentId;
  kinds: readonly AvatarKind[];
  owner: AvatarOwnerRef;
}) {
  const { t } = useTranslation();
  const { data: config = null, isLoading: configLoading } = useAvatarModel(owner);
  const spritesQuery = useCharacterSprites(owner.ownerId);
  const sprites = spritesQuery.data ?? (spritesQuery.isLoading ? null : []);
  const update = useUpdateAvatarModel();
  const importAvatar = useImportAvatarModel();
  const removeKind = useDeleteAvatarKind();
  const [chosenKind, setChosenKind] = useState<AvatarKind | null>(null);
  const [importResult, setImportResult] = useState<AvatarImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingKind, setPendingKind] = useState<AvatarKind | null>(null);

  // Until the user picks one: the kind that shows in chats when it belongs to this page, else the first set up.
  const activeHere = config?.activeKind && kinds.includes(config.activeKind) ? config.activeKind : null;
  const focusedKind = chosenKind ?? activeHere ?? kinds.find((kind) => config?.kinds[kind]) ?? kinds[0]!;

  const save = async (change: AvatarConfigUpdate) => {
    setError(null);
    try {
      await update.mutateAsync({ owner, update: change });
    } catch (saveError) {
      setError(errorMessage(saveError, t("avatars.setup.saveFailed")));
    }
  };

  const startImport = (kind: AvatarKind, extensions: readonly string[]) => {
    const input = fileInputRef.current;
    if (!input) return;
    setPendingKind(kind);
    // Set the file types directly and open the picker in the same tap (Safari needs the click in the gesture).
    input.accept = extensions.join(",");
    input.click();
  };

  const handleFile = async (file: File | undefined) => {
    if (!file || !pendingKind) return;
    setError(null);
    setImportResult(null);
    try {
      const result = await importAvatar.mutateAsync({ owner, file, kind: pendingKind });
      setImportResult(result);
      setChosenKind(result.kind);
      toast.success(t("avatars.setup.import.done"));
    } catch (importError) {
      setError(errorMessage(importError, t("avatars.setup.import.failed")));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const buildFromSprites = async () => {
    const data = buildPngtuberFromSprites(
      (sprites ?? []).map((sprite) => sprite.expression),
      config?.kinds.pngtuber,
    );
    if (!data) {
      setError(t("avatars.setup.noSprites"));
      return;
    }
    await save({ kinds: { pngtuber: data }, ...(config?.activeKind ? {} : { activeKind: "pngtuber" }) });
  };

  const remove = async (kind: AvatarKind) => {
    const confirmed = await showConfirmDialog({
      title: t("avatars.setup.removeConfirmTitle"),
      message: t("avatars.setup.removeConfirmMessage"),
      confirmLabel: t("avatars.setup.remove"),
      tone: "destructive",
    });
    if (!confirmed) return;
    setError(null);
    try {
      await removeKind.mutateAsync({ owner, kind });
      setImportResult(null);
    } catch (removeError) {
      setError(errorMessage(removeError, t("avatars.setup.saveFailed")));
    }
  };

  if (configLoading) {
    return (
      <Loader2
        size="1rem"
        className="animate-spin text-[var(--muted-foreground)]"
        aria-label={t("avatars.setup.loading")}
      />
    );
  }

  const busy = update.isPending || importAvatar.isPending || removeKind.isPending;
  const focusedData = config?.kinds[focusedKind];
  const KindPanel = AVATAR_KIND_SETUP_PANELS[focusedKind];
  const GenerationPanel = AVATAR_GENERATION_PANEL;
  const onChanged = () => setImportResult(null);

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_13rem]">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />

      <div className="min-w-0 space-y-4">
        {config ? (
          <SettingsSwitch
            label={t("avatars.setup.enabled.label")}
            description={t("avatars.setup.enabled.description")}
            checked={config.enabled}
            disabled={busy}
            onChange={(enabled) => void save({ enabled })}
            labelPosition="start"
            className={cn("w-full justify-between p-3", CARD_CLASS)}
          />
        ) : null}

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-semibold text-[var(--foreground)]">
            {t("avatars.setup.kind.label")}
          </legend>
          {kinds.map((kind) => {
            const setUp = Boolean(config?.kinds[kind]);
            return (
              <label
                key={kind}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-xl p-3 ring-1 transition-colors",
                  focusedKind === kind
                    ? "bg-[var(--primary)]/10 ring-[var(--primary)]/40"
                    : "bg-[var(--secondary)]/55 ring-[var(--border)] hover:bg-[var(--accent)]",
                )}
              >
                <input
                  type="radio"
                  name={`avatar-kind-${agentId}`}
                  value={kind}
                  checked={focusedKind === kind}
                  onChange={() => setChosenKind(kind)}
                  className="mt-0.5 accent-[var(--primary)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold text-[var(--foreground)]">
                    {t(KIND_LABEL_KEYS[kind].name)}
                  </span>
                  <span className="block text-[0.625rem] text-[var(--muted-foreground)]">
                    {t(KIND_LABEL_KEYS[kind].help)}
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-[var(--secondary)] px-2 py-0.5 text-[0.625rem] text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
                  {config?.activeKind === kind
                    ? t("avatars.setup.kind.shown")
                    : setUp
                      ? t("avatars.setup.kind.setUp")
                      : t("avatars.setup.kind.notSetUp")}
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          {focusedKind === "pngtuber" ? (
            <ActionButton
              icon={<Wand2 size="0.8125rem" />}
              disabled={busy || sprites === null}
              onClick={() => void buildFromSprites()}
            >
              {t("avatars.setup.useSprites")}
            </ActionButton>
          ) : null}
          <ActionButton
            icon={<Upload size="0.8125rem" />}
            disabled={busy}
            onClick={() =>
              startImport(
                focusedKind,
                AVATAR_IMPORT_EXTENSIONS[focusedKind].filter((extension) => extension !== ".vrma"),
              )
            }
          >
            {t(KIND_LABEL_KEYS[focusedKind].import)}
          </ActionButton>
          {focusedKind === "vrm" && focusedData ? (
            <ActionButton
              icon={<Upload size="0.8125rem" />}
              disabled={busy}
              onClick={() => startImport("vrm", [".vrma"])}
            >
              {t("avatars.setup.import.vrmAnimation")}
            </ActionButton>
          ) : null}
          {focusedData && config?.activeKind !== focusedKind ? (
            <ActionButton disabled={busy} onClick={() => void save({ activeKind: focusedKind })}>
              {t("avatars.setup.kind.makeActive")}
            </ActionButton>
          ) : null}
          {focusedData ? (
            <ActionButton
              icon={<Trash2 size="0.8125rem" />}
              disabled={busy}
              danger
              onClick={() => void remove(focusedKind)}
            >
              {t("avatars.setup.remove")}
            </ActionButton>
          ) : null}
          {busy ? <Loader2 size="1rem" className="animate-spin text-[var(--muted-foreground)]" /> : null}
        </div>

        {error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-[var(--marinara-app-accent-static)] bg-[var(--secondary)] px-3 py-2 text-xs text-[var(--foreground)]"
          >
            <AlertTriangle size="0.875rem" className="mt-px shrink-0 text-[var(--marinara-app-accent-static)]" />
            <span className="min-w-0">{error}</span>
          </p>
        ) : null}
        {importResult?.warnings.length ? (
          <div className={cn("px-3 py-2", CARD_CLASS)}>
            <p className="text-xs font-semibold text-[var(--foreground)]">{t("avatars.setup.warnings")}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[0.6875rem] text-[var(--muted-foreground)]">
              {importResult.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {focusedData ? (
          <ExpressionBindings
            kind={focusedKind}
            data={focusedData}
            disabled={busy}
            onChange={(data) => void save({ kinds: { [focusedKind]: data } })}
          />
        ) : null}

        {config ? (
          <section className="space-y-2">
            <h4 className="text-xs font-semibold text-[var(--foreground)]">{t("avatars.setup.features.title")}</h4>
            {FEATURE_KEYS.map(([key, label, description]) => (
              <SettingsSwitch
                key={key}
                label={t(label)}
                description={t(description)}
                checked={config.features[key]}
                disabled={busy}
                onChange={(value) => void save({ features: { [key]: value } })}
                labelPosition="start"
                className={cn("w-full justify-between p-3", CARD_CLASS)}
              />
            ))}
          </section>
        ) : null}

        <Suspense fallback={<Loader2 size="1rem" className="animate-spin text-[var(--muted-foreground)]" />}>
          <KindPanel owner={owner} config={config} onChanged={onChanged} />
          {agentId === AVATAR_2D_AGENT_ID ? (
            <GenerationPanel owner={owner} config={config} onChanged={onChanged} />
          ) : null}
        </Suspense>
      </div>

      <div className="order-first md:order-none">
        <p className="mb-1.5 text-xs font-semibold text-[var(--foreground)]">{t("avatars.setup.preview.title")}</p>
        <AvatarSetupPreview owner={owner} config={config} kind={focusedKind} sprites={sprites} />
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  disabled,
  danger,
  onClick,
  children,
}: {
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn("mari-editor-action mari-editor-action--compact px-3", danger && "mari-editor-action--danger")}
    >
      {icon}
      {children}
    </button>
  );
}

/** Which of the model's faces shows for each feeling, with where each binding came from. */
function ExpressionBindings<K extends AvatarKind>({
  kind,
  data,
  disabled,
  onChange,
}: {
  kind: K;
  data: AvatarKindDataMap[K];
  disabled: boolean;
  onChange: (data: AvatarKindDataMap[K]) => void;
}) {
  const { t } = useTranslation();
  const targets = avatarBindingTargets(kind, data);
  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-xs font-semibold text-[var(--foreground)]">{t("avatars.setup.expressions.title")}</h4>
        <p className="text-[0.625rem] text-[var(--muted-foreground)]">{t("avatars.setup.expressions.help")}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {avatarEditableSlots(kind).map((slot) => {
          const binding = data.expressionMap[slot];
          const target = binding?.target ?? "";
          const sourceKey = SOURCE_LABEL_KEYS[!binding || binding.target === null ? "missing" : binding.source];
          const options = target && !targets.includes(target) ? [...targets, target] : targets;
          const slotLabel = t(`avatars.setup.slot.${slot}`);
          return (
            <div key={slot} className={cn("flex min-w-0 items-center gap-2 px-3 py-2", CARD_CLASS)}>
              <span className="w-20 shrink-0 text-xs text-[var(--foreground)]">{slotLabel}</span>
              <select
                value={target}
                disabled={disabled}
                aria-label={slotLabel}
                onChange={(event) => onChange(withBindingOverride(data, slot, event.target.value || null))}
                className="min-w-0 flex-1 rounded-lg bg-[var(--secondary)] px-2 py-1 text-xs ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                <option value="">{t("avatars.setup.expressions.none")}</option>
                {options.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <span className="shrink-0 text-[0.5625rem] text-[var(--muted-foreground)]">{t(sourceKey)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
