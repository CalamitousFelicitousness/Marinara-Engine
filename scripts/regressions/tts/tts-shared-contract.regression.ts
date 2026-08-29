// The TTS source list and the synthesis tuning fields have one definition each,
// and everything else derives from them.
//
// Both are the kind of list that grows a second copy easily: the source ids
// reach two shared enums, the shared definition table, the route, and the
// client card, while the tuning field list reaches a Zod pick, a projection,
// and the card's profile defaults. A copy that falls behind still compiles.
// The symptom is silent: a source whose saved tuning vanishes on a switch, or
// one the schema refuses to persist a profile for.
//
// These assertions pin the derivations, so a copy has to fail loudly to exist.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIO_PARAMETERS_MAX_BYTES,
  TTS_CHUNK_CHARS_DEFAULT,
  TTS_CHUNK_CHARS_MAX,
  TTS_CHUNK_CHARS_MIN,
  TTS_CONCURRENCY_DEFAULT,
  TTS_CONCURRENCY_MAX,
  TTS_MAX_RETRIES_DEFAULT,
  TTS_MAX_RETRIES_MAX,
  TTS_TIMEOUT_MS_DEFAULT,
  TTS_TIMEOUT_MS_MAX,
  TTS_TIMEOUT_MS_MIN,
  ttsConfigSchema,
  ttsSourceProfileFromConfig,
  ttsSourceProfileSchema,
  ttsSourceSchema,
} from "../../../packages/shared/src/types/tts.js";
import {
  TTS_SOURCE_DEFINITIONS,
  TTS_SOURCE_IDS,
  TTS_SOURCES_WITH_MODEL_LISTING,
  ttsSourceSupportsGameAudio,
} from "../../../packages/shared/src/constants/tts-sources.js";
import { AUDIO_PURPOSES, GAME_AUDIO_PURPOSES } from "../../../packages/shared/src/constants/audio-purposes.js";
import {
  AUDIO_PARAMETER_SETS,
  audioParameterDefinition,
  audioParameterSetsFor,
} from "../../../packages/shared/src/constants/audio-parameters.js";
import {
  audioParameterPaths,
  audioParametersFor,
  readParameterPath,
  writeParameterPath,
} from "../../../packages/shared/src/utils/audio-parameters.js";
import {
  AUDIO_CONNECTION_IDENTITY_FIELDS,
  applyAudioConnectionSettings,
  audioConnectionSettingsSchema,
  audioSettingsFromProfile,
  parseAudioConnectionSettings,
} from "../../../packages/shared/src/types/audio-connection-settings.js";
import { AUDIO_GENERATION_SOURCES } from "../../../packages/shared/src/types/connection.js";
import { audioGenerationSourceSchema } from "../../../packages/shared/src/schemas/connection.schema.js";
import { prepareTTSConfigForStorage } from "../../../packages/server/src/routes/tts.routes.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const readSource = (relative: string) => readFileSync(join(repositoryRoot, relative), "utf8");

// ── One source list, four spellings of it ──
assert.deepEqual([...ttsSourceSchema.options], [...TTS_SOURCE_IDS], "ttsSourceSchema must derive from TTS_SOURCE_IDS");
assert.deepEqual(
  [...audioGenerationSourceSchema.options],
  [...TTS_SOURCE_IDS],
  "audioGenerationSourceSchema must derive from TTS_SOURCE_IDS",
);
assert.deepEqual([...AUDIO_GENERATION_SOURCES], [...TTS_SOURCE_IDS], "AUDIO_GENERATION_SOURCES must be the same list");
assert.deepEqual(
  Object.keys(TTS_SOURCE_DEFINITIONS).sort(),
  [...TTS_SOURCE_IDS].sort(),
  "every source id needs a definition and vice versa",
);

// The model dropdown and the models query must agree on which sources have a
// listing. They are in different files, and a source in the card but not the
// query renders a dropdown whose fetch never fires: it sits on its fallback
// entries forever, looking like the account has no models. Neither side may
// spell a source id itself.
{
  for (const id of TTS_SOURCES_WITH_MODEL_LISTING) {
    assert.ok(TTS_SOURCE_IDS.includes(id), `${id}: listed for model fetching but not a source`);
  }

  const hook = readSource("packages/client/src/hooks/use-tts.ts");
  // Scoped to useTTSModels: useTTSVoices has its own `enabled:` line, and an
  // unscoped match reads that one instead and passes for the wrong reason.
  const modelsHook = hook.slice(hook.indexOf("export function useTTSModels"));
  assert.ok(modelsHook.startsWith("export function useTTSModels"), "useTTSModels must still exist to be pinned");
  const gate = /enabled:\s*enabled\s*&&\s*([^\n]*?),\s*$/mu.exec(modelsHook)?.[1] ?? "";
  assert.match(gate, /TTS_SOURCES_WITH_MODEL_LISTING/u, "the models query must gate on the shared list");
  for (const id of TTS_SOURCE_IDS) {
    assert.doesNotMatch(gate, new RegExp(`["']${id}["']`, "u"), `the models query gate must not name ${id} directly`);
  }

  const fields = readSource("packages/client/src/components/connections/audio/AudioSourceFields.tsx");
  const picker = /const usesModelPicker = ([^\n]*);/u.exec(fields)?.[1] ?? "";
  assert.match(
    picker,
    /TTS_SOURCES_WITH_MODEL_LISTING/u,
    "the editor must pick its dropdown sources from the same list",
  );
}

// sourceProfiles is keyed off the same list. A missing key is not a type error
// at the write site: Zod strips the unknown key, so the profile silently fails
// to persist and the source loses its settings on every switch away and back.
for (const id of TTS_SOURCE_IDS) {
  const stored = ttsConfigSchema.parse({ sourceProfiles: { [id]: { voice: "probe-voice" } } });
  assert.equal(stored.sourceProfiles[id]?.voice, "probe-voice", `${id}: needs a slot in sourceProfiles`);
}

for (const id of TTS_SOURCE_IDS) {
  const definition = TTS_SOURCE_DEFINITIONS[id];
  assert.equal(definition.id, id, `${id}: definition is keyed by its own id`);
  assert.ok(definition.name.length > 0, `${id}: has a display name`);
  assert.match(definition.defaultBaseUrl, /^https?:\/\//u, `${id}: default base URL is a URL`);
  assert.ok(definition.defaultModel.length > 0, `${id}: has a default model`);
  // ElevenLabs voice ids are account-scoped, so an empty default is legitimate there and only there.
  if (id !== "elevenlabs") assert.ok(definition.defaultVoice.length > 0, `${id}: has a default voice`);
  assert.ok(
    definition.recommendedChunkChars <= definition.maxInputChars,
    `${id}: recommended chunk must fit the source's input ceiling`,
  );
  assert.ok(definition.maxInputChars <= TTS_CHUNK_CHARS_MAX, `${id}: input ceiling cannot exceed what /speak accepts`);
}
// A source definition describes a backend and how to present it, never its
// outbound URL policy. ttsUrlPolicy() takes no source, so a policy field here
// would have to be read somewhere new to have any effect, and the effect would
// be a per-source exemption from TTS_LOCAL_URLS_ENABLED=false. This fails if one
// appears.
for (const id of TTS_SOURCE_IDS) {
  assert.deepEqual(
    Object.keys(TTS_SOURCE_DEFINITIONS[id]).sort(),
    [
      "baseUrlMode",
      "defaultBaseUrl",
      "defaultModel",
      "defaultVoice",
      "id",
      "maxInputChars",
      "name",
      "recommendedChunkChars",
      "supportsGameMusic",
      "supportsGameSoundEffects",
    ],
    `${id}: definition shape must stay free of URL-policy fields`,
  );
  assert.ok(
    ["fixed", "editable"].includes(TTS_SOURCE_DEFINITIONS[id].baseUrlMode),
    `${id}: baseUrlMode must name a presentation mode`,
  );
  assert.equal(
    typeof TTS_SOURCE_DEFINITIONS[id].supportsGameSoundEffects,
    "boolean",
    `${id}: game sound effect capability must be stated, not inferred`,
  );
  assert.equal(
    typeof TTS_SOURCE_DEFINITIONS[id].supportsGameMusic,
    "boolean",
    `${id}: game music capability must be stated, not inferred`,
  );
  assert.equal(
    ttsSourceSupportsGameAudio(id, "sfx"),
    TTS_SOURCE_DEFINITIONS[id].supportsGameSoundEffects,
    `${id}: the sfx helper must read the table`,
  );
  assert.equal(
    ttsSourceSupportsGameAudio(id, "music"),
    TTS_SOURCE_DEFINITIONS[id].supportsGameMusic,
    `${id}: the music helper must read the table`,
  );
}
// The one backend with a generator. A source flagged capable without one turns
// the route's dispatch guard into the real gate, which is the arrangement the
// table exists to replace.
assert.equal(TTS_SOURCE_DEFINITIONS.elevenlabs.supportsGameSoundEffects, true, "ElevenLabs generates sound effects");
assert.equal(TTS_SOURCE_DEFINITIONS.elevenlabs.supportsGameMusic, true, "ElevenLabs composes music");
// ElevenLabs being the only capable source makes a helper hardcoded to it agree
// with the table on every current row. Flipping a second source proves the
// helper is reading the table rather than naming a backend.
{
  const restore = TTS_SOURCE_DEFINITIONS.openai.supportsGameMusic;
  TTS_SOURCE_DEFINITIONS.openai.supportsGameMusic = true;
  assert.equal(
    ttsSourceSupportsGameAudio("openai", "music"),
    true,
    "capability must follow the table, not a source id",
  );
  assert.equal(ttsSourceSupportsGameAudio("openai", "sfx"), false, "each purpose must read its own column");
  TTS_SOURCE_DEFINITIONS.openai.supportsGameMusic = restore;
}
// baseUrlMode decides whether the editor offers an address field. If the policy
// layer ever reads it, "fixed" silently acquires a second meaning of "exempt",
// which is exactly the field the shape guard above exists to keep out.
{
  const urlPolicy = readSource("packages/server/src/services/tts/url-policy.ts");
  assert.match(urlPolicy, /export function ttsUrlPolicy\(\)/u, "the TTS URL policy must stay source-blind");
  assert.doesNotMatch(urlPolicy, /baseUrlMode/u, "outbound URL policy must not read a presentation field");
}

// The client clamps chunk size against TTS_CHUNK_CHARS_MAX; the server rejects
// anything larger. Drifting apart turns a legal setting into a 400.
assert.match(
  readSource("packages/server/src/routes/tts.routes.ts"),
  new RegExp(String.raw`text:\s*z\s*\.string\(\)\s*\.min\(1\)\s*\.max\(${TTS_CHUNK_CHARS_MAX}\)`, "u"),
  `speakSchema's text cap must equal TTS_CHUNK_CHARS_MAX (${TTS_CHUNK_CHARS_MAX})`,
);

// ── Tuning defaults reproduce today's behavior ──
const fresh = ttsConfigSchema.parse({});
assert.equal(fresh.timeoutMs, TTS_TIMEOUT_MS_DEFAULT, "default timeout matches the previously hardcoded 60s");
assert.equal(fresh.timeoutMs, 60_000, "the 60s default is the value /speak used as a literal");
assert.equal(fresh.chunkCharLimit, TTS_CHUNK_CHARS_DEFAULT, "default chunk size matches the previous constant");
assert.equal(fresh.chunkCharLimit, 900, "900 is the chunk size the client always used");
assert.equal(fresh.maxRetries, TTS_MAX_RETRIES_DEFAULT, "one retry by default");
assert.equal(fresh.generationConcurrency, TTS_CONCURRENCY_DEFAULT, "serial generation by default");
assert.equal(fresh.generationConcurrency, 1, "single-worker local engines must not be hit in parallel by default");
assert.equal(fresh.progressivePlayback, true, "a fresh install plays each chunk as it lands");

for (const [field, bad] of [
  ["timeoutMs", TTS_TIMEOUT_MS_MIN - 1],
  ["timeoutMs", TTS_TIMEOUT_MS_MAX + 1],
  ["timeoutMs", 60_000.5],
  ["chunkCharLimit", TTS_CHUNK_CHARS_MIN - 1],
  ["chunkCharLimit", TTS_CHUNK_CHARS_MAX + 1],
  ["maxRetries", -1],
  ["maxRetries", TTS_MAX_RETRIES_MAX + 1],
  ["generationConcurrency", 0],
  ["generationConcurrency", TTS_CONCURRENCY_MAX + 1],
] as const) {
  assert.throws(() => ttsConfigSchema.parse({ [field]: bad }), `${field} must reject ${bad}`);
}

// ── A saved config is not rewritten by the upgrade ──
// Everything a user configured before the tuning fields existed must survive,
// including progressivePlayback: false, which only fresh installs flip.
const preUpgradeBlob = {
  enabled: true,
  source: "pockettts",
  baseUrl: "http://localhost:8000",
  apiKey: "encrypted:secret",
  voice: "alba",
  model: "pocket-tts",
  speed: 1.25,
  progressivePlayback: false,
  dialogueOnly: true,
  dialoguePauseMs: 3000,
  autoplayRP: true,
  audioFormat: "wav",
  sourceProfiles: {},
};
const upgraded = ttsConfigSchema.parse(JSON.parse(JSON.stringify(preUpgradeBlob)));
assert.equal(upgraded.progressivePlayback, false, "a saved false must not be flipped by the new default");
assert.equal(upgraded.enabled, true, "saved values survive");
assert.equal(upgraded.speed, 1.25, "saved speed survives");
assert.equal(upgraded.dialogueOnly, true, "saved dialogueOnly survives");
assert.equal(upgraded.dialoguePauseMs, 3000, "saved pause survives");
assert.equal(upgraded.audioFormat, "wav", "saved format survives");
assert.equal(upgraded.timeoutMs, TTS_TIMEOUT_MS_DEFAULT, "absent tuning fields take defaults");
assert.equal(upgraded.chunkCharLimit, TTS_CHUNK_CHARS_DEFAULT, "absent tuning fields take defaults");

// ── The per-source profile carries the tuning ──
// Tuning is per source because a local CPU engine and a cloud API want opposite
// values, and switching sources must not carry one's timeout onto the other.
const profileShape = Object.keys(ttsSourceProfileSchema.shape).sort();
for (const field of ["timeoutMs", "chunkCharLimit", "maxRetries", "generationConcurrency"]) {
  assert.ok(profileShape.includes(field), `${field} must be saved per source`);
}
const tuned = ttsConfigSchema.parse({
  source: "pockettts",
  timeoutMs: 300_000,
  chunkCharLimit: 300,
  maxRetries: 2,
  generationConcurrency: 1,
});
const projected = ttsSourceProfileFromConfig(tuned);
assert.deepEqual(
  Object.keys(projected).sort(),
  profileShape,
  "the projection must yield exactly the schema's fields, not a hand-listed subset",
);
assert.equal(projected.timeoutMs, 300_000, "tuning reaches the saved profile");
assert.equal(projected.chunkCharLimit, 300, "tuning reaches the saved profile");
assert.equal(projected.maxRetries, 2, "tuning reaches the saved profile");

// A source switch stores the outgoing profile and must not lose its tuning.
const stored = prepareTTSConfigForStorage(
  { ...tuned, sourceProfiles: { pockettts: projected } },
  ttsConfigSchema.parse({}),
  (value) => (value ? `encrypted:${value}` : ""),
);
assert.equal(stored.sourceProfiles.pockettts?.timeoutMs, 300_000, "a stored profile keeps its timeout");
assert.equal(stored.sourceProfiles.pockettts?.chunkCharLimit, 300, "a stored profile keeps its chunk size");
assert.equal(stored.sourceProfiles.pockettts?.maxRetries, 2, "a stored profile keeps its retry count");

// ── A connection's settings are the profile minus its identity ──
// An audio connection stores how it speaks; which engine it is lives in its own
// row columns. Deriving one list from the other means a knob added to the profile
// becomes per-connection at once, and an identity field never gains a second home
// that could outvote the row.
{
  const profileFields = Object.keys(ttsSourceProfileSchema.shape);
  const settingsFields = Object.keys(audioConnectionSettingsSchema.shape);
  const identityFields = AUDIO_CONNECTION_IDENTITY_FIELDS as readonly string[];
  assert.deepEqual(
    [...settingsFields].sort(),
    profileFields.filter((field) => !identityFields.includes(field)).sort(),
    "connection settings must be the source profile minus its identity fields",
  );
  for (const field of identityFields) {
    assert.ok(profileFields.includes(field), `${field}: omitted from the profile but absent from it`);
    assert.ok(!settingsFields.includes(field), `${field}: identity belongs to the row, not the settings blob`);
  }

  // Absent means inherit. A default anywhere here would answer in place of the
  // app-level value, and a connection nobody tuned would stop following it.
  assert.deepEqual(audioConnectionSettingsSchema.parse({}), {}, "no settings field may carry a default");

  // Bounds ride the derivation instead of being restated beside it.
  assert.throws(
    () => audioConnectionSettingsSchema.parse({ timeoutMs: TTS_TIMEOUT_MS_MAX + 1 }),
    "the profile's bounds must carry over",
  );
  assert.throws(
    () => audioConnectionSettingsSchema.parse({ generationConcurrency: 0 }),
    "the profile's bounds must carry over",
  );

  const merged = applyAudioConnectionSettings(
    ttsConfigSchema.parse({}),
    audioConnectionSettingsSchema.parse({ speed: 1.75, timeoutMs: 300_000 }),
  );
  assert.equal(merged.speed, 1.75, "a stored field overrides the app-level value");
  assert.equal(merged.timeoutMs, 300_000, "a stored field overrides the app-level value");
  assert.equal(merged.chunkCharLimit, TTS_CHUNK_CHARS_DEFAULT, "an absent field inherits");
  assert.equal(
    applyAudioConnectionSettings(ttsConfigSchema.parse({ speed: 1.25 }), {}).speed,
    1.25,
    "an unconfigured connection changes nothing",
  );

  // The column is text on disk. Hand edits, and bounds tightened later, must not
  // cost a connection every other setting it holds.
  assert.deepEqual(parseAudioConnectionSettings(null), {}, "an unset column inherits everything");
  assert.deepEqual(parseAudioConnectionSettings("not json"), {}, "unreadable text inherits everything");
  assert.deepEqual(
    parseAudioConnectionSettings(JSON.stringify({ speed: 1.5, maxRetries: 99 })),
    { speed: 1.5 },
    "one out-of-range field drops on its own",
  );

  const seeded = audioSettingsFromProfile(ttsSourceProfileFromConfig(ttsConfigSchema.parse({ speed: 1.5 })));
  assert.deepEqual([...Object.keys(seeded)].sort(), [...settingsFields].sort(), "seeding snapshots every knob");
  assert.equal(seeded.speed, 1.5, "seeding carries the profile's values");
}

// The playback card still PUTs the whole config even though it only edits part
// of it. ttsConfigSchema fills absent fields with defaults, and the storage
// layer reads a blank apiKey as an explicit clear, so a payload assembled from
// playback state alone would wipe the stored key and every saved source profile
// the moment somebody toggled autoplay. Nothing about that failure is loud.
const cardSource = readSource("packages/client/src/components/panels/settings/TTSConfigCard.tsx");
assert.match(
  cardSource,
  /const buildPayload[\s\S]{0,200}?\.\.\.ttsConfigSchema\.parse\(savedConfig \?\? \{\}\),/u,
  "the card's payload must start from what the server last returned",
);
assert.doesNotMatch(cardSource, /sourceProfilesRef/u, "per-source profiles are not the playback card's job");
// The sentinel forced the app-level blob so the old preview tested what the card
// edited. The card no longer edits an engine, so its test has to reach the one
// autoplay would.
assert.doesNotMatch(cardSource, /audioConnectionId: ""/u, "playback test must not pin itself to the app-level blob");

// ── The collapsed copies stay collapsed ──
const routeSource = readSource("packages/server/src/routes/tts.routes.ts");
assert.doesNotMatch(routeSource, /const TTS_SOURCE_DEFAULTS/u, "the server must not re-declare the defaults table");
assert.doesNotMatch(routeSource, /const TTS_SOURCES\b/u, "the server must not re-declare the source list");
assert.match(routeSource, /TTS_SOURCE_DEFINITIONS/u, "the server reads the shared definitions");

// ── Game audio asks the table which sources may generate ──
// The gate and the generator are different questions. Answering both with one
// source literal is what made "capable" and "implemented" the same fact, so the
// gate must read the table even while ElevenLabs is the only generator.
assert.equal(GAME_AUDIO_PURPOSES.length, 2, "game audio serves exactly the sfx and music purposes");
assert.match(
  routeSource,
  /kind: z\.enum\(GAME_AUDIO_PURPOSES\)/u,
  "the game-audio request kind must be the shared purpose list",
);
{
  const gateStart = routeSource.indexOf('app.post("/game-audio"');
  const gateEnd = routeSource.indexOf('app.post("/speak"');
  assert.ok(gateStart > 0 && gateEnd > gateStart, "the game-audio route must precede /speak in the file");
  const gameAudioRoute = routeSource.slice(gateStart, gateEnd);
  assert.doesNotMatch(
    gameAudioRoute,
    /cfg\.source !== "elevenlabs" \|\|/u,
    "capability must not be spelled as a source literal in the gate",
  );
  assert.match(
    gameAudioRoute,
    /ttsSourceSupportsGameAudio|gameAudioEnabled/u,
    "the gate must read the shared capability answer",
  );
}

const editorSource = readSource("packages/client/src/components/connections/ConnectionEditor.tsx");
const audioFieldsSource = readSource("packages/client/src/components/connections/audio/AudioSourceFields.tsx");
assert.match(audioFieldsSource, /TTS_SOURCE_DEFINITIONS/u, "the audio source fields read the shared definitions");
for (const [file, source] of [
  ["ConnectionEditor.tsx", editorSource],
  ["TTSConfigCard.tsx", cardSource],
  ["AudioSourceFields.tsx", audioFieldsSource],
  [
    "AudioSynthesisDefaults.tsx",
    readSource("packages/client/src/components/connections/audio/AudioSynthesisDefaults.tsx"),
  ],
  ["AudioVoiceCasting.tsx", readSource("packages/client/src/components/connections/audio/AudioVoiceCasting.tsx")],
] as const) {
  // The pockettts trio is TTS-specific, so unlike the OpenAI URL it cannot
  // legitimately appear in a client component for another reason.
  assert.doesNotMatch(source, /"http:\/\/localhost:8000"/u, `${file} must not re-inline the PocketTTS base URL`);
  assert.doesNotMatch(source, /"pocket-tts"/u, `${file} must not re-inline the PocketTTS model`);
  assert.doesNotMatch(source, /"alba"/u, `${file} must not re-inline the PocketTTS voice`);
}

// ── Extra provider parameters are a knob like any other ──
// They ride the same derivation as the tuning fields, so they are per source,
// per connection, and inheritable without any of those three being restated.
{
  const profileFields = Object.keys(ttsSourceProfileSchema.shape);
  assert.ok(profileFields.includes("audioParameters"), "parameters must be saved per source");
  assert.ok(
    Object.keys(audioConnectionSettingsSchema.shape).includes("audioParameters"),
    "parameters must be settable per connection",
  );

  const parameterized = ttsConfigSchema.parse({
    source: "openai",
    audioParameters: { speech: { exaggeration: 0.7 }, music: { force_instrumental: false } },
  });
  assert.deepEqual(
    ttsSourceProfileFromConfig(parameterized).audioParameters,
    { speech: { exaggeration: 0.7 }, music: { force_instrumental: false } },
    "parameters reach the saved profile so a source switch keeps them",
  );

  // A connection owns its lanes outright. Merging them with the app-level map
  // would make a parameter unremovable: clearing the row would re-expose the
  // inherited value rather than restoring the backend's own default.
  const overlaid = applyAudioConnectionSettings(parameterized, { audioParameters: { speech: { cfg_weight: 0.2 } } });
  assert.deepEqual(
    overlaid.audioParameters,
    { speech: { cfg_weight: 0.2 } },
    "a connection's parameter map replaces the app-level one rather than merging into it",
  );

  assert.deepEqual(audioParametersFor(parameterized, "speech"), { exaggeration: 0.7 }, "the selector reads its lane");
  assert.deepEqual(audioParametersFor(parameterized, "sfx"), {}, "an unset lane sends nothing");
  assert.deepEqual(
    audioParametersFor(ttsConfigSchema.parse({}), "speech"),
    {},
    "a config nobody parameterized sends nothing",
  );

  // Every request carries these, so one oversized blob would tax all of them.
  const withinCap = "x".repeat(AUDIO_PARAMETERS_MAX_BYTES - 20);
  assert.doesNotThrow(
    () => ttsConfigSchema.parse({ audioParameters: { speech: { note: withinCap } } }),
    "a record inside the cap is accepted",
  );
  assert.throws(
    () => ttsConfigSchema.parse({ audioParameters: { speech: { note: "x".repeat(AUDIO_PARAMETERS_MAX_BYTES) } } }),
    "a record over the cap is rejected",
  );
}

// ── Dotted paths reach nested keys without flattening their siblings ──
{
  const nested = writeParameterPath({ voice_settings: { stability: 0.5 } }, "voice_settings.style", 0.3);
  assert.deepEqual(
    nested,
    { voice_settings: { stability: 0.5, style: 0.3 } },
    "writing one nested key must leave the others alone",
  );
  assert.equal(readParameterPath(nested, "voice_settings.style"), 0.3, "a dotted path reads back");
  assert.equal(readParameterPath(nested, "voice_settings.missing"), undefined, "an absent leaf reads undefined");
  assert.equal(readParameterPath({ flat: 1 }, "flat.deeper"), undefined, "a scalar parent reads undefined");

  // Clearing prunes, or an emptied voice_settings would still be sent.
  assert.deepEqual(
    writeParameterPath(
      writeParameterPath(nested, "voice_settings.style", undefined),
      "voice_settings.stability",
      undefined,
    ),
    {},
    "clearing the last nested key removes the parent",
  );
  assert.deepEqual(
    audioParameterPaths({ exaggeration: 0.7, voice_settings: { style: 0.3 } }).sort(),
    ["exaggeration", "voice_settings.style"],
    "stored keys enumerate as dotted paths so an unknown one stays visible",
  );
}

// ── The catalog describes engines; it never decides what is sent ──
{
  const sourceIds = new Set<string>(TTS_SOURCE_IDS);
  const purposes = new Set<string>(AUDIO_PURPOSES);
  const setIds = new Set<string>();
  for (const set of AUDIO_PARAMETER_SETS) {
    assert.ok(!setIds.has(set.id), `${set.id}: duplicate set id`);
    setIds.add(set.id);
    assert.ok(set.sources.length > 0, `${set.id}: a set nobody can reach is dead weight`);
    assert.ok(set.purposes.length > 0, `${set.id}: a set with no lane can never be offered`);
    for (const source of set.sources) assert.ok(sourceIds.has(source), `${set.id}: unknown source ${source}`);
    for (const purpose of set.purposes) assert.ok(purposes.has(purpose), `${set.id}: unknown purpose ${purpose}`);

    const keys = new Set<string>();
    for (const parameter of set.parameters) {
      assert.ok(!keys.has(parameter.key), `${set.id}: duplicate key ${parameter.key}`);
      keys.add(parameter.key);
      if (parameter.min !== undefined && parameter.max !== undefined) {
        assert.ok(parameter.min <= parameter.max, `${parameter.key}: min above max would clamp every value`);
      }
      if (parameter.kind === "enum") {
        assert.ok(parameter.options && parameter.options.length > 0, `${parameter.key}: an enum needs options`);
      }
      // A placeholder is the backend's own default, so an out-of-range one
      // would advertise a value the control cannot express.
      if (typeof parameter.placeholder === "number") {
        if (parameter.min !== undefined) assert.ok(parameter.placeholder >= parameter.min, `${parameter.key}: low`);
        if (parameter.max !== undefined) assert.ok(parameter.placeholder <= parameter.max, `${parameter.key}: high`);
      }
      if (parameter.kind === "enum" && typeof parameter.placeholder === "string") {
        assert.ok(parameter.options?.includes(parameter.placeholder), `${parameter.key}: placeholder not an option`);
      }
    }
  }

  // Scoping is what stops a music knob being offered while editing speech.
  const speechSets = audioParameterSetsFor("openai", "speech").map((set) => set.id);
  assert.ok(speechSets.includes("chatterbox"), "the OpenAI-compatible lane offers Chatterbox");
  assert.deepEqual(audioParameterSetsFor("openai", "music"), [], "no music set exists for an OpenAI-compatible row");
  assert.deepEqual(
    audioParameterSetsFor("elevenlabs", "speech").map((set) => set.id),
    ["elevenlabs-voice"],
    "ElevenLabs speech offers only its voice settings",
  );

  assert.equal(
    audioParameterDefinition("openai", "speech", "exaggeration")?.kind,
    "number",
    "a known key resolves to its definition",
  );
  assert.equal(
    audioParameterDefinition("openai", "speech", "not_a_real_key"),
    undefined,
    "an unknown key has no definition, which is how a free row is chosen",
  );
  assert.equal(
    audioParameterDefinition("elevenlabs", "speech", "exaggeration"),
    undefined,
    "definitions are scoped to the sources that accept them",
  );
}

console.info("TTS shared contract regression passed.");
