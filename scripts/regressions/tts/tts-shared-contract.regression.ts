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
} from "../../../packages/shared/src/constants/tts-sources.js";
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

  const card = readSource("packages/client/src/components/panels/settings/TTSConfigCard.tsx");
  const picker = /const usesModelPicker = ([^\n]*);/u.exec(card)?.[1] ?? "";
  assert.match(picker, /TTS_SOURCES_WITH_MODEL_LISTING/u, "the card must pick its dropdown sources from the same list");
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
// A source definition describes a backend, never its outbound URL policy.
// ttsUrlPolicy() takes no source, so a policy field here would have to be read
// somewhere new to have any effect, and the effect would be a per-source
// exemption from TTS_LOCAL_URLS_ENABLED=false. This fails if one appears.
for (const id of TTS_SOURCE_IDS) {
  assert.deepEqual(
    Object.keys(TTS_SOURCE_DEFINITIONS[id]).sort(),
    ["defaultBaseUrl", "defaultModel", "defaultVoice", "id", "maxInputChars", "name", "recommendedChunkChars"],
    `${id}: definition shape must stay free of URL-policy fields`,
  );
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

// The card's restore path is not compile-checked the way its payload builder is:
// dropping a setter here leaves the UI showing another source's tuning.
const cardSource = readSource("packages/client/src/components/panels/settings/TTSConfigCard.tsx");
for (const [setter, field] of [
  ["setTimeoutMs", "timeoutMs"],
  ["setChunkCharLimit", "chunkCharLimit"],
  ["setMaxRetries", "maxRetries"],
  ["setGenerationConcurrency", "generationConcurrency"],
] as const) {
  assert.match(
    cardSource,
    new RegExp(String.raw`${setter}\(nextProfile\.${field}\)`, "u"),
    `switching source must restore ${field} into the card`,
  );
}

// ── The collapsed copies stay collapsed ──
const routeSource = readSource("packages/server/src/routes/tts.routes.ts");
assert.doesNotMatch(routeSource, /const TTS_SOURCE_DEFAULTS/u, "the server must not re-declare the defaults table");
assert.doesNotMatch(routeSource, /const TTS_SOURCES\b/u, "the server must not re-declare the source list");
assert.match(routeSource, /TTS_SOURCE_DEFINITIONS/u, "the server reads the shared definitions");

const editorSource = readSource("packages/client/src/components/connections/ConnectionEditor.tsx");
assert.match(editorSource, /TTS_SOURCE_DEFINITIONS/u, "the connection editor reads the shared definitions");
for (const [file, source] of [
  ["ConnectionEditor.tsx", editorSource],
  ["TTSConfigCard.tsx", cardSource],
] as const) {
  // The pockettts trio is TTS-specific, so unlike the OpenAI URL it cannot
  // legitimately appear in a client component for another reason.
  assert.doesNotMatch(source, /"http:\/\/localhost:8000"/u, `${file} must not re-inline the PocketTTS base URL`);
  assert.doesNotMatch(source, /"pocket-tts"/u, `${file} must not re-inline the PocketTTS model`);
  assert.doesNotMatch(source, /"alba"/u, `${file} must not re-inline the PocketTTS voice`);
}

console.info("TTS shared contract regression passed.");
