// ──────────────────────────────────────────────
// ConnectionDefaults — the Jobs box at the top of the Connections panel: one row per job with its Model, and
// its "If it fails" Model when set. A row opens the job's one picker (Model and If it fails). A job with a
// problem shows it as a chip on its row. Agents and Decision keep their other settings behind a gear.
// ──────────────────────────────────────────────
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Shuffle, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  BUILTIN_EMBEDDING_CONNECTION_ID,
  LOCAL_SIDECAR_CONNECTION_ID,
  TTS_SOURCE_DEFINITIONS,
  isAgentConfigDeleted,
  isChatProvider,
  parseConnectionImageCaptioningDefaults,
  isRetiredBuiltInAgentId,
  type ConnectionAccountListItem,
} from "@marinara-engine/shared";
import {
  useConnections,
  useMayReadImages,
  useDefaultEmbeddingConnection,
  useModelLists,
  useUpdateConnection,
} from "../../hooks/use-connections";
import {
  useConnectionAccounts,
  useFeatureModels,
  useSetFeatureModels,
  useUpdateConnectionAccount,
} from "../../hooks/use-connection-accounts";
import { useAgentConfigs, useUpdateAgent } from "../../hooks/use-agents";
import { useBuiltinEmbedding } from "../../hooks/use-builtin-embedding";
import { useDecisionOptions } from "../../hooks/use-decision-model";
import { useDeviceSetup, type DeviceItem } from "../../hooks/use-device-setup";
import { useEffectiveTTSConfig, useTTSConfig, useUpdateTTSConfig } from "../../hooks/use-tts";
import { useSidecarStore } from "../../stores/sidecar.store";
import { useUIStore } from "../../stores/ui.store";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { i18n } from "../../localization/i18n";
import { openAddConnection, type SetupItem } from "../../lib/add-connection";
import { createLocalSidecarConnectionOption, isConnectionFlagTrue } from "../../lib/connection-filters";
import { cn } from "../../lib/utils";
import { ToggleSetting } from "../panels/settings/SettingControls";
import { TTSConfigCard } from "../panels/settings/TTSConfigCard";
import { WebSearchSettings } from "../panels/settings/WebSearchSettings";
import { useWebSearchSettings } from "../../hooks/use-web-search-settings";
import { SpeechToTextCard } from "../panels/settings/SpeechToTextCard";
import { Modal } from "../ui/Modal";
import { ConnectionSelect } from "./ConnectionSelect";
import {
  FLAG_JOBS,
  JOB,
  JOBS,
  jobLabelKey,
  jobRowFilter,
  matchesKind,
  voiceRowOf,
  foundForJob,
  type Job,
  type JobKey,
} from "../../lib/connection-jobs";
import { MARI_QUICK_CONNECTION } from "../../lib/omnibar-aside-text";
import { EmbeddingDefaultControl } from "./EmbeddingDefaultControl";
import { DecisionDefaultControl } from "./DecisionDefaultControl";
import { LocalWhisper, SMALL_ACTION } from "./DeviceDetail";
import { ROW_BUTTON, type ConnectionRowData } from "./ConnectionRow";
import { JobRow, isUnset } from "./JobRow";
import { mediaSources } from "../../lib/media-source";
import { Spinner } from "../ui/Spinner";

function hostOf(url: string | null) {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

function JobIcon({ job }: { job: JobKey }) {
  const Icon = JOB[job].icon;
  return <Icon size="0.6875rem" />;
}

/** Feature values that are not a Model: quick answers can follow Professor Mari, Impersonate can shuffle. */
const FEATURE_EXTRA_OPTIONS: Partial<Record<JobKey, Array<{ value: string; key: string; icon: LucideIcon }>>> = {
  quick: [{ value: MARI_QUICK_CONNECTION, key: "connections.defaults.featureOption.sameAsMari", icon: JOB.mari.icon }],
  impersonate: [{ value: "random", key: "connections.defaults.featureOption.random", icon: Shuffle }],
};
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]";

/** `quiet`: an optional step, not a problem, so its fix shows without the amber warning look. */
type Warning = { text: string; short?: string; quiet?: boolean; fix?: { label: string; run: () => void } };

export type DefaultsTile = {
  key: JobKey;
  icon: ReactNode;
  title: string;
  value: string;
  /** The Connection, or what kind of service it is. */
  hint?: string;
  /** The fallback Model's name, when the job has one. */
  fallback?: string;
  /** The fallback Model, for its picture. */
  fallbackSource?: ConnectionRowData;
  /** The fallback Model's account. */
  fallbackHint?: string;
  /** An unset job reads quieter than a chosen one. */
  muted?: boolean;
  warning: Warning | null;
  /** The chosen Model, for its picture. */
  source?: ConnectionRowData;
  /** The job this one follows ("Follows Main"): `value` and `source` are the Model it really runs. */
  follows?: string;
  /** The engine this job needs is not set up: the tile leads to its set-up screen. */
  setup?: { item: SetupItem; text: string };
  /** An empty job: how many models the accounts' catalogs offer for it (Pick), or none (Add). */
  find?: { count: number; accounts: string[]; unknown?: boolean };
  /** A device job opens its engine's page instead of pickers. */
  device?: DeviceItem;
};

/** Every job's tile, the Main summary for the list row, and the problems. */
export function useConnectionDefaults(connectionsList: ConnectionRowData[]) {
  const { t } = useTranslation();
  const { data: accounts } = useConnectionAccounts();
  const updateAccount = useUpdateConnectionAccount();
  const openModal = useUIStore((s) => s.openModal);
  const sidecarModelDisplayName = useSidecarStore((s) => s.modelDisplayName);
  const sidecarAsAgentsDefault = useSidecarStore((s) => s.config.useAsAgentsDefault);
  const embeddingDefault = useDefaultEmbeddingConnection();
  const builtinEmbedding = useBuiltinEmbedding();
  const builtinEmbeddingActive =
    builtinEmbedding.data?.models.find((model) => model.id === builtinEmbedding.data?.activeModelId) ?? null;
  const decisionOptions = useDecisionOptions();
  const deviceSetup = useDeviceSetup();
  const { data: tts } = useTTSConfig();
  const updateTTS = useUpdateTTSConfig();
  const { data: speech } = useEffectiveTTSConfig();
  const speechToTextEnabled = useUIStore((s) => s.speechToTextEnabled);
  const featureModels = useFeatureModels();
  const webSearch = useWebSearchSettings();

  const accountById = useMemo(() => new Map((accounts ?? []).map((account) => [account.id, account])), [accounts]);
  const mainIsBuiltIn = useSidecarStore((s) => s.config.useAsMainDefault);
  const sidecarRow: ConnectionRowData = createLocalSidecarConnectionOption(sidecarModelDisplayName);
  const sidecarName = sidecarRow.name;
  /** The built-in model as a Model of its own, so its row has a picture and a name like any other. */
  const sidecarModel = { value: sidecarName, source: sidecarRow };
  // A job that points at the built-in model before it is downloaded shows the same fix as the Decision row.
  const builtInDownloaded = useSidecarStore((s) => s.modelDownloaded);
  const builtInWarning = builtInDownloaded
    ? null
    : {
        text: t("connections.defaults.warning.notDownloaded", { model: sidecarName }),
        short: t("connections.defaults.notDownloadedShort"),
        // The built-in model is optional.
        quiet: true,
        fix: {
          label: t("connections.defaults.setUp"),
          run: () => openAddConnection({ category: "device", item: "local-model" }),
        },
      };

  /** The name the user gave the Model, with its Connection as the muted second line. */
  const describe = (row: ConnectionRowData) => {
    const account = row.accountId ? accountById.get(row.accountId) : undefined;
    return { value: row.name?.trim() || row.model?.trim() || row.id, hint: account?.name, source: row };
  };
  /** A broken Connection behind the chosen Model, and its one fix. */
  const accountWarning = (account: ConnectionAccountListItem | undefined): Warning | null => {
    if (!account || account.state === "ok") return null;
    if (account.state === "off") {
      return {
        text: t("connections.defaults.warning.off", { connection: account.name }),
        short: t("connections.defaults.warning.offShort"),
        fix: {
          label: t("connections.defaults.fix.turnOn"),
          run: () => updateAccount.mutate({ id: account.id, enabled: true }),
        },
      };
    }
    return {
      text: t("connections.defaults.warning.needsKey", { connection: account.name }),
      short: t("connections.defaults.warning.needsKeyShort"),
      fix: {
        label: t("connections.defaults.fix.addKey"),
        run: () => openModal("connection-account", { accountId: account.id }),
      },
    };
  };

  const jobTile = (key: JobKey) => ({ key, icon: <JobIcon job={key} />, title: t(jobLabelKey(JOB[key])) });
  const primaryOf = (role: (typeof FLAG_JOBS)[number]) =>
    (role.key === "voice"
      ? voiceRowOf(connectionsList, speech?.resolvedConnectionId).row
      : connectionsList.find((row) => matchesKind(row, role.kind) && isConnectionFlagTrue(row[role.flag]))) ?? null;
  const mainRow = primaryOf(FLAG_JOBS.find((role) => role.key === "main")!);
  const agentsRow = primaryOf(FLAG_JOBS.find((role) => role.key === "agents")!);
  /** An unset job shows the model that really runs, like any row; "Follows Main/Agents" is the row's state. */
  const followsText = (from: JobKey) =>
    t(from === "agents" ? "connections.defaults.followsAgents" : "connections.defaults.followsMain");
  /** The followed job has no model: the plain "Follows ..." line. */
  const followsValue = (from: JobKey) => ({ value: followsText(from), muted: true });
  const inherited = (row: ConnectionRowData | null, from: JobKey) => {
    const model =
      from === "main" && mainIsBuiltIn ? { ...sidecarModel, warning: builtInWarning } : row ? describe(row) : null;
    const warning = from === "main" && mainIsBuiltIn ? builtInWarning : row ? accountWarning(accountOf(row)) : null;
    return model && { ...model, follows: followsText(from), warning };
  };

  const accountOf = (row: ConnectionRowData) => (row.accountId ? accountById.get(row.accountId) : undefined);
  const usable = (row: ConnectionRowData | null | undefined) => !!row && (accountOf(row)?.state ?? "ok") === "ok";
  /** A blocked job names the model that answers instead, as the server falls back to it; its fix stays. */
  const blockedWarning = (row: ConnectionRowData, job: string, instead: ConnectionRowData | null | undefined) => {
    const account = accountOf(row);
    const warning = accountWarning(account);
    if (!warning || !account || !usable(instead)) return warning;
    const key =
      account.state === "off" ? "connections.defaults.warning.offUses" : "connections.defaults.warning.needsKeyUses";
    return { ...warning, text: t(key, { job, model: describe(instead!).value }) };
  };

  const tiles: DefaultsTile[] = FLAG_JOBS.map((role) => {
    const primary = primaryOf(role);
    const fallbackRow =
      connectionsList.find((row) => matchesKind(row, role.kind) && isConnectionFlagTrue(row[role.fallback])) ?? null;
    const isAgents = role.key === "agents";
    const tile = {
      ...jobTile(role.key),
      fallback: fallbackRow ? describe(fallbackRow).value : undefined,
      fallbackSource: fallbackRow ?? undefined,
      fallbackHint: fallbackRow ? describe(fallbackRow).hint : undefined,
      warning: null,
    };
    if (isAgents && sidecarAsAgentsDefault) return { ...tile, ...sidecarModel, warning: builtInWarning };
    if (role.key === "main" && mainIsBuiltIn) return { ...tile, ...sidecarModel, warning: builtInWarning };
    if (primary) {
      const speechOff = role.key === "voice" && speech && !speech.speechEnabled;
      return {
        ...tile,
        ...describe(primary),
        warning:
          blockedWarning(primary, tile.title, fallbackRow) ??
          (speechOff && tts
            ? {
                text: t("connections.defaults.warning.ttsOff"),
                short: t("connections.defaults.warning.offShort"),
                fix: {
                  label: t("connections.defaults.fix.turnOn"),
                  run: () => updateTTS.mutate({ ...tts, enabled: true }),
                },
              }
            : null),
      };
    }
    // With no audio Connection, speech still answers from the app-level settings an older install saved.
    if (role.key === "voice" && speech?.speechEnabled && speech.origin === "legacy") {
      const value = TTS_SOURCE_DEFINITIONS[speech.resolvedSource]?.name ?? speech.resolvedSource;
      return { ...tile, value, hint: t("connections.add.device.tts"), muted: true };
    }
    // A lane with no pick of its own uses the shared Music & Sound Effects default.
    if (role.purpose) {
      const shared = connectionsList.find(
        (row) => row.provider === "audio_generation" && isConnectionFlagTrue(row.defaultForAgents),
      );
      if (shared) return { ...tile, ...describe(shared), follows: t("connections.defaults.followsAudioGeneration") };
      const offered = jobRowFilter(role)!;
      if (!connectionsList.some((row) => matchesKind(row, role.kind) && offered(row)))
        return {
          ...tile,
          value: t("connections.defaults.notSet"),
          muted: true,
          warning: {
            text: t("ui.panels.connectiondefaultssection.needsAValue1ConnectionWithThisSwitchedOn", {
              value1: t("connections.audioGeneration.category"),
            }),
            short: t("connections.defaults.notSetUp"),
            quiet: true,
          },
        };
    }
    // Agents follow the chat's model; a new chat uses Main.
    if (isAgents)
      return {
        ...tile,
        ...(inherited(mainRow, "main") ?? followsValue("main")),
      };
    return {
      ...tile,
      value: t("connections.defaults.notSet"),
      muted: true,
      warning:
        role.key === "main"
          ? { text: t("connections.defaults.warning.noMain"), short: t("connections.defaults.warning.noMainShort") }
          : null,
    };
  });

  // Embeddings: an app setting naming a Model with an embedding model, or the sidecar.
  const embeddingId = embeddingDefault.data?.connectionId ?? null;
  const embeddingRow = embeddingId ? connectionsList.find((row) => row.id === embeddingId) : undefined;
  const embeddings: DefaultsTile = {
    ...jobTile("embeddings"),
    value: t("connections.defaults.notSet"),
    muted: true,
    warning: null,
  };
  if (embeddingId === LOCAL_SIDECAR_CONNECTION_ID)
    Object.assign(embeddings, { ...sidecarModel, muted: false, warning: builtInWarning });
  else if (embeddingId === BUILTIN_EMBEDDING_CONNECTION_ID) {
    const name = t("connections.builtinEmbedding.name");
    Object.assign(embeddings, {
      // The model's own name says enough; "Built-in model (embeddings)" before it would push it out of the cell.
      value: builtinEmbeddingActive?.label ?? name,
      source: { id: BUILTIN_EMBEDDING_CONNECTION_ID, name, provider: "builtin-embedding" } as ConnectionRowData,
      muted: false,
      warning: builtinEmbeddingActive
        ? null
        : {
            text: t("connections.defaults.warning.notDownloaded", { model: name }),
            short: t("connections.defaults.notDownloadedShort"),
            fix: {
              label: t("connections.defaults.setUp"),
              run: () => useUIStore.getState().openConnectionDetail("device:local-model"),
            },
          },
    });
  } else if (embeddingRow) {
    const account = embeddingRow.accountId ? accountById.get(embeddingRow.accountId) : undefined;
    Object.assign(embeddings, {
      value: embeddingRow.embeddingModel?.trim() || embeddingRow.name,
      hint: account?.name ?? embeddingRow.name,
      // The row draws the embedding model, not the chat model the same Model also saves.
      source: { ...embeddingRow, model: embeddingRow.embeddingModel?.trim() || embeddingRow.model },
      muted: false,
      warning: accountWarning(account),
    });
  } else if (embeddingId) {
    Object.assign(embeddings, {
      value: t("connections.defaults.missing"),
      warning: {
        text: t("connections.defaults.warning.missing"),
        short: t("connections.defaults.warning.missingShort"),
      },
    });
  }

  // Decision: the Local Model slot that is not downloaded yet leads to its set-up screen.
  const decisionSelected = decisionOptions.data?.options.find((entry) => entry.selected) ?? null;
  const decisionNeedsLocal =
    decisionSelected?.slot === "primary" &&
    (decisionSelected.unavailable === "no_model" || decisionSelected.unavailable === "not_installed");
  // The built-in decision model turned off, not installed, or with a runtime an update made stale: its own
  // window turns it on, installs it, or reinstalls the runtime.
  const decisionNeedsBuiltIn =
    decisionSelected?.slot === "decision_sidecar" &&
    (decisionSelected.unavailable === "not_installed" || decisionSelected.unavailable === "not_enabled");
  const decisionRow =
    decisionSelected?.group === "connection"
      ? connectionsList.find((row) => row.id === decisionSelected.id)
      : undefined;
  const decision: DefaultsTile = {
    ...jobTile("decision"),
    ...(decisionRow
      ? { ...describe(decisionRow), value: decisionSelected!.label }
      : decisionSelected
        ? {
            value: decisionSelected.label,
            source: { ...sidecarRow, id: decisionSelected.id, name: decisionSelected.label },
          }
        : { value: t("connections.defaults.off"), muted: true }),
    warning: decisionNeedsLocal
      ? {
          text: t("connections.defaults.warning.notDownloaded", { model: decisionSelected.label }),
          short: t("connections.defaults.notDownloadedShort"),
          fix: {
            label: t("connections.defaults.setUp"),
            run: () => openAddConnection({ category: "device", item: "local-model" }),
          },
        }
      : decisionNeedsBuiltIn
        ? {
            text: t("connections.defaults.warning.decisionBuiltInNotReady"),
            short: t("connections.defaults.notSetUp"),
            fix: {
              label: t("connections.defaults.setUp"),
              run: () => openAddConnection({ category: "device", item: "decision-builtin" }),
            },
          }
        : decisionSelected?.unavailable
          ? {
              text: t("connections.defaults.warning.unavailable"),
              short: t("connections.defaults.warning.unavailableShort"),
            }
          : null,
    ...(decisionNeedsLocal
      ? { setup: { item: "local-model" as const, text: t("connections.defaults.notDownloadedShort") } }
      : decisionNeedsBuiltIn
        ? { setup: { item: "decision-builtin" as const, text: t("connections.defaults.notSetUp") } }
        : {}),
  };

  // Dictation: the chat microphone, and with Calls a speech-to-text server; the gear holds both.
  const sttOn = speechToTextEnabled || deviceSetup.stt.setUp;
  const stt: DefaultsTile = {
    ...jobTile("stt"),
    warning: null,
    value: t(sttOn ? "connections.accounts.state.ok" : "connections.accounts.state.off"),
    muted: !sttOn,
  };

  // Features name a Model, the sidecar, or a value of their own; unset ones follow their default. They stay out of
  // the problem count, as before.
  const features: DefaultsTile[] = JOBS.filter((job) => job.feature).map((job) => {
    const value = featureModels.data?.[job.feature!] ?? null;
    const extra = FEATURE_EXTRA_OPTIONS[job.key]?.find((option) => option.value === value);
    const row = value ? connectionsList.find((entry) => entry.id === value) : undefined;
    const fallbackId = job.fallbackFeature ? featureModels.data?.[job.fallbackFeature] : null;
    const fallbackRow = fallbackId ? connectionsList.find((entry) => entry.id === fallbackId) : undefined;
    const tile = {
      ...jobTile(job.key),
      warning: null,
      fallback: fallbackRow ? describe(fallbackRow).value : undefined,
      fallbackSource: fallbackRow ?? undefined,
      fallbackHint: fallbackRow ? describe(fallbackRow).hint : undefined,
    };
    if (!value) {
      // What the server runs when unset: Quick answers use the built-in model; Prof. Mari the agents
      // default, then Main; Impersonate the chat's model, which is Main in a new chat; Image reading nothing.
      if (job.follows === "sidecar") return { ...tile, ...sidecarModel, warning: builtInWarning };
      const from =
        job.follows === "agents"
          ? sidecarAsAgentsDefault
            ? { ...sidecarModel, follows: followsText("agents"), warning: builtInWarning }
            : (inherited(agentsRow, "agents") ?? inherited(mainRow, "main"))
          : job.follows === "main"
            ? inherited(mainRow, "main")
            : null;
      return { ...tile, ...(from ?? { value: t(`connections.defaults.featureDefault.${job.feature}`), muted: true }) };
    }
    if (extra) return { ...tile, value: t(extra.key) };
    if (value === LOCAL_SIDECAR_CONNECTION_ID) return { ...tile, ...sidecarModel, warning: builtInWarning };
    // A blocked model names who answers instead, as the server falls back: Impersonate uses the chat's model,
    // which is Main in a new chat; Image reading has no fallback; the rest use the agents default, then Main.
    if (row)
      return {
        ...tile,
        ...describe(row),
        warning: blockedWarning(
          row,
          tile.title,
          job.follows === "main" ? mainRow : job.follows === "off" ? null : usable(agentsRow) ? agentsRow : mainRow,
        ),
      };
    return {
      ...tile,
      value: t("connections.defaults.missing"),
      warning: {
        text: t("connections.defaults.warning.missing"),
        short: t("connections.defaults.warning.missingShort"),
      },
    };
  });

  // Web search names its engine; the SearXNG address shows as the hint. Reading it needs admin access.
  const searxngHost = webSearch.data?.provider === "searxng" ? hostOf(webSearch.data.searxngUrl) : undefined;
  const webSearchTile: DefaultsTile = {
    ...jobTile("webSearch"),
    warning: null,
    ...(webSearch.data
      ? { value: t(`settings.webSearch.providers.${webSearch.data.provider}`), hint: searxngHost }
      : { value: t("connections.defaults.webSearchUnknown"), muted: true }),
  };

  const byKey = new Map(
    [...tiles, embeddings, decision, ...(stt ? [stt] : []), webSearchTile, ...features].map((tile) => [tile.key, tile]),
  );
  const all = JOBS.map((job) => byKey.get(job.key)).filter((tile): tile is DefaultsTile => !!tile);
  // An empty job counts what the accounts' catalogs offer for it, so its row can say what to pick or that one is needed.
  const notSet = t("connections.defaults.notSet");
  // Sound effects and Music fall back to the shared generative audio default and have no catalog to search.
  const isEmpty = (tile: DefaultsTile) =>
    !tile.device &&
    !tile.setup &&
    !JOB[tile.key].purpose &&
    (isUnset(tile, notSet) || (tile.key === "decision" && !decisionSelected));
  const anyEmpty = all.some(isEmpty);
  const catalogRows = (accounts ?? []).flatMap((account) => {
    const row =
      account.state === "ok" &&
      connectionsList.find((entry) => entry.accountId === account.id && entry.provider === account.provider);
    return row ? [{ account, id: row.id }] : [];
  });
  const lists = useModelLists(anyEmpty ? catalogRows.map((entry) => entry.id) : []);
  const catalogs = catalogRows.flatMap(({ account }, index) => {
    const list = lists[index]?.data;
    return list ? [{ name: account.name, provider: account.provider, models: list.models ?? [] }] : [];
  });
  // Accounts with no catalog list (a Decision account) still offer the Models saved under them.
  const listed = new Set(catalogRows.filter((_, index) => lists[index]?.data).map(({ account }) => account.id));
  // A list still loading or failed can hide models: then Pick (the picker shows its own state), never Add.
  const unknown = !lists.every((list) => list.isSuccess);
  const findFor = (job: Job) => {
    const found = foundForJob(job, catalogs, (provider, kind) => mediaSources(provider, kind).length > 0);
    const kind = job.kind;
    const saved =
      kind && job.key !== "embeddings"
        ? connectionsList.filter((row) => !listed.has(row.accountId ?? "") && matchesKind(row, kind))
        : [];
    const names = saved.map((row) => accountOf(row)?.name ?? row.name);
    // A downloaded built-in embedding model is a choice for Embeddings with no account: Pick it, never Add one.
    if (job.key === "embeddings" && builtinEmbeddingActive) names.push(t("connections.builtinEmbedding.name"));
    const builtin = job.key === "embeddings" && builtinEmbeddingActive ? 1 : 0;
    return {
      count: found.count + saved.length + builtin,
      accounts: [...new Set([...found.accounts, ...names])],
      unknown,
    };
  };
  return all.map((tile) => (isEmpty(tile) ? { ...tile, find: findFor(JOB[tile.key]) } : tile));
}

/** Persisted with the Connection folds; no Connection id is "defaults". */
const DEFAULTS_FOLD_ID = "defaults";

type RoleField = (typeof FLAG_JOBS)[number]["flag"] | (typeof FLAG_JOBS)[number]["fallback"];

/** The jobs' Model pickers and the setters behind them; one hook so the rows stay plain. */
export function useJobModels(connectionsList: ConnectionRowData[]) {
  const { t } = useTranslation();
  const updateConnection = useUpdateConnection();
  const sidecarAsAgentsDefault = useSidecarStore((s) => s.config.useAsAgentsDefault);
  const mainIsBuiltIn = useSidecarStore((s) => s.config.useAsMainDefault);
  const updateSidecarConfig = useSidecarStore((s) => s.updateConfig);
  const featureModels = useFeatureModels();
  const setFeatureModels = useSetFeatureModels();
  const lite = import.meta.env.VITE_MARINARA_LITE === "true";

  const setRole = (field: RoleField, current: { id: string } | null, nextId: string | null) => {
    if (nextId === (current?.id ?? null)) return;
    if (!nextId) {
      if (current) updateConnection.mutate({ id: current.id, [field]: false });
      return;
    }
    updateConnection.mutate({ id: nextId, [field]: true });
  };
  // Read the sidecar flags fresh: an Undo can run after the window that set the job closed.
  const setMainDefault = (current: { id: string } | null, nextId: string | null) => {
    const mainIsBuiltIn = useSidecarStore.getState().config.useAsMainDefault;
    if (nextId === LOCAL_SIDECAR_CONNECTION_ID) {
      if (mainIsBuiltIn) return;
      void updateSidecarConfig({ useAsMainDefault: true });
      // The built-in model replaces any row-level Main; keep one source.
      if (current) updateConnection.mutate({ id: current.id, isDefault: false });
      return;
    }
    if (mainIsBuiltIn) void updateSidecarConfig({ useAsMainDefault: false });
    setRole("isDefault", current, nextId);
  };
  const setAgentsDefault = (current: { id: string } | null, nextId: string | null) => {
    const sidecarAsAgentsDefault = useSidecarStore.getState().config.useAsAgentsDefault;
    if (nextId === LOCAL_SIDECAR_CONNECTION_ID) {
      if (sidecarAsAgentsDefault) return;
      void updateSidecarConfig({ useAsAgentsDefault: true });
      // The sidecar default replaces any row-flag default; keep one source.
      if (current) updateConnection.mutate({ id: current.id, defaultForAgents: false });
      return;
    }
    if (sidecarAsAgentsDefault) void updateSidecarConfig({ useAsAgentsDefault: false });
    setRole("defaultForAgents", current, nextId);
  };

  /** What a job's picker needs: its two slots' values and setters. */
  const modelFor = (job: Job) => {
    const feature = job.feature;
    if (feature) {
      const fallbackKey = job.fallbackFeature;
      return {
        kind: job.kind ?? "chat",
        value: featureModels.data?.[feature] ?? null,
        onChange: (id: string | null) => setFeatureModels.mutate({ [feature]: id }),
        fallback: fallbackKey
          ? {
              value: featureModels.data?.[fallbackKey] ?? null,
              onChange: (id: string | null) => setFeatureModels.mutate({ [fallbackKey]: id }),
            }
          : undefined,
        defaultLabel: t(`connections.defaults.featureDefault.${feature}`),
        extraOptions: (FEATURE_EXTRA_OPTIONS[job.key as JobKey] ?? []).map((extra) => ({
          value: extra.value,
          label: t(extra.key),
          icon: <extra.icon size="0.875rem" className="mx-[0.3125rem] shrink-0 text-foreground/55" aria-hidden />,
        })),
        includeLocalSidecar: !lite && job.key !== "vision",
      };
    }
    const role = FLAG_JOBS.find((entry) => entry.key === job.key);
    if (!role) return null;
    const rows = connectionsList.filter((row) => matchesKind(row, role.kind));
    // The picker shows what is picked; the job row shows what answers (a fallback when nothing is picked).
    const primary = rows.find((row) => isConnectionFlagTrue(row[role.flag])) ?? null;
    const fallbackRow = rows.find((row) => isConnectionFlagTrue(row[role.fallback])) ?? null;
    const isAgents = job.key === "agents";
    const isMain = job.key === "main";
    const set = (currentId: string | null, id: string | null) => {
      const current = currentId ? { id: currentId } : null;
      if (isAgents) return setAgentsDefault(current, id);
      if (isMain) return setMainDefault(current, id);
      setRole(role.flag, current, id);
    };
    return {
      kind: role.kind,
      value:
        (isAgents && sidecarAsAgentsDefault) || (isMain && mainIsBuiltIn)
          ? LOCAL_SIDECAR_CONNECTION_ID
          : (primary?.id ?? null),
      /** Moves the job from a known row; Undo passes the row it set, as `primary` is stale then. */
      set,
      onChange: (id: string | null) => set(primary?.id ?? null, id),
      fallback: {
        value: fallbackRow?.id ?? null,
        onChange: (id: string | null) => setRole(role.fallback, fallbackRow, id),
      },
      defaultLabel: isAgents
        ? t("connections.defaults.followsMain")
        : job.key === "voice"
          ? t("ui.panels.connectiondefaultssection.useTheFallbackThenTheTextToSpeechSettings")
          : job.purpose
            ? t("ui.panels.connectiondefaultssection.useTheFallbackThenTheMusicAndSoundEffectsDefaults")
            : t("connections.defaults.none"),
      rowFilter: jobRowFilter(job),
      extraOptions: [],
      includeLocalSidecar: (isAgents || isMain) && !lite,
      required: isMain,
    };
  };
  return modelFor;
}

/** The rest of the Agents job: the paid-model warning and a reset of every agent's own Model. */
function AgentsSettings() {
  const { t } = useTranslation();
  const showPaid = useUIStore((s) => s.showPaidAgentConnectionWarning);
  const setShowPaid = useUIStore((s) => s.setShowPaidAgentConnectionWarning);
  const { data: agentConfigs } = useAgentConfigs();
  const updateAgent = useUpdateAgent();
  const [resetting, setResetting] = useState(false);
  const toReset = useMemo(
    () =>
      (agentConfigs ?? []).filter(
        (config) =>
          config.connectionId != null &&
          !isRetiredBuiltInAgentId(config.type) &&
          !isAgentConfigDeleted(config.settings),
      ),
    [agentConfigs],
  );
  const reset = async () => {
    if (toReset.length === 0) return;
    const confirmed = await showConfirmDialog({
      title: t("connections.defaults.resetAgents"),
      message: t("connections.defaults.resetAgentsConfirm", { count: toReset.length }),
    });
    if (!confirmed) return;
    setResetting(true);
    try {
      const results = await Promise.allSettled(
        toReset.map((config) => updateAgent.mutateAsync({ id: config.id, connectionId: null })),
      );
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
      toast.success(t("connections.defaults.resetAgentsDone", { count: toReset.length }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("connections.defaults.resetAgentsFailed"));
    } finally {
      setResetting(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 p-4">
      <ToggleSetting label={t("connections.defaults.paidWarning")} checked={showPaid} onChange={setShowPaid} />
      <button
        type="button"
        onClick={() => void reset()}
        disabled={resetting || toReset.length === 0}
        className={cn(SMALL_ACTION, "w-fit")}
      >
        {resetting ? <Spinner size="sm" /> : t("connections.defaults.resetAgents")}
      </button>
    </div>
  );
}

const ConnectionEditor = lazy(() =>
  import("./ConnectionEditor").then((module) => ({ default: module.ConnectionEditor })),
);

/** Chat Models whose own row overrides the Embeddings or Image reading job. */
function overridesOf(key: JobKey, rows: readonly ConnectionRowData[]) {
  if (key === "embeddings")
    return rows.filter(
      (row) =>
        isChatProvider(row.provider) &&
        !!(row.embeddingModel?.trim() || row.embeddingBaseUrl?.trim() || row.embeddingConnectionId),
    );
  if (key === "vision")
    return rows.filter(
      (row) =>
        isChatProvider(row.provider) &&
        Object.keys(parseConnectionImageCaptioningDefaults(row.defaultParameters)).length > 0,
    );
  return [];
}

/** Jobs with behaviour of their own: a gear opens the job's settings window. */
const JOB_SETTINGS = new Set<JobKey>(["voice", "stt", "decision", "agents", "webSearch"]);

/** A titled box in the job settings window. */
function JobSettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-[var(--border)] p-3">
      <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">{title}</h3>
      {children}
    </section>
  );
}

/** Dictation: the chat microphone switch, and with Calls installed the speech-to-text server. */
export function DictationSettings() {
  const { t } = useTranslation();
  const speechToTextEnabled = useUIStore((s) => s.speechToTextEnabled);
  const setSpeechToTextEnabled = useUIStore((s) => s.setSpeechToTextEnabled);
  const callsInstalled = useDeviceSetup().stt.available;
  return (
    <>
      <ToggleSetting
        label={t("settings.controls.speechToText.label")}
        checked={speechToTextEnabled}
        onChange={setSpeechToTextEnabled}
      />
      {/* ponytail: the speech-to-text server keeps its own address and key here; an account for it comes in S4. */}
      {callsInstalled && <SpeechToTextCard inDictation />}
      {/* The same Local Whisper card as the This device page, so Dictation can download its model here. */}
      {callsInstalled && import.meta.env.VITE_MARINARA_LITE !== "true" && <LocalWhisper />}
    </>
  );
}

/** One job: its row opens the job's picker; a job with behaviour of its own has a gear for its settings window. */
function DefaultsJobRow({
  tile,
  job,
  modelFor,
  onOpenDevice,
  overrides = [],
}: {
  /** Models that keep a setting of this job on their own row, edited here */
  overrides?: readonly ConnectionRowData[];
  tile: DefaultsTile;
  job: Job;
  modelFor: ReturnType<typeof useJobModels>;
  onOpenDevice: (item: DeviceItem) => void;
}) {
  const { t } = useTranslation();
  const mayReadImages = useMayReadImages();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const connectionSaving = useUIStore((s) => s.connectionSaving);
  const embeddings = job.key === "embeddings";
  const decision = job.key === "decision";
  const hasSettings = JOB_SETTINGS.has(job.key as JobKey) || overrides.length > 0;
  const model = embeddings || decision || job.device ? null : modelFor(job);
  const title = t(jobLabelKey(job));
  const onClick = () => {
    if (job.key === "webSearch") return setSettingsOpen(true);
    if (tile.device) return onOpenDevice(tile.device);
    if (tile.find?.count === 0 && !tile.find.unknown) return openAddConnection({ job: job.key as JobKey });
    if (tile.setup?.item) return openAddConnection({ category: "device", item: tile.setup.item });
    // Dictation has no Model to pick: its row opens its settings.
    if (job.device) return setSettingsOpen(true);
    setOpen(true);
  };
  const chevron = <ChevronRight size="0.875rem" className="shrink-0 text-[var(--muted-foreground)]" />;
  return (
    <div className="relative" data-defaults-role={job.key}>
      <JobRow
        // Pick or Add is the fix, so an empty job's own warning chip would only repeat it.
        tile={tile.find ? { ...tile, warning: null } : tile}
        data-defaults-tile={job.key}
        onClick={onClick}
        aria-haspopup={tile.device ? undefined : "dialog"}
        aria-label={t("connections.defaults.jobLabel", {
          role: tile.title,
          value: [tile.follows, tile.value].filter(Boolean).join(" · "),
        })}
        trailing={chevron}
        end={
          <>
            {tile.find && (
              <button
                type="button"
                onClick={onClick}
                className="mari-chrome-control mari-chrome-control--primary shrink-0 !min-h-7 !px-3 !py-1 !text-xs"
              >
                {t(tile.find.count || tile.find.unknown ? "connections.defaults.pick" : "connections.defaults.add")}
              </button>
            )}
            {hasSettings && (
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                aria-haspopup="dialog"
                aria-label={t("connections.defaults.settingsFor", { role: title })}
                // The panel's row-button look (quiet at rest, the shared accent hover), like the Connections rows.
                className={ROW_BUTTON}
              >
                <SlidersHorizontal size="0.875rem" aria-hidden />
              </button>
            )}
          </>
        }
      />
      {model && (
        <ConnectionSelect
          variant="controlled"
          open={open}
          onOpenChange={setOpen}
          job={title}
          jobKey={job.key as JobKey}
          {...model}
          rowFilter={job.key === "vision" ? mayReadImages : model.rowFilter}
        />
      )}
      {embeddings && <EmbeddingDefaultControl open={open} onOpenChange={setOpen} />}
      {decision && <DecisionDefaultControl open={open} onOpenChange={setOpen} />}
      {hasSettings && (
        <Modal
          open={settingsOpen}
          onClose={() => void closeIfClean(() => setSettingsOpen(false))}
          closeDisabled={connectionSaving}
          title={t("connections.defaults.settingsFor", { role: title })}
          width="max-w-xl"
        >
          <div className="flex flex-col gap-3">
            {!job.device && job.key !== "webSearch" && (
              <JobSettingsSection title={t("connections.jobSettings.model")}>
                <JobRow tile={tile} onClick={() => setOpen(true)} aria-haspopup="dialog" trailing={chevron} />
              </JobSettingsSection>
            )}
            {job.key === "voice" && <VoiceJobSettings />}
            {job.key === "stt" && <DictationSettings />}
            {job.key === "webSearch" && <WebSearchSettings />}
            {decision && <DecisionDefaultControl settings />}
            {decision && tile.source?.provider === "decision" && (
              <Suspense fallback={null}>
                <ConnectionEditor connectionId={tile.source.id} part="decision" />
              </Suspense>
            )}
            {overrides.length > 0 && (
              <JobSettingsSection title={t("connections.jobSettings.overrides")}>
                {overrides.map((row) => (
                  <div key={row.id} className="space-y-2">
                    <p className="text-xs font-medium">{row.name}</p>
                    <Suspense fallback={null}>
                      <ConnectionEditor
                        connectionId={row.id}
                        part={job.key === "vision" ? "captioning" : "embeddings"}
                      />
                    </Suspense>
                  </div>
                ))}
              </JobSettingsSection>
            )}
            {job.key === "agents" && <AgentsSettings />}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Closes a job settings window, asking first when a model part inside holds unsaved edits. */
export async function closeIfClean(close: () => void) {
  if (
    useUIStore.getState().editorDirty &&
    !(await showConfirmDialog({
      title: i18n.t("ui.layout.chatsidebar.unsavedChanges"),
      message: i18n.t("ui.layout.chatsidebar.youHaveUnsavedChangesDiscardAndContinue"),
      confirmLabel: i18n.t("ui.agents.agenteditor.discard"),
      tone: "destructive",
    }))
  )
    return;
  close();
}

/** Voice settings in both "Voice settings" windows: the card, then the Voice job's own row. */
export function VoiceJobSettings() {
  const connectionsList = (useConnections().data ?? []) as ConnectionRowData[];
  const { data: speech } = useEffectiveTTSConfig();
  const row = voiceRowOf(connectionsList, speech?.resolvedConnectionId).row;
  return (
    <>
      <TTSConfigCard defaultExpanded />
      {row?.provider === "audio" && (
        <Suspense fallback={null}>
          <ConnectionEditor connectionId={row.id} part="voice" />
        </Suspense>
      )}
    </>
  );
}

/** One job's "Model for" window on its own, for a "Set up" outside the Jobs box. Null for jobs without a row picker. */
export function JobPickerWindow({ job, onClose }: { job: Job; onClose: () => void }) {
  const { t } = useTranslation();
  const connectionsList = (useConnections().data ?? []) as ConnectionRowData[];
  const model = useJobModels(connectionsList)(job);
  if (job.key === "decision") return <DecisionDefaultControl open onOpenChange={(open) => !open && onClose()} />;
  if (!model) return null;
  return (
    <ConnectionSelect
      variant="controlled"
      open
      onOpenChange={(open) => !open && onClose()}
      job={t(jobLabelKey(job))}
      {...model}
    />
  );
}

/** The Jobs box at the top of the Connections panel: every job, its Model, and its "If it fails" Model. */
export function ConnectionDefaultsBox({
  connectionsList,
  onOpenDevice,
}: {
  connectionsList: ConnectionRowData[];
  onOpenDevice: (item: DeviceItem) => void;
}) {
  const { t } = useTranslation();
  const tiles = useConnectionDefaults(connectionsList);
  const modelFor = useJobModels(connectionsList);
  const folded = useUIStore((s) => s.connectionsCollapsed.includes(DEFAULTS_FOLD_ID));
  const toggleFold = useUIStore((s) => s.toggleConnectionCollapsed);
  const groups = [...new Set(JOBS.map((job) => job.group))];
  const main = tiles.find((tile) => tile.key === "main");
  const mainModel = main?.source && !main.muted ? main.value : null;
  return (
    <section
      aria-labelledby="connections-defaults-title"
      className={cn("mari-connection-group mari-connection-defaults-box", folded && "!py-1")}
    >
      <button
        type="button"
        data-connections-row="defaults"
        onClick={() => toggleFold(DEFAULTS_FOLD_ID)}
        aria-expanded={!folded}
        aria-controls={folded ? undefined : "connections-defaults"}
        className={cn(
          "relative flex w-full min-w-0 items-center gap-1.5 px-1.5 text-start",
          folded ? "min-h-10 py-0" : "min-h-11 py-1",
          FOCUS,
        )}
      >
        <span
          id="connections-defaults-title"
          className="min-w-0 flex-1 text-base font-semibold leading-6 text-[var(--foreground)]"
        >
          {t("connections.defaults.title")}
        </span>
        {/* Closed, the bar still says which Model chats use. */}
        {folded && mainModel && (
          <span className="min-w-0 truncate text-xs text-[var(--muted-foreground)]">{mainModel}</span>
        )}
        <ChevronDown
          size="1rem"
          className={cn(
            "shrink-0 text-[var(--muted-foreground)] transition-transform motion-reduce:transition-none",
            folded && "-rotate-90",
          )}
        />
      </button>
      {!folded && (
        <div id="connections-defaults" className="flex flex-col gap-1 pt-0.5">
          {groups.map((group) => (
            <div key={group} role="group" aria-labelledby={`connections-defaults-group-${group}`}>
              <p id={`connections-defaults-group-${group}`} className="mari-connection-defaults-group">
                {t(`connections.defaults.group.${group}`)}
              </p>
              <div className="mari-connection-model-well">
                {tiles
                  .filter((tile) => JOB[tile.key].group === group)
                  .map((tile) => (
                    <div key={tile.key} className="mari-connection-model-slot min-w-0">
                      <DefaultsJobRow
                        tile={tile}
                        job={JOB[tile.key]}
                        modelFor={modelFor}
                        onOpenDevice={onOpenDevice}
                        overrides={overridesOf(tile.key, connectionsList)}
                      />
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
