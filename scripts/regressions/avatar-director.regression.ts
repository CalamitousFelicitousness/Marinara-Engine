/**
 * The avatar director turns chat activity into avatar frames:
 *   - the visible reply is cut into sentences (long ones at a clause), each paragraph gets an owner, and dialogue
 *     is collected per owner with the text-to-speech extractor, including a quote that is still open;
 *   - the speech clock speaks dialogue at about 14 characters a second, speeds up to 1.5x and then skips when
 *     the typewriter runs ahead, squeezes a whole line into 8 s, reads kana by vowel row, and closes the mouth
 *     150 ms after the last character with a 50 ms attack and an 80 ms release;
 *   - classifier calls go out at most every 1.2 s with a per-sentence cache; faces switch only on a 0.45 score
 *     with a 0.15 lead, hold 2 s, need two neutral sentences, and relax 4 s after the reply unless the Expression
 *     Engine settled them; a reply that arrives whole is classified whole and spoken within 8 s;
 *   - text-to-speech audio drives the mouth while it plays; Game mode faces and mouths follow the Game Master's
 *     lines and never call the classifier; states are thinking, talking, listening and idle.
 * Runs on the real chat and agent stores with a stubbed classifier; time is the frame time passed in.
 */
import assert from "node:assert/strict";
import type {
  AvatarClassification,
  AvatarClassifyRequest,
  AvatarEmotion,
  AvatarFrameInput,
} from "@marinara-engine/shared";

const { useChatStore } = await import("../../packages/client/src/stores/chat.store.js");
const { useAgentStore } = await import("../../packages/client/src/stores/agent.store.js");
const { TTS_AUTOPLAY_MESSAGE_READY_EVENT } = await import("../../packages/client/src/lib/tts-autoplay.js");
const director = await import("../../packages/client/src/features/avatars/director/avatar-director.js");
const { createSpeechClock, followMouthEnvelope } =
  await import("../../packages/client/src/features/avatars/director/speech-clock.js");
const replyText = await import("../../packages/client/src/features/avatars/director/reply-text.js");
const { publishAvatarGameLine } = await import("../../packages/client/src/features/avatars/director/game-line-feed.js");

// ── Reading the visible reply ──
const segmentTexts = (text: string, from: number, done: boolean) => {
  const read = replyText.readReplySegments(text, from, done);
  return { texts: read.segments.map((segment) => segment.text), next: read.next };
};
let read = segmentTexts("Hello there. How are", 0, false);
assert.deepEqual(read.texts, ["Hello there."], "only finished sentences are read");
read = segmentTexts("Hello there. How are you? Fine", read.next, false);
assert.deepEqual(read.texts, ["How are you?"], "reading continues where it stopped");
assert.deepEqual(
  segmentTexts("Hello there. How are you? Fine", read.next, true).texts,
  ["Fine"],
  "done reads the rest",
);
assert.deepEqual(segmentTexts("It costs 3.5 coins.", 0, false).texts, [], "a sentence waits for the next word");
assert.deepEqual(segmentTexts("嬉しい。悲しい", 0, false).texts, ["嬉しい。"], "Japanese full stops end sentences");
assert.deepEqual(
  segmentTexts('*She smiles.* "Hi!"\n', 0, false).texts,
  ["She smiles.", '"Hi!"'],
  "markup is removed and line breaks end sentences",
);
const runOn = `${"word ".repeat(30)}, and then ${"more ".repeat(20)}`;
const cut = segmentTexts(runOn, 0, false).texts;
assert.ok(cut.length >= 1 && cut[0]!.endsWith(","), "a run-on sentence is cut at a clause");
assert.ok(cut.every((text) => text.length <= replyText.MAX_SEGMENT_CHARS));

assert.equal(replyText.closeOpenQuote('She said "Hel'), 'She said "Hel"');
assert.equal(replyText.closeOpenQuote("“Hi"), "“Hi”");
assert.equal(replyText.closeOpenQuote("“Hi” she said."), "“Hi” she said.");

const alice = { ownerId: "alice", name: "Alice Moon" };
const bob = { ownerId: "bob", name: "Bob" };
const reply = 'Alice smiles. "Hi there!"\n[Bob]: Get lost.\nBobby waves.\n\nAlice laughs. "Fine';
const paragraphs = replyText.attributeReplyParagraphs(reply, [alice, bob], null, "alice");
assert.deepEqual(
  paragraphs.map((paragraph) => paragraph.ownerId),
  ["alice", "bob", "bob", "alice"],
  "a paragraph belongs to the first participant it names (whole names only), else the one before",
);
assert.ok(
  replyText.attributeReplyParagraphs(reply, [alice, bob], "bob", "alice").every((p) => p.ownerId === "bob"),
  "the Engine's streaming character wins",
);
assert.deepEqual(
  Object.fromEntries(replyText.collectReplyDialogue(reply, paragraphs, [alice, bob])),
  { alice: "Hi there! Fine", bob: "Get lost." },
  "dialogue per owner, with [Name]: lines and an open quote",
);

// ── The speech clock ──
const run = (clock: ReturnType<typeof createSpeechClock>, from: number, to: number, stepMs = 10) => {
  const samples: Array<{ t: number; open: number; viseme: string | null; speaking: boolean }> = [];
  for (let t = from; t <= to; t += stepMs) samples.push({ t, ...clock.sample(t) });
  return samples;
};
const lastSpeaking = (samples: ReturnType<typeof run>) => samples.filter((s) => s.speaking).at(-1)?.t ?? -1;

assert.ok(Math.abs(followMouthEnvelope(0, 1, 50) - (1 - Math.exp(-1))) < 1e-9, "50 ms attack");
assert.ok(Math.abs(followMouthEnvelope(1, 0, 80) - Math.exp(-1)) < 1e-9, "80 ms release");

let clock = createSpeechClock();
clock.push("Hello world");
let samples = run(clock, 0, 1300);
assert.ok(
  samples.some((s) => s.open > 0.5 && s.viseme),
  "vowels open the mouth with a viseme",
);
const helloEnd = lastSpeaking(samples);
assert.ok(helloEnd >= 900 && helloEnd <= 950, `11 characters at 14/s close 150 ms after the last (${helloEnd})`);
assert.deepEqual([samples.at(-1)!.open, samples.at(-1)!.viseme], [0, null], "the mouth rests afterwards");

clock = createSpeechClock();
clock.push("la".repeat(25));
samples = run(clock, 0, 3200);
const catchUpEnd = lastSpeaking(samples);
assert.ok(catchUpEnd > 2700 && catchUpEnd < 3000, `3.6 s of text runs at up to 1.5x (${catchUpEnd})`);

clock = createSpeechClock();
clock.push("la".repeat(150));
assert.ok(lastSpeaking(run(clock, 0, 3000)) < 1700, "far behind the typewriter, the clock skips to the newest text");

clock = createSpeechClock();
clock.speakAll("la".repeat(150), 8_000);
samples = run(clock, 0, 8600, 20);
const wholeEnd = lastSpeaking(samples);
assert.ok(wholeEnd > 7900 && wholeEnd <= 8200, `a whole line is squeezed into 8 s, never skipped (${wholeEnd})`);

clock = createSpeechClock();
clock.push("あいうえお");
samples = run(clock, 0, 700, 5);
const visemeAt = (t: number) => samples.find((s) => s.t === t)?.viseme;
assert.deepEqual(
  [visemeAt(60), visemeAt(180), visemeAt(300), visemeAt(425), visemeAt(545)],
  ["aa", "ih", "ou", "ee", "oh"],
  "kana go by vowel row",
);
clock = createSpeechClock();
clock.push("мама");
samples = run(clock, 0, 200, 5);
assert.equal(samples.find((s) => s.t === 30)?.open, 0, "lips close on м");
assert.equal(samples.find((s) => s.t === 110)?.viseme, "aa", "Cyrillic vowels pick visemes");

// ── The director ──
(globalThis as { window?: EventTarget }).window ??= new EventTarget();
const chatId = "avatar-director-chat";
useChatStore.setState({ activeChatId: chatId });

const SCORES: Array<[RegExp, AvatarEmotion, number, Partial<Record<AvatarEmotion, number>>]> = [
  [/beams|wonderful/u, "happy", 0.8, { neutral: 0.2 }],
  [/sobs|miss him/u, "sad", 0.7, { happy: 0.2, neutral: 0.1 }],
  [/sighs/u, "sad", 0.5, { happy: 0.4, neutral: 0.1 }],
  [/quiet/iu, "neutral", 0.9, { sad: 0.05, happy: 0.05 }],
];
const answer = (text: string): AvatarClassification => {
  const row = SCORES.find(([pattern]) => pattern.test(text));
  const [emotion, weight, rest] = row ? [row[1], row[2], row[3]] : (["neutral", 0.6, { happy: 0.4 }] as const);
  const scores = { neutral: 0, happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, ...rest, [emotion]: weight };
  return { emotion, weight, scores };
};
let t = 1_000;
const calls: Array<{ at: number; texts: string[] }> = [];
const classify = async (request: AvatarClassifyRequest) => {
  calls.push({ at: t, texts: request.texts });
  assert.equal(request.tier, "local-model", "the director asks for the best tier");
  return { results: request.texts.map(answer), tier: "local-model" as const, model: "stub", latencyMs: 1 };
};
const roleplay = director.createAvatarDirector({ chatId, mode: "roleplay", reducedMotion: false }, { classify });
roleplay.setParticipants([
  { owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" },
  { owner: { ownerType: "persona", ownerId: "me" }, name: "Sam" },
]);
const flush = () => new Promise((resolve) => setImmediate(resolve));
let frames: Record<string, AvatarFrameInput> = {};
const step = async (ms: number, onFrame?: () => void) => {
  const end = t + ms;
  while (t < end) {
    t += 16;
    frames = { alice: roleplay.frame("alice", t), me: roleplay.frame("me", t) };
    onFrame?.();
    await flush();
  }
  return frames;
};
const store = () => useChatStore.getState();
const setText = (text: string) => store().setStreamBuffer(text, chatId);
const messageReady = (content: string) =>
  window.dispatchEvent(
    new CustomEvent(TTS_AUTOPLAY_MESSAGE_READY_EVENT, {
      detail: { chatId, message: { id: `m${t}`, role: "assistant", content, characterId: "alice" } },
    }),
  );
const endReply = (content: string) => {
  messageReady(content);
  store().clearStreamBuffer(chatId);
  store().setAbortController(chatId, null);
};
const waitFor = async (what: string, test: () => boolean, maxMs = 4_000) => {
  const deadline = t + maxMs;
  while (!test()) {
    assert.ok(t < deadline, `timed out waiting for ${what}`);
    await step(16);
  }
  return t;
};

// Send: thinking until the first word.
store().setAbortController(chatId, new AbortController());
await step(32);
assert.equal(frames.alice!.state, "thinking", "the character thinks from send to the first word");
assert.equal(frames.me!.state, "idle", "the persona never thinks for the character");

// Typing out a reply: dialogue moves the mouth, narration does not; the persona listens.
const typed = 'Alice beams at you. "This is so wonderful, really!" She looks away.';
let sawTalking = false;
let sawListening = false;
let maxOpen = 0;
for (let index = 1; index <= typed.length; index += 1) {
  setText(typed.slice(0, index));
  await step(32, () => {
    if (frames.alice!.state === "talking") sawTalking = true;
    if (frames.me!.state === "listening") sawListening = true;
    maxOpen = Math.max(maxOpen, frames.alice!.mouthOpen);
  });
}
assert.ok(sawTalking && maxOpen > 0.5, "the character talks while its dialogue appears");
assert.ok(sawListening, "the persona listens while the character talks");
const happyAt = await waitFor("the classifier's happy face", () => frames.alice!.emotion === "happy");
for (let index = 1; index < calls.length; index += 1) {
  assert.ok(calls[index]!.at - calls[index - 1]!.at >= 1_200, "classifier calls are at least 1.2 s apart");
}
assert.ok(
  calls.flatMap((call) => call.texts).includes("Alice beams at you."),
  "sentences reach the classifier as plain text",
);

// Hysteresis: a face holds 2 s, needs a 0.15 lead, and neutral needs two sentences.
let shown = typed;
const say = (sentence: string) => {
  shown = `${shown} ${sentence} `;
  setText(shown);
};
say("Alice sobs.");
const sadAt = await waitFor("the sad face", () => frames.alice!.emotion === "sad");
assert.ok(sadAt > happyAt);
say("Alice beams again.");
await step(1_700);
assert.equal(frames.alice!.emotion, "sad", "a new face waits until the current one has held 2 s");
const heldUntil = await waitFor("the held happy face", () => frames.alice!.emotion === "happy", 1_500);
assert.ok(heldUntil - sadAt >= 2_000, "the waiting face shows once the 2 s are up");
say("Alice sighs.");
await step(3_000);
assert.equal(frames.alice!.emotion, "happy", "a 0.1 lead is not enough to switch");
say("Quiet one.");
await step(2_500);
assert.equal(frames.alice!.emotion, "happy", "one neutral sentence does not reset the face");
say("Quiet two.");
await waitFor("two neutral sentences", () => frames.alice!.emotion === "neutral", 2_500);

// The reply ends: the face relaxes 4 s later.
say("Alice beams once more.");
await waitFor("a happy face before the end", () => frames.alice!.emotion === "happy");
endReply("(final)");
const endedAt = t;
await step(3_000);
assert.equal(frames.alice!.emotion, "happy", "the face holds right after the reply");
await waitFor("the relaxed face", () => frames.alice!.emotion === "neutral", 4_000);
assert.ok(t - endedAt >= 4_000, "the face relaxes no sooner than 4 s after the reply");
assert.equal(frames.alice!.state, "idle");

// Next reply: cached sentences skip the request; the Expression Engine's pick is final.
const callsBefore = calls.length;
store().setAbortController(chatId, new AbortController());
setText("Alice beams at you. ");
await waitFor("the cached happy face", () => frames.alice!.emotion === "happy");
assert.equal(calls.length, callsBefore, "a sentence classified before is answered from the cache");
useAgentStore.getState().addResult("expression", {
  agentId: "expression",
  agentType: "expression",
  type: "sprite_change",
  data: { expressions: [{ characterId: "alice", expression: "crying" }] },
  tokensUsed: 0,
  durationMs: 1,
  success: true,
  error: null,
});
await step(16);
assert.deepEqual(
  [frames.alice!.emotion, frames.alice!.label],
  ["sad", "crying"],
  "the Expression Engine sets the face and its sprite label",
);
setText("Alice beams at you. It is wonderful. ");
await step(2_500);
assert.equal(frames.alice!.label, "crying", "later sentences do not override the Expression Engine");
endReply("(final)");
await step(6_000);
assert.equal(frames.alice!.emotion, "sad", "a settled face does not relax");

// Streaming off: the reply arrives whole, is classified whole, and its dialogue is spoken within 8 s.
store().setAbortController(chatId, new AbortController());
await step(32);
const longLine = "I miss him so much. ".repeat(12).trim();
const wholeCalls = calls.length;
messageReady(`Alice sobs quietly by the window.\n\n"${longLine}"`);
store().setAbortController(chatId, null);
await step(1_000);
assert.equal(frames.alice!.state, "talking", "a whole reply is spoken");
await waitFor("the whole-reply request", () => calls.length > wholeCalls, 1_500);
assert.equal(calls.at(-1)!.texts.length, 1, "a whole reply is classified once, as a whole");
assert.ok(calls.at(-1)!.texts[0]!.includes("sobs quietly"));
await step(6_600);
assert.equal(frames.alice!.state, "talking", "still speaking just before 8 s");
await step(600);
assert.notEqual(frames.alice!.state, "talking", "done speaking by 8 s even though the line is longer");

// Text-to-speech: the voice level drives the mouth while it plays.
roleplay.setAudioSource("alice", { ownerId: "alice", level: () => 0.8, isPlaying: () => true, viseme: () => "oh" });
await step(300);
assert.ok(frames.alice!.mouthOpen > 0.75, "the mouth follows the voice level");
assert.deepEqual([frames.alice!.viseme, frames.alice!.state, frames.me!.state], ["oh", "talking", "listening"]);
roleplay.setAudioSource("alice", null);
await step(300);
assert.equal(frames.alice!.mouthOpen, 0, "the mouth rests when the voice stops");

// The user typing: characters listen.
useChatStore.setState({ hasCurrentInput: true });
await step(32);
assert.deepEqual([frames.alice!.state, frames.me!.state], ["listening", "idle"]);
useChatStore.setState({ hasCurrentInput: false });

// Group chats: the streaming character speaks, the others do not.
roleplay.setParticipants([
  { owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" },
  { owner: { ownerType: "character", ownerId: "bob" }, name: "Bob" },
]);
store().setAbortController(chatId, new AbortController());
store().setStreamingCharacterId("bob");
let bobOpen = 0;
let aliceOpen = 0;
for (const text of ['"Hey', '"Hey there', '"Hey there, Alice!"']) {
  setText(text);
  for (let index = 0; index < 20; index += 1) {
    t += 16;
    bobOpen = Math.max(bobOpen, roleplay.frame("bob", t).mouthOpen);
    aliceOpen = Math.max(aliceOpen, roleplay.frame("alice", t).mouthOpen);
    await flush();
  }
}
assert.ok(bobOpen > 0.5 && aliceOpen === 0, "only the streaming character's mouth moves");
store().setStreamingCharacterId(null);
endReply("(final)");
roleplay.dispose();
const afterDispose = calls.length;
store().setAbortController(chatId, new AbortController());
setText("Alice beams wonderfully after the end. ");
await step(1_500);
assert.equal(calls.length, afterDispose, "a disposed director stops listening");
store().setAbortController(chatId, null);

// ── Game mode: the Game Master's line on screen ──
const gameChatId = "avatar-director-game";
const game = director.createAvatarDirector(
  { chatId: gameChatId, mode: "game", reducedMotion: false },
  {
    classify: async () => {
      throw new Error("Game mode must not call the classifier");
    },
  },
);
game.setParticipants([
  { owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" },
  { owner: { ownerType: "persona", ownerId: "me" }, name: "Sam" },
]);
store().setAbortController(gameChatId, new AbortController());
store().setStreamBuffer("The tavern goes quiet. Alice beams.", gameChatId);
t += 16;
assert.equal(game.frame("alice", t).state, "thinking", "Game characters think until the first line shows");
publishAvatarGameLine("other-chat", { id: "x", type: "dialogue", speaker: "Alice", sprite: "happy", content: "Hi" });
publishAvatarGameLine(gameChatId, { id: "n1", type: "narration", content: "The fire crackles." });
t += 16;
assert.equal(game.frame("alice", t).emotion, "neutral", "other chats and narration lines do not reach avatars");
publishAvatarGameLine(gameChatId, {
  id: "s1",
  type: "dialogue",
  speaker: "Alice",
  sprite: "furious_glare",
  content: "Get out of my tavern!",
});
t += 16;
let gameFrame = game.frame("alice", t);
assert.deepEqual([gameFrame.emotion, gameFrame.label], ["angry", "furious_glare"], "the line's expression is the face");
t += 200;
gameFrame = game.frame("alice", t);
assert.equal(gameFrame.state, "talking", "the line is spoken");
assert.equal(game.frame("me", t).state, "listening");
store().setAbortController(gameChatId, null);
game.dispose();
await flush();

console.log("avatar director regression passed");
