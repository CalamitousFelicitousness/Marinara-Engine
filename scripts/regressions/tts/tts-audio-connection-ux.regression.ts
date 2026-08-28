// Speech is configured on an audio connection and spoken through that same
// connection. The wiring that makes those one thing is spread across the client,
// and every link in it fails quietly.
//
// A speak request that names no connection still produces sound, because the
// server resolves one. The failure is subtler: the surface gates on settings it
// did not resolve, the cache replays a clip another engine produced, and a game
// pinned to one connection speaks through a different one. None of that throws.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ttsConfigSchema } from "../../../packages/shared/src/types/tts.js";
import { withTTSVoiceRequestCacheKeys } from "../../../packages/client/src/lib/tts-dialogue.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const readSource = (relative: string) => readFileSync(join(repositoryRoot, relative), "utf8");

// ── A cached clip belongs to the engine that produced it ──
// Two connections can hold the same source, endpoint, model and voice and still
// be different engines: different keys, different accounts, different cloned
// voices behind the same id. Without the connection in the signature, switching
// between them replays the previous one's audio and nothing looks wrong.
{
  const config = ttsConfigSchema.parse({ source: "elevenlabs", voice: "shared-voice" });
  const request = [{ text: "The same line, twice." }];
  const first = withTTSVoiceRequestCacheKeys(request, config, "message-1", "connection-a");
  const second = withTTSVoiceRequestCacheKeys(request, config, "message-1", "connection-b");
  const appLevel = withTTSVoiceRequestCacheKeys(request, config, "message-1", null);

  assert.notEqual(first[0]?.cacheKey, second[0]?.cacheKey, "two connections must not share a cache key");
  assert.notDeepEqual(first[0]?.cacheAliases, second[0]?.cacheAliases, "nor a text alias, which is what replays");
  assert.notEqual(first[0]?.cacheKey, appLevel[0]?.cacheKey, "and neither shares one with app-level resolution");
  assert.deepEqual(
    withTTSVoiceRequestCacheKeys(request, config, "message-1", "connection-a")[0]?.cacheKey,
    first[0]?.cacheKey,
    "the same connection keeps its cache",
  );
  assert.match(String(first[0]?.cacheKey), /^chat-voice-line-v3:/u, "the key version retires clips keyed without it");
}

// ── A sequence can carry the connection at all ──
// The option existed on a single speak call, but the sequence type omitted it
// and fetchChunk rebuilt the per-chunk options without it, so chat speech could
// not name a connection even if a caller wanted to.
{
  const service = readSource("packages/client/src/lib/tts-service.ts");
  const sequenceOptions =
    /export interface TTSSpeakSequenceOptions extends Pick<[\s\S]*?> \{/u.exec(service)?.[0] ?? "";
  assert.match(sequenceOptions, /"audioConnectionId"/u, "a sequence must be able to name its connection");
  const fetchChunk = service.slice(service.indexOf("const fetchChunk ="), service.indexOf("const playBlob ="));
  assert.match(fetchChunk, /audioConnectionId: options\.audioConnectionId/u, "and every chunk must carry it");
}

// ── Surfaces read the resolution instead of guessing at it ──
for (const [file, path] of [
  ["ChatMessage.tsx", "packages/client/src/components/chat/ChatMessage.tsx"],
  ["ChatArea.tsx", "packages/client/src/components/chat/ChatArea.tsx"],
] as const) {
  const source = readSource(path);
  assert.match(source, /useEffectiveTTSConfig/u, `${file}: must read what a speak request would actually reach`);
  assert.match(source, /audioConnectionId:/u, `${file}: and pass it back on the request`);
  assert.doesNotMatch(source, /useTTSConfig\(/u, `${file}: the app-level blob alone cannot answer which engine speaks`);
}

// ── A pinned game speaks through the connection it was pinned to ──
// Sound effects and music already honored the game's audio connection while
// narration and combat lines went to the category default, so one game could
// score and speak on two different engines.
{
  const narration = readSource("packages/client/src/components/game/GameNarration.tsx");
  const combat = readSource("packages/client/src/components/game/GameCombatUI.tsx");
  const surface = readSource("packages/client/src/components/game/GameSurface.tsx");

  for (const [file, source] of [
    ["GameNarration.tsx", narration],
    ["GameCombatUI.tsx", combat],
  ] as const) {
    assert.match(source, /audioConnectionId\?: string;/u, `${file}: takes the game's connection`);
    assert.match(source, /useEffectiveTTSConfig\(audioConnectionId\)/u, `${file}: resolves against it`);
    assert.match(source, /audioConnectionId:/u, `${file}: and synthesizes through it`);
  }
  assert.equal(
    (surface.match(/audioConnectionId=\{gameAudioConnectionId\}/gu) ?? []).length,
    3,
    "both narration mounts and combat must be handed the same connection",
  );

  // Cache keys move with the signature change, or a pinned game replays clips
  // the previous engine produced.
  assert.match(narration, /game-voice-line-v3:/u, "narration text key retires clips keyed without the connection");
  assert.match(narration, /game-voice-line-v4:/u, "narration segment key likewise");
  assert.match(combat, /combat-voice-v2:/u, "combat likewise");

  // The client used to mirror the server's default and fallback order, quarantine
  // rules included. Two copies of that rule is one too many.
  assert.doesNotMatch(
    surface,
    /rows\.find\(\(connection\) => isConnectionFlagTrue\(connection\.defaultForAgents\)\)/u,
    "GameSurface must not re-derive the server's audio resolution order",
  );
}

// ── The editor owns the engine, the card owns playback ──
{
  const editor = readSource("packages/client/src/components/connections/ConnectionEditor.tsx");
  assert.match(editor, /<AudioSourceFields/u, "the audio branch renders the source fields");
  assert.match(editor, /<AudioSynthesisDefaults/u, "and the synthesis defaults");
  assert.match(editor, /<AudioVoiceCasting/u, "and voice casting");
  // The generic groups ask for an address and a model the audio fields already
  // handle per source, so audio would otherwise show each of them twice.
  assert.match(
    editor,
    /Base URL \(audio keeps its own[\s\S]{0,120}?\{!isAudioProvider && \(/u,
    "the generic base URL group is hidden for audio",
  );
  assert.match(
    editor,
    /Model Selection \(audio picks its model[\s\S]{0,120}?\{!isAudioProvider && \(/u,
    "the generic model group is hidden for audio",
  );

  // Whether an address is worth showing is a property of the source, not a list
  // maintained beside it.
  const fields = readSource("packages/client/src/components/connections/audio/AudioSourceFields.tsx");
  assert.match(fields, /baseUrlMode/u, "base URL visibility keys on the source definition");
  for (const id of ["elevenlabs", "nanogpt", "xai", "pockettts"]) {
    assert.doesNotMatch(
      fields,
      new RegExp(String.raw`baseUrlMode[\s\S]{0,80}["']${id}["']`, "u"),
      `base URL visibility must not name ${id} directly`,
    );
  }

  const modal = readSource("packages/client/src/components/modals/CreateConnectionModal.tsx");
  assert.match(modal, /audioSource: "elevenlabs"/u, "a new audio connection starts with a real source, not null");
}

// ── Saving a connection invalidates what it decided ──
{
  const hooks = readSource("packages/client/src/hooks/use-connections.ts");
  const mutations = ["useCreateConnection", "useUpdateConnection", "useDuplicateConnection", "useDeleteConnection"];
  for (const mutation of mutations) {
    const body = hooks.slice(hooks.indexOf(`export function ${mutation}`));
    const scoped = body.slice(0, body.indexOf("\n}\n") + 1);
    assert.match(scoped, /ttsKeys\.all/u, `${mutation}: an audio connection change makes the TTS view stale`);
  }
}

// ── Switching engines is a control, not a trip to the defaults section ──
// The card names the engine that speaks, so it is where that engine gets
// changed. Selecting writes the audio category default, the same flag the
// Connections defaults section writes: a second notion of "active engine"
// would be a second thing to keep in sync.
{
  const card = readSource("packages/client/src/components/panels/settings/TTSConfigCard.tsx");
  assert.match(card, /<AudioConnectionPicker \/>/u, "the card offers the engine picker");

  const picker = readSource("packages/client/src/components/connections/audio/AudioConnectionPicker.tsx");
  assert.match(picker, /defaultForAgents: true/u, "picking an engine writes the audio category default");
  assert.match(picker, /defaultForAgents: false/u, "and clearing the selection clears that same flag");

  // Which rows qualify is one rule, audio provider and not a quarantined
  // import, already shared with the game setup wizard. Another inline copy
  // drifts from the server's resolution the first time either moves.
  assert.match(picker, /filterAudioGenerationConnections/u, "the picker reuses the shared audio filter");
  assert.doesNotMatch(picker, /provider === "audio"/u, "rather than re-deriving it inline");

  // What is picked and what speaks are different questions: a fallback row or
  // the legacy blob still resolves when nothing is picked. Comparing names
  // would read two connections sharing a name as agreement.
  assert.match(picker, /origin !== "default"/u, "the mismatch note keys on the resolution origin");
}

console.info("TTS audio connection UX regression passed.");
