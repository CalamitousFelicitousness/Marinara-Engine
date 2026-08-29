// ──────────────────────────────────────────────
// Audio Parameter Catalog
// ──────────────────────────────────────────────
// Known extra parameters for the backends this app can name, so the connection
// editor renders a slider instead of asking for a JSON key nobody remembers.
//
// Presentation only. Nothing here decides what is sent: a stored parameter
// reaches the provider whether or not the catalog knows it, and a catalog entry
// with no stored value sends nothing. Supporting another engine is one set here
// plus its help strings, with no server change.
//
// Sets are offered, never inferred. Several Chatterbox servers exist with
// different surfaces, and an OpenAI-compatible base URL says nothing about what
// answers it, so which set applies is the user's statement rather than a guess.
//
// Every entry below is taken from its vendor's published request schema. A
// range that is wrong here is worse than a missing entry: the editor would clamp
// a value the backend would have accepted.

import { type AudioPurpose } from "./audio-purposes.js";
import { type TTSSourceId } from "./tts-sources.js";

/** How the editor renders a value, and what the JSON view must round-trip to. */
export type AudioParameterKind = "number" | "string" | "boolean" | "enum";

export interface AudioParameterDefinition {
  /**
   * Wire key exactly as the backend expects it, dotted for a nested path such
   * as voice_settings.style. Stored nested; the dots are a catalog spelling.
   */
  key: string;
  kind: AudioParameterKind;
  min?: number;
  max?: number;
  step?: number;
  /** enum only. The first entry is not special; absent still means unset. */
  options?: readonly string[];
  /**
   * What the backend does when the key is absent. Shown as the control's
   * placeholder and never stored, so clearing a row restores the backend's own
   * behaviour rather than pinning a value that merely looks like the default.
   */
  placeholder?: string | number | boolean;
  helpKey: string;
}

export interface AudioParameterSet {
  id: string;
  /** Product noun, unlocalized, as with TTSSourceDefinition.name. */
  name: string;
  /** Sources whose editor offers this set. */
  sources: readonly TTSSourceId[];
  /** Lanes it applies to. A speech set never appears while editing music. */
  purposes: readonly AudioPurpose[];
  parameters: readonly AudioParameterDefinition[];
}

/** Chatterbox multilingual accepts these and rejects anything else. */
const CHATTERBOX_LANGUAGE_IDS = [
  "ar",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fr",
  "he",
  "hi",
  "it",
  "ja",
  "ko",
  "ms",
  "nl",
  "no",
  "pl",
  "pt",
  "ru",
  "sv",
  "sw",
  "tr",
  "zh",
] as const;

export const AUDIO_PARAMETER_SETS: readonly AudioParameterSet[] = [
  {
    id: "chatterbox",
    name: "Chatterbox",
    // Reached through the OpenAI-compatible lane, which is how every local
    // engine without a source of its own is reached.
    sources: ["openai"],
    purposes: ["speech"],
    parameters: [
      {
        key: "exaggeration",
        kind: "number",
        min: 0.25,
        max: 2,
        step: 0.05,
        placeholder: 0.5,
        helpKey: "ui.connections.audioparametereditor.exaggerationHelp",
      },
      {
        key: "cfg_weight",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.05,
        placeholder: 0.5,
        helpKey: "ui.connections.audioparametereditor.cfgWeightHelp",
      },
      {
        key: "temperature",
        kind: "number",
        min: 0.05,
        max: 5,
        step: 0.05,
        placeholder: 0.8,
        helpKey: "ui.connections.audioparametereditor.temperatureHelp",
      },
      {
        key: "language_id",
        kind: "enum",
        options: CHATTERBOX_LANGUAGE_IDS,
        placeholder: "en",
        helpKey: "ui.connections.audioparametereditor.languageIdHelp",
      },
    ],
  },
  {
    id: "elevenlabs-voice",
    name: "ElevenLabs voice settings",
    sources: ["elevenlabs"],
    purposes: ["speech"],
    parameters: [
      {
        key: "voice_settings.similarity_boost",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.05,
        helpKey: "ui.connections.audioparametereditor.similarityBoostHelp",
      },
      {
        key: "voice_settings.style",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.05,
        placeholder: 0,
        helpKey: "ui.connections.audioparametereditor.styleHelp",
      },
      {
        key: "voice_settings.use_speaker_boost",
        kind: "boolean",
        placeholder: true,
        helpKey: "ui.connections.audioparametereditor.useSpeakerBoostHelp",
      },
    ],
  },
  {
    // NanoGPT picks the lane by model rather than by route, so the model is the
    // one parameter without which nothing can be generated. Ids are vendor data
    // that changes without us: GET /api/v1/audio-models lists what a key
    // reaches, and its per-model supported_parameters carry the real duration
    // bounds, which differ per model and are not what the maxima below assume.
    id: "nanogpt-music",
    name: "NanoGPT music",
    sources: ["nanogpt"],
    purposes: ["music"],
    parameters: [
      {
        key: "model",
        kind: "string",
        placeholder: "ACE-Step-v1.5-Base",
        helpKey: "ui.connections.audioparametereditor.nanoGptMusicModelHelp",
      },
      {
        key: "duration",
        kind: "number",
        min: 1,
        max: 300,
        step: 1,
        helpKey: "ui.connections.audioparametereditor.nanoGptDurationHelp",
      },
    ],
  },
  {
    id: "nanogpt-sfx",
    name: "NanoGPT sound effects",
    sources: ["nanogpt"],
    purposes: ["sfx"],
    parameters: [
      {
        key: "model",
        kind: "string",
        placeholder: "mirelo-ai/sfx1.6/text-to-audio",
        helpKey: "ui.connections.audioparametereditor.nanoGptSfxModelHelp",
      },
      {
        key: "duration",
        kind: "number",
        min: 1,
        max: 60,
        step: 1,
        helpKey: "ui.connections.audioparametereditor.nanoGptDurationHelp",
      },
    ],
  },
  {
    id: "elevenlabs-sfx",
    name: "ElevenLabs sound effects",
    sources: ["elevenlabs"],
    purposes: ["sfx"],
    parameters: [
      {
        key: "prompt_influence",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.05,
        placeholder: 0.3,
        helpKey: "ui.connections.audioparametereditor.promptInfluenceHelp",
      },
      {
        key: "duration_seconds",
        kind: "number",
        min: 0.5,
        max: 30,
        step: 0.5,
        helpKey: "ui.connections.audioparametereditor.durationSecondsHelp",
      },
    ],
  },
  {
    id: "elevenlabs-music",
    name: "ElevenLabs music",
    sources: ["elevenlabs"],
    purposes: ["music"],
    parameters: [
      {
        key: "force_instrumental",
        kind: "boolean",
        placeholder: true,
        helpKey: "ui.connections.audioparametereditor.forceInstrumentalHelp",
      },
      {
        key: "music_length_ms",
        kind: "number",
        min: 3_000,
        max: 600_000,
        step: 1_000,
        helpKey: "ui.connections.audioparametereditor.musicLengthMsHelp",
      },
    ],
  },
];

/** Sets the editor offers for one source and lane, in catalog order. */
export function audioParameterSetsFor(source: TTSSourceId, purpose: AudioPurpose): AudioParameterSet[] {
  return AUDIO_PARAMETER_SETS.filter((set) => set.sources.includes(source) && set.purposes.includes(purpose));
}

/**
 * The definition for a stored key, or undefined when the catalog does not know
 * it. Undefined is the ordinary case for a backend nobody has described here,
 * and the editor renders a free text row rather than hiding the value.
 */
export function audioParameterDefinition(
  source: TTSSourceId,
  purpose: AudioPurpose,
  key: string,
): AudioParameterDefinition | undefined {
  for (const set of audioParameterSetsFor(source, purpose)) {
    const definition = set.parameters.find((parameter) => parameter.key === key);
    if (definition) return definition;
  }
  return undefined;
}
