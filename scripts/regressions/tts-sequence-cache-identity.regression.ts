// Real sequence/cache boundary with synthetic audio: no network provider or browser playback.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ttsConfigSchema } from "../../packages/shared/src/types/tts.js";
import { withTTSVoiceRequestCacheKeys } from "../../packages/client/src/lib/tts-dialogue.js";
import { ttsService, type TTSSpeakRequest } from "../../packages/client/src/lib/tts-service.js";
import { __resetTTSMemoryCacheForTests } from "../../packages/client/src/lib/tts-audio-cache.js";

class FixtureAudio extends EventTarget {
  src = "";
  volume = 1;
  muted = false;
  paused = true;
  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  async play() {
    this.paused = false;
    setTimeout(() => this.onended?.(), 0);
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {}
}

const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
const originalFetch = globalThis.fetch;
const sent: Array<Record<string, string>> = [];
const failures: string[] = [];
const check = (condition: boolean, label: string) => {
  if (!condition) failures.push(label);
};
Object.defineProperty(globalThis, "Audio", { configurable: true, value: FixtureAudio });
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as Record<string, string>;
  sent.push(body);
  return new Response(new Blob([JSON.stringify(body)], { type: "audio/mpeg" }));
};

try {
  __resetTTSMemoryCacheForTests();
  const requests: TTSSpeakRequest[] = ["First line.", "Second line."].map((text, index) => ({
    text,
    voice: "voice-a",
    cacheKey: `identity-message:${index}`,
    cacheAliases: [`identity-text:${index}`],
  }));
  const play = (lines: TTSSpeakRequest[], audioConnectionId?: string) =>
    ttsService.speakSequence(lines, "identity", { audioConnectionId, throwOnError: true });
  await play(requests, "connection-a");
  check(sent.length === 2, "initial two chunks synthesize");
  await play(requests, "connection-a");
  check(sent.length === 2, "identical source and voice reuse both chunks");
  await play(requests, "connection-b");
  check(sent.length === 4, "another explicit connection synthesizes the same text again");
  const otherVoice = requests.map((line) => ({ ...line, voice: "voice-b" }));
  await play(otherVoice, "connection-b");
  check(sent.length === 6, "another explicit voice synthesizes the same text again");
  await play(otherVoice, "");
  check(sent.length === 8, "legacy empty sentinel has a distinct cache identity");
  await play(otherVoice);
  check(sent.length === 10, "default resolution is distinct from explicit legacy settings");
  const aliases = otherVoice.map((line) => ({ ...line, cacheKey: `another:${line.cacheKey}` }));
  await play(aliases);
  check(sent.length === 10, "same-context text aliases still share synthesis");
  await ttsService.clearCachedAudio(otherVoice);
  await play(otherVoice);
  check(sent.length === 12, "clearing the current primary and aliases regenerates both clips");
  await ttsService.clearCachedAudio(otherVoice, { audioConnectionId: "connection-b" });
  await play(otherVoice, "connection-b");
  check(sent.length === 14, "explicit-source clearing removes the corresponding cache namespace");
  assert.deepEqual(
    sent.map(({ audioConnectionId, voice }) => [audioConnectionId, voice]),
    [
      ...Array.from({ length: 2 }, () => ["connection-a", "voice-a"]),
      ...Array.from({ length: 2 }, () => ["connection-b", "voice-a"]),
      ...Array.from({ length: 2 }, () => ["connection-b", "voice-b"]),
      ...Array.from({ length: 2 }, () => ["", "voice-b"]),
      ...Array.from({ length: 4 }, () => [undefined, "voice-b"]),
      ...Array.from({ length: 2 }, () => ["connection-b", "voice-b"]),
    ],
    "actual synthesis requests preserve the selected source and voice, including the legacy sentinel",
  );
  check(ttsService.getState() === "idle" && ttsService.getPlayback() === null, "sequence playback cleans up");

  const config = ttsConfigSchema.parse({ source: "openai", connectionId: "connection-a", voice: "same-voice" });
  const alternate = { ...config, connectionId: "connection-b" };
  const line = [{ text: "Native line.", voice: "same-voice" }];
  check(
    withTTSVoiceRequestCacheKeys(line, config, "message")[0]?.cacheKey !==
      withTTSVoiceRequestCacheKeys(line, alternate, "message")[0]?.cacheKey,
    "native chat keys distinguish otherwise-identical speech connections",
  );
  for (const [file, names] of [
    ["GameNarration.tsx", ["hashVoiceKey", "buildVoiceConfigSignature", "buildVoiceLineTextCacheKey"]],
    ["GameCombatUI.tsx", ["buildCombatVoiceConfigSignature"]],
  ] as const) {
    const source = ts.createSourceFile(
      file,
      readFileSync(new URL(`../../packages/client/src/components/game/${file}`, import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const code = names.map((name) => {
      const node = source.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === name);
      assert.ok(node, name);
      return node.getText(source);
    });
    const signature = file === "GameNarration.tsx" ? "buildVoiceConfigSignature" : "buildCombatVoiceConfigSignature";
    const compiled = ts.transpileModule(code.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
    const api = new Function(
      `${compiled.outputText};return {signature:${signature}${file === "GameNarration.tsx" ? ",textKey:buildVoiceLineTextCacheKey" : ""}};`,
    )() as {
      signature: (value: typeof config) => string;
      textKey?: (value: typeof config, job: { chunk: string; voice: string }) => string;
    };
    check(api.signature(config) !== api.signature(alternate), `${file} invalidates local entries on connection change`);
    if (api.textKey)
      check(
        api.textKey(config, { chunk: "Same chunk.", voice: "same-voice" }) !==
          api.textKey(alternate, { chunk: "Same chunk.", voice: "same-voice" }),
        "Game narration persistent aliases distinguish connections",
      );
  }
  assert.deepEqual(failures, [], `Cache identity failures: ${failures.join("; ")}`);
  console.log("TTS sequence cache identity: source, voice, aliases, cleanup and native chat/Game controls passed");
} finally {
  ttsService.stop();
  __resetTTSMemoryCacheForTests();
  globalThis.fetch = originalFetch;
  if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
  else delete (globalThis as Record<string, unknown>).Audio;
}
