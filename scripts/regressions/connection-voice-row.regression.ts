// Voice, sound effect and music jobs. The Voice tile and badge use the audio row speech resolves to
// (`/tts/effective-config`); the sound effect and music jobs write their own lane pair on Music & Sound Effects rows
// that can serve the lane. A voice server, local or cloud, is an audio Connection, so On this device lists none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JOB, jobRowFilter, voiceRowOf } from "../../packages/client/src/lib/connection-jobs.js";

const rows = [
  { id: "flagged", provider: "audio", defaultForAgents: "true" },
  { id: "resolved", provider: "audio", defaultForAgents: "false" },
  { id: "chat", provider: "openai", defaultForAgents: true },
];

// The resolved row wins over the flag.
assert.deepEqual(voiceRowOf(rows, "resolved"), { row: rows[1], missing: false });
// A resolved id that is gone or not audio is missing.
assert.deepEqual(voiceRowOf(rows, "gone"), { row: null, missing: true });
assert.deepEqual(voiceRowOf(rows, "chat"), { row: null, missing: true });
// Without a resolved id the audio default flag answers, never a chat row's flag.
assert.deepEqual(voiceRowOf(rows, null), { row: rows[0], missing: false });
assert.deepEqual(voiceRowOf(rows, "  "), { row: rows[0], missing: false });
assert.deepEqual(voiceRowOf(rows.slice(1)), { row: null, missing: false });

// Each lane job owns its pair on Music & Sound Effects rows.
assert.equal(JOB.voice.kind, "audio");
assert.deepEqual(
  [JOB.sfx.kind, JOB.sfx.flag, JOB.sfx.fallback],
  ["audio_generation", "defaultForSfx", "fallbackForSfx"],
);
assert.deepEqual(
  [JOB.music.kind, JOB.music.flag, JOB.music.fallback],
  ["audio_generation", "defaultForMusic", "fallbackForMusic"],
);
assert.equal(JOB.sfx.add, false);
assert.equal(JOB.music.add, false);
assert.equal(jobRowFilter(JOB.voice), undefined);

// A lane lists rows switched on for it, plus a row still holding its flag so a stale pick can be cleared.
const sfxOnly = {
  id: "sfx",
  provider: "audio_generation",
  audioGenerationSource: "elevenlabs",
  audioSoundEffects: "true",
};
const stale = {
  id: "stale",
  provider: "audio_generation",
  audioGenerationSource: "elevenlabs",
  defaultForMusic: "true",
};
const sfx = jobRowFilter(JOB.sfx)!;
const music = jobRowFilter(JOB.music)!;
assert.equal(sfx(sfxOnly), true);
assert.equal(music(sfxOnly), false);
assert.equal(music(stale), true);
assert.equal(sfx(stale), false);

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
// The Voice badge reads the resolved row, not the audio flag alone.
assert.match(
  read("../../packages/client/src/components/connections/ModelRow.tsx"),
  /job\.key === "voice" \? row\.id === voiceRowId/,
);
const useTts = read("../../packages/client/src/hooks/use-tts.ts");
assert.match(
  useTts,
  /voiceRowOf\(\(rows \?\? \[\]\) as ConnectionModelRow\[\], effective\?\.resolvedConnectionId\)\.row\?\.id/,
);
assert.doesNotMatch(useTts, /useFollowVoiceJob/);

const defaults = read("../../packages/client/src/components/connections/ConnectionDefaults.tsx");
assert.match(defaults, /voiceRowOf\(connectionsList, speech\?\.resolvedConnectionId\)\.row/);
// Speech switched off is a problem on the Voice row; the playback card sits behind its gear.
assert.match(defaults, /speechOff = role\.key === "voice" && speech && !speech\.speechEnabled/);
assert.match(defaults, /voice \? \([\s\S]*?<TTSConfigCard defaultExpanded \/>/);
assert.doesNotMatch(defaults, /makesEffects|tts\?\.connectionId/);

// Set up means a speaking audio Connection; the blob's own source no longer lists an engine on this device.
assert.match(
  read("../../packages/client/src/hooks/use-device-setup.ts"),
  /speaking = !!speech\?\.speechEnabled && !!speech\.resolvedConnectionId/,
);
assert.doesNotMatch(read("../../packages/client/src/components/connections/DeviceDetail.tsx"), /tts\?\.local/);

console.log("connection-voice-row regression passed");
