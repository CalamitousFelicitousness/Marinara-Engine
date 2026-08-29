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

// ── Each lane of a game reaches the engine that lane was pinned to ──
// One resolved id used to feed narration, combat, sound effects, and music
// alike, so a game could not speak on one engine and score on another.
{
  const narration = readSource("packages/client/src/components/game/GameNarration.tsx");
  const combat = readSource("packages/client/src/components/game/GameCombatUI.tsx");
  const surface = readSource("packages/client/src/components/game/GameSurface.tsx");
  const hook = readSource("packages/client/src/hooks/use-tts.ts");

  for (const [file, source] of [
    ["GameNarration.tsx", narration],
    ["GameCombatUI.tsx", combat],
  ] as const) {
    assert.match(source, /audioConnectionId\?: string;/u, `${file}: takes the game's connection`);
    assert.match(source, /useEffectiveTTSConfig\(audioConnectionId\)/u, `${file}: resolves against it`);
    assert.match(source, /audioConnectionId:/u, `${file}: and synthesizes through it`);
  }

  // Purposes are separate cache entries, or one lane's answer is served to
  // another and the split is invisible at runtime.
  assert.match(
    hook,
    /effectiveConfig: \(purpose: AudioPurpose, scope: string\)/u,
    "the effective config cache key must carry the purpose",
  );
  assert.match(
    hook,
    /useEffectiveAudioConfig\("speech", connectionId\)/u,
    "useEffectiveTTSConfig must stay the speech lane of the general hook",
  );

  // The pin per lane is the game's own, else the all-purpose pin. One helper
  // decides that, because the wizard and the drawer write what this reads.
  for (const purpose of ["speech", "sfx", "music"] as const) {
    assert.match(
      surface,
      new RegExp(String.raw`effectiveGameAudioPin\(chatMeta, "${purpose}"\)`, "u"),
      `GameSurface must take its ${purpose} pin from the shared helper`,
    );
  }

  // The three speech mounts get the voice pin, and each generation call gets
  // its own, so swapping two of them cannot go unnoticed.
  assert.equal(
    (surface.match(/audioConnectionId=\{gameVoiceConnectionId\}/gu) ?? []).length,
    3,
    "both narration mounts and combat must be handed the voice pin",
  );
  assert.match(
    surface,
    /GAME_AUDIO_GENERATION_TIMEOUT_MS[\s\S]{0,400}?gameSfxConnectionId|gameSfxConnectionId[\s\S]{0,400}?GAME_AUDIO_GENERATION_TIMEOUT_MS/u,
    "sound effect generation must send the sound effect pin",
  );
  assert.match(
    surface,
    /CONTEXT_MUSIC_GENERATION_TIMEOUT_MS[\s\S]{0,400}?gameMusicConnectionId|gameMusicConnectionId[\s\S]{0,600}?CONTEXT_MUSIC_GENERATION_TIMEOUT_MS/u,
    "music generation must send the music pin",
  );

  // Capability is one server answer now: the source supports the purpose and the
  // connection opted in. Recomputing either half here would drift from the gate
  // the route applies.
  assert.match(
    surface,
    /effectiveSfxAudio\?\.gameAudioEnabled === true/u,
    "sound effects gate on the sound effect lane's capability answer",
  );
  assert.match(
    surface,
    /effectiveMusicAudio\?\.gameAudioEnabled === true/u,
    "and music on its own, so one lane's engine cannot decide for the other",
  );
  assert.doesNotMatch(
    surface,
    /resolvedSource === "elevenlabs"/u,
    "GameSurface must not name a backend to decide what may be generated",
  );

  // Cache keys stay as they are: purpose routing changes which connection
  // answers, never what a given connection produces, and the voice signature
  // already carries the resolved id.
  assert.match(narration, /game-voice-line-v3:/u, "narration text key is unchanged");
  assert.match(narration, /game-voice-line-v4:/u, "narration segment key likewise");
  assert.match(combat, /combat-voice-v2:/u, "combat likewise");

  // The client used to mirror the server's default and fallback order, quarantine
  // rules included. Two copies of that rule is one too many, and there are now
  // three chains it could get wrong instead of one.
  assert.doesNotMatch(
    surface,
    /rows\.find\(\(connection\) => isConnectionFlagTrue\(connection\.defaultForAgents\)\)/u,
    "GameSurface must not re-derive the server's audio resolution order",
  );
  assert.doesNotMatch(surface, /defaultForSfx|defaultForMusic/u, "and must not re-derive the purpose chains either");
}

// ── A running game can be repointed ──
// Pins chosen once in the wizard were unreachable afterwards, as were the two
// generation switches. A lane missing from this card is a lane a player cannot
// change without starting a new game.
{
  const card = readSource("packages/client/src/components/chat/GameAudioSettingsCard.tsx");
  const drawer = readSource("packages/client/src/components/chat/ChatSettingsDrawer.tsx");
  for (const key of ["gameVoiceConnectionId", "gameSfxConnectionId", "gameMusicConnectionId"] as const) {
    assert.match(card, new RegExp(String.raw`renderLane\("${key}"`, "u"), `${key} must be settable per game`);
  }
  assert.match(drawer, /<GameAudioSettingsCard/u, "and the card must be mounted in the drawer");
  assert.match(drawer, /\[key\]: id \}\)/u, "each lane writes its own metadata key rather than a shared one");
  assert.match(
    card,
    /enabled=\{metadata\.gameAudioSoundEffectsEnabled !== false\}/u,
    "the sound effect switch lives here too, showing this game's stored state",
  );
  assert.match(card, /enabled=\{metadata\.gameAudioMusicEnabled !== false\}/u, "and the music switch likewise");
  // An older game's all-purpose pin is what an unpinned lane reaches, so the
  // empty option has to say that rather than claim the app default answers.
  assert.match(
    card,
    /metadata\.gameAudioConnectionId === "string"/u,
    "the empty option must know whether this game carries an all-purpose pin",
  );
  assert.match(card, /useThisGamesAudioConnection/u, "and name it when it does");
}

// ── A new game records a pin per lane ──
// The wizard is where most games get their audio. Writing the all-purpose pin
// here would quietly re-merge the lanes for every game created from now on,
// while still looking correct on screen.
{
  const wizard = readSource("packages/client/src/components/game/GameSetupWizard.tsx");
  const setupStart = wizard.indexOf("const buildSetupConfig = ");
  assert.ok(setupStart > 0, "the wizard must still build a setup config");
  const setupEnd = wizard.indexOf("\n  };", setupStart);
  const buildSetupConfig = wizard.slice(setupStart, setupEnd);

  for (const [field, preview] of [
    ["voiceConnectionId", "voicePreview"],
    ["sfxConnectionId", "sfxPreview"],
    ["musicConnectionId", "musicPreview"],
  ] as const) {
    assert.match(
      buildSetupConfig,
      new RegExp(String.raw`${field}: ${preview}\.pinnedId`, "u"),
      `a new game must record its ${field} from its own lane preview`,
    );
  }
  assert.doesNotMatch(
    buildSetupConfig,
    /audioConnectionId:/u,
    "and must not write the all-purpose pin, which would re-merge the lanes",
  );

  // A config saved before the split carries one pin; it has to reach all three
  // selects or importing a shared game silently drops its audio.
  assert.match(
    wizard,
    /setVoiceConnectionId\(config\.voiceConnectionId \?\? config\.audioConnectionId \?\? null\)/u,
    "an older setup config must hydrate every lane",
  );

  // Preview and pin come from one function, so what the screen promises is what
  // the game stores.
  assert.match(wizard, /previewGameAudioLane\(audioConnections, "sfx"/u, "the sound effect lane is previewed");
  assert.match(wizard, /previewGameAudioLane\(audioConnections, "music"/u, "and the music lane");
  const section = readSource("packages/client/src/components/game/GameAudioSetupSection.tsx");
  assert.match(
    section,
    /audioConnectionSupportsPurpose\(connection, purpose as GameAudioPurpose\)/u,
    "the lane preview must ask the shared capability rule",
  );
  for (const [file, source] of [
    ["GameSetupWizard.tsx", wizard],
    ["GameAudioSetupSection.tsx", section],
  ] as const) {
    assert.doesNotMatch(source, /=== "elevenlabs"/u, `${file}: capability must not be a backend name`);
  }

  const share = readSource("packages/client/src/lib/game-setup-share.ts");
  for (const field of ["voiceConnectionId", "sfxConnectionId", "musicConnectionId"] as const) {
    assert.match(share, new RegExp(String.raw`${field}: 1_000`, "u"), `${field} must survive a share round trip`);
  }
  assert.match(
    share,
    /sourceConfig\.sfxConnectionId \?\? sourceConfig\.audioConnectionId/u,
    "and a file written before the split must resolve its one pin into every lane",
  );
}

// ── Every lane is pointed from the same place ──
// Sound effects and music get their own default and fallback rows beside the
// voice pair. The pair component is generic over the flag name, so the pins that
// matter are which fields each row writes and that nothing offers an engine the
// route would then refuse.
{
  const panel = readSource("packages/client/src/components/panels/ConnectionsPanel.tsx");
  for (const [primary, fallback] of [
    ["defaultForSfx", "fallbackForSfx"],
    ["defaultForMusic", "fallbackForMusic"],
  ] as const) {
    assert.match(panel, new RegExp(String.raw`primaryField="${primary}"`, "u"), `a ${primary} row must exist`);
    assert.match(panel, new RegExp(String.raw`fallbackField="${fallback}"`, "u"), `paired with ${fallback}`);
    assert.match(
      panel,
      new RegExp(String.raw`\|\s*"${primary}"`, "u"),
      `${primary} must be a value the pair component accepts`,
    );
  }
  assert.match(
    panel,
    /audioConnectionSupportsPurpose\(connection, "sfx"\)/u,
    "the sound effect options must be engines that can generate sound effects",
  );
  assert.match(
    panel,
    /audioConnectionSupportsPurpose\(connection, "music"\)/u,
    "and the music options engines that can generate music",
  );
  // A connection that loses the capability still holds the flag until someone
  // clears it, so it has to stay in the list that can clear it.
  assert.match(
    panel,
    /isEnabledConnectionRole\(connection\.defaultForSfx\)/u,
    "a stale sound effect default must stay visible to be cleared",
  );
  assert.match(panel, /isEnabledConnectionRole\(connection\.defaultForMusic\)/u, "and a stale music default likewise");

  // The empty option names what actually answers next, the way the voice pair's
  // does. "None" would describe a silence that never happens.
  const catalogText = readSource("packages/client/src/localization/locales/en.json");
  const catalog = JSON.parse(catalogText) as Record<string, string>;
  const purposeEmptyLabel = catalog["ui.panels.connectiondefaultssection.useTheFallbackThenTheVoiceDefaults"];
  assert.ok(purposeEmptyLabel, "the purpose pairs need an empty-option label");
  assert.match(purposeEmptyLabel, /fallback/iu, "which names the fallback");
  assert.match(purposeEmptyLabel, /Voice/u, "and then the lane it falls through to");
  assert.match(
    panel,
    /ui\.panels\.connectiondefaultssection\.useTheFallbackThenTheVoiceDefaults/u,
    "and the panel must render it",
  );
}

// ── Capability is asked, never spelled out ──
// The same fact reached five files as `=== "elevenlabs"`. It is one table now,
// and a copy that drifts would offer a switch the server refuses to honor.
{
  const editor = readSource("packages/client/src/components/connections/ConnectionEditor.tsx");
  const fields = readSource("packages/client/src/components/connections/audio/AudioSourceFields.tsx");
  const filters = readSource("packages/client/src/lib/connection-filters.ts");

  assert.match(
    editor,
    /ttsSourceSupportsGameAudio\(toTTSSourceId\(localAudioSource\), "sfx"\)/u,
    "the editor must ask the table before storing a sound effect opt-in",
  );
  assert.doesNotMatch(
    editor,
    /localAudioSource === "elevenlabs"/u,
    "and must not decide capability by naming a backend",
  );
  assert.match(fields, /ttsSourceSupportsGameAudio\(source, "sfx"\)/u, "the switches follow the table");
  assert.match(fields, /ttsSourceSupportsGameAudio\(source, "music"\)/u, "for both purposes");
  assert.match(
    filters,
    /ttsSourceSupportsGameAudio\(toTTSSourceId\(connection\.audioSource\)/u,
    "and so do the pickers",
  );

  // Scoped to the capability switches: the source literal near the voice
  // controls is a synthesis-settings rule and legitimately stays.
  const switchBlock = fields.slice(fields.indexOf("gameSoundEffects"));
  assert.doesNotMatch(
    switchBlock,
    /source === "elevenlabs"/u,
    "the game audio switches must not be gated on a source literal",
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

  // The server distinguishes "the endpoint answered" from "here are our own
  // names". A picker that ignores that shows another vendor's voices as the
  // local engine's, and a wrong list is indistinguishable from a right one.
  assert.match(fields, /voicesData\?\.fromProvider === true/u, "the editor reads whether the listing answered");
  assert.match(fields, /endpointPublishedNoVoiceList/u, "and says so rather than presenting built-ins as found");
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

  // Two views of one flag, so the empty case has to read the same in both.
  // Wording that differed is what taught the reader they were separate picks,
  // and "no default audio connection" additionally reads as silence when what
  // really happens is a fall-through the user cannot see.
  const key = "useTheFallbackThenTheTextToSpeechSettings";
  const english = JSON.parse(readSource("packages/client/src/localization/locales/en.json")) as Record<string, string>;
  const emptyLabel = english[`ui.connections.audioconnectionpicker.${key}`];
  assert.ok(emptyLabel, "the card names what answers when nothing is picked");
  assert.match(emptyLabel, /Text to Speech/u, "and names it, rather than reporting an absence");
  assert.equal(
    english[`ui.panels.connectiondefaultssection.${key}`],
    emptyLabel,
    "the defaults section says it identically, being the same selection",
  );

  const panel = readSource("packages/client/src/components/panels/ConnectionsPanel.tsx");
  assert.match(panel, new RegExp(`connectiondefaultssection\.${key}`, "u"), "and actually renders that label");
}

// ── Clearing the clip cache clears all of it ──
// Blobs live in one object store and their metadata in another, and the panel's
// "30 clips, 26 MB" line counts the metadata. A clear that drops only the blobs
// therefore looks like it did nothing, and the in-memory copy would answer the
// next read regardless. This repo ships no IndexedDB double, so the pin is on
// shape rather than on a round trip.
{
  const cache = readSource("packages/client/src/lib/tts-audio-cache.ts");
  assert.match(
    cache,
    /export async function clearCachedTTSAudio[\s\S]{0,500}?META_STORE_NAME/u,
    "clearing drops the metadata the summary counts",
  );
  assert.match(
    cache,
    /export async function clearCachedTTSAudio[\s\S]{0,500}?memoryCache\.clear\(\)/u,
    "and the in-memory copy, which would otherwise answer the next read",
  );

  const card = readSource("packages/client/src/components/panels/settings/TTSConfigCard.tsx");
  assert.match(
    card,
    /const handleClearCachedClips[\s\S]{0,400}?showConfirmDialog/u,
    "deleting clips asks first, since regenerating them costs a provider call",
  );
  assert.match(
    card,
    /const handleClearCachedClips[\s\S]{0,900}?setTtsCacheSummary\(\{ count: 0, bytes: 0 \}\)/u,
    "and the summary stops reporting what was just deleted",
  );
}

// ── Engine parameters are edited on the connection that sends them ──
{
  const editor = readSource("packages/client/src/components/connections/ConnectionEditor.tsx");
  assert.match(
    editor,
    /<AudioParameterSection[\s\S]{0,400}?value=\{localAudioSettings\.audioParameters\}/u,
    "the section reads and writes the same settings object as its neighbours",
  );
  assert.match(
    editor,
    /<AudioParameterSection[\s\S]{0,700}?dirty=\{dirty\}/u,
    "and knows about unsaved edits, since the preview describes the saved row",
  );

  // The value was always saved and registered in the throttle registry; only
  // the field was hidden, and nothing on the TTS path read it.
  assert.match(
    editor,
    /\{\(!isMediaGenerationProvider \|\| isAudioProvider\) && \(/u,
    "the requests-per-minute field is reachable for an audio connection",
  );

  const section = readSource("packages/client/src/components/connections/audio/AudioParameterSection.tsx");
  assert.match(
    section,
    /ttsSourceSupportsGameAudio\(source, candidate\)/u,
    "lanes come from the shared capability table",
  );
  for (const id of ["elevenlabs", "openai", "pockettts", "xai", "nanogpt"]) {
    assert.doesNotMatch(section, new RegExp(`=== "${id}"`, "u"), `the section must not name ${id} directly`);
  }

  // A lane cleared to nothing is removed, not stored as an empty object: the
  // difference between inheriting and pinning an answer nobody chose.
  assert.match(
    section,
    /if \(Object\.keys\(next\)\.length === 0\) delete map\[active\];/u,
    "an emptied lane stops being stored",
  );

  const paramEditor = readSource("packages/client/src/components/connections/audio/AudioParameterEditor.tsx");
  assert.match(
    paramEditor,
    /audioParameterPaths\(value\)\.filter\(\(path\) => !knownKeys\.has\(path\)\)/u,
    "a stored key the catalog does not describe still gets a row rather than vanishing",
  );
  assert.match(
    paramEditor,
    /if \(!trimmed\) return \{ ok: true, value: \{\} \};/u,
    "emptying the JSON box clears the lane rather than failing to parse",
  );
}

console.info("TTS audio connection UX regression passed.");
