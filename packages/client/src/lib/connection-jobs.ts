// ──────────────────────────────────────────────
// Connection jobs — every job a Model can do, in display order. The Defaults box, the Add
// window's "For a job" list, the pickers and the model-row role badges all read this one table,
// so a new job or a changed rule is one edit here.
// ──────────────────────────────────────────────
import {
  AudioWaveform,
  BrainCircuit,
  Database,
  Eye,
  Film,
  Globe,
  GraduationCap,
  ImageIcon,
  MessageCircleQuestion,
  MessageSquareText,
  Mic,
  Music,
  Sparkles,
  VenetianMask,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { isChatProvider, type ConnectionPickerKind, type FeatureModelConnections } from "@marinara-engine/shared";
import type { AddKind } from "./add-connection";
import { audioConnectionSupportsPurpose, isConnectionFlagTrue } from "./connection-filters";
import type { ConnectionModelRow } from "./connection-groups";

/** A picker kind, plus Music & Sound Effects rows, which only the sound effect and music jobs pick. */
export type PickerKind = ConnectionPickerKind | "audio_generation";
export type JobKind = Exclude<PickerKind, "all">;

export type Job = {
  key: string;
  icon: LucideIcon;
  /** The heading it sits under behind the Defaults box's "All jobs". */
  group: "chat" | "omnibar" | "media" | "background";
  /** Always shown in the Defaults box. */
  primary?: true;
  /** Which Models fit: the picker filter and the Add window's kind. */
  kind?: JobKind;
  /** The row flag that marks a Connection as this job's Model. */
  flag?: "isDefault" | "defaultForAgents" | "defaultForSfx" | "defaultForMusic";
  /** The row flag of its fallback Model; a job with one gets the default + fallback pickers. */
  fallback?: "fallbackForMain" | "fallbackForAgents" | "fallbackForSfx" | "fallbackForMusic";
  /** The game audio lane a Music & Sound Effects row must be switched on for. */
  purpose?: "sfx" | "music";
  /** Set in the feature-model setting instead of a row flag. */
  feature?: keyof FeatureModelConnections;
  /** Where its "If it fails" Model is kept, for a feature-set job. */
  fallbackFeature?: keyof FeatureModelConnections;
  /** What answers while the feature is unset. */
  follows?: "agents" | "main" | "sidecar" | "off";
  /** A device service (Dictation) set up on its own screen. */
  device?: "stt";
  /** Not one of the Add window's job cards; "search" still lets its search find it. */
  add?: false | "search";
  /** More words the Add window's search matches. */
  terms?: string;
};

const JOB_LIST = [
  {
    key: "main",
    icon: MessageSquareText,
    group: "chat",
    primary: true,
    kind: "chat",
    flag: "isDefault",
    fallback: "fallbackForMain",
  },
  {
    key: "agents",
    icon: Sparkles,
    group: "chat",
    primary: true,
    kind: "chat",
    flag: "defaultForAgents",
    fallback: "fallbackForAgents",
  },
  {
    key: "impersonate",
    icon: VenetianMask,
    group: "chat",
    kind: "chat",
    feature: "impersonateConnectionId",
    fallbackFeature: "impersonateFallbackConnectionId",
    follows: "main",
    add: false,
  },
  {
    key: "mari",
    icon: GraduationCap,
    group: "omnibar",
    kind: "chat",
    feature: "mariConnectionId",
    fallbackFeature: "mariFallbackConnectionId",
    follows: "agents",
  },
  {
    key: "quick",
    icon: MessageCircleQuestion,
    group: "omnibar",
    kind: "chat",
    feature: "omnibarAsideConnectionId",
    fallbackFeature: "omnibarAsideFallbackConnectionId",
    follows: "sidecar",
    add: false,
  },
  {
    key: "images",
    icon: ImageIcon,
    group: "media",
    primary: true,
    kind: "image",
    flag: "defaultForAgents",
    fallback: "fallbackForAgents",
  },
  { key: "video", icon: Film, group: "media", kind: "video", flag: "defaultForAgents", fallback: "fallbackForAgents" },
  // Speech resolves the audio default, then its fallback (services/tts/audio-config-resolution.ts).
  {
    key: "voice",
    icon: Volume2,
    group: "media",
    kind: "audio",
    flag: "defaultForAgents",
    fallback: "fallbackForAgents",
    terms: "tts audio speech",
  },
  // Each game audio lane resolves its own pair before the shared Music & Sound Effects default.
  {
    key: "sfx",
    icon: AudioWaveform,
    group: "media",
    kind: "audio_generation",
    flag: "defaultForSfx",
    fallback: "fallbackForSfx",
    purpose: "sfx",
    add: false,
  },
  {
    key: "music",
    icon: Music,
    group: "media",
    kind: "audio_generation",
    flag: "defaultForMusic",
    fallback: "fallbackForMusic",
    purpose: "music",
    add: false,
  },
  { key: "stt", icon: Mic, group: "media", device: "stt", add: "search", terms: "stt whisper" },
  { key: "decision", icon: BrainCircuit, group: "background", kind: "decision", flag: "defaultForAgents" },
  { key: "embeddings", icon: Database, group: "background", kind: "chat" },
  // Set on its own card behind the tile: a search engine is not a Model.
  { key: "webSearch", icon: Globe, group: "background", add: false, terms: "searxng duckduckgo search" },
  {
    key: "vision",
    icon: Eye,
    group: "background",
    kind: "chat",
    feature: "visionConnectionId",
    fallbackFeature: "visionFallbackConnectionId",
    follows: "off",
  },
] as const satisfies readonly Job[];

export type JobKey = (typeof JOB_LIST)[number]["key"];
export const JOBS: readonly (Job & { key: JobKey })[] = JOB_LIST;
export const JOB = Object.fromEntries(JOBS.map((job) => [job.key, job])) as Record<JobKey, Job & { key: JobKey }>;

export const jobLabelKey = (job: Job) =>
  job.feature ? `connections.defaults.feature.${job.feature}` : `connections.defaults.role.${job.key}`;
/** The provider of each non-chat kind. */
export const KIND_PROVIDER = {
  image: "image_generation",
  video: "video_generation",
  audio: "audio",
  audio_generation: "audio_generation",
  decision: "decision",
} as const;
/** The Add window's filter for a picker kind. Music & Sound Effects rows are split from a speech row, not added. */
export const ADD_KIND: Record<PickerKind, AddKind | undefined> = {
  chat: "chat",
  image: "image",
  video: "video",
  audio: "voice",
  audio_generation: undefined,
  decision: "decision",
  all: undefined,
};

export function matchesKind(row: Pick<ConnectionModelRow, "provider">, kind: PickerKind) {
  if (kind === "all") return true;
  return kind === "chat" ? isChatProvider(row.provider) : row.provider === KIND_PROVIDER[kind];
}

type FlagJob = Job & { key: JobKey } & Required<Pick<Job, "kind" | "flag" | "fallback">>;
/** Jobs set by a row flag with a fallback flag: a default and a fallback picker each. */
export const FLAG_JOBS = JOBS.filter((job): job is FlagJob => !!job.fallback);
/** The flag jobs a Connection can be set for, by its kind. */
export const rowJobs = (row: Pick<ConnectionModelRow, "provider">) =>
  FLAG_JOBS.filter((job) => matchesKind(row, job.kind));

/**
 * Rows a job's picker offers: a lane job only lists Music & Sound Effects rows switched on for its lane, plus any
 * row still holding its flags so a stale pick can be seen and cleared.
 */
export function jobRowFilter(job: Job) {
  const { purpose, flag, fallback } = job;
  if (!purpose) return undefined;
  return (row: ConnectionModelRow) =>
    audioConnectionSupportsPurpose(row, purpose) ||
    (!!flag && isConnectionFlagTrue(row[flag])) ||
    (!!fallback && isConnectionFlagTrue(row[fallback]));
}

/** The Add window's kind filter for a job, if it has one. */
export const jobAddKind = (key: JobKey) => {
  const kind = JOB[key].kind;
  return kind ? ADD_KIND[kind] : undefined;
};

/**
 * The audio row speech uses: the row `/tts/effective-config` resolved to; without one, the audio default.
 * `missing` when the resolved id names a row that is gone or not audio.
 */
export function voiceRowOf<R extends Pick<ConnectionModelRow, "id" | "provider" | "defaultForAgents">>(
  rows: readonly R[],
  resolvedId?: string | null,
) {
  const id = resolvedId?.trim();
  if (id) {
    const row = rows.find((row) => row.id === id && row.provider === "audio") ?? null;
    return { row, missing: !row };
  }
  const row = rows.find((row) => row.provider === "audio" && isConnectionFlagTrue(row.defaultForAgents)) ?? null;
  return { row, missing: false };
}
