// ──────────────────────────────────────────────
// Avatar agents: streaming emotion classifier (lane: director)
// ──────────────────────────────────────────────
// Roleplay's expression source while a reply streams. Tiered (AVATAR_CLASSIFIER_TIERS): an instant word
// list, then a small local emotion model when this server can load one (the server already ships
// @huggingface/transformers and onnxruntime-node, like services/local-embedder.ts; prefer a newer,
// multilingual model). Never an LLM, never LLM-written tags, never a Decision model: those run after
// generation and cannot follow the stream. Game mode uses the Game Master's per-line expressions and
// does not call this. Wire debug logging through logDebugOverride / DEBUG_AGENTS.
//
// Contract stub: the director lane fills it in.
import type { AvatarClassifyRequest, AvatarClassifyResponse } from "@marinara-engine/shared";

export interface AvatarClassifierOptions {
  signal?: AbortSignal;
}

export async function classifyAvatarEmotions(
  _request: AvatarClassifyRequest,
  _options: AvatarClassifierOptions = {},
): Promise<AvatarClassifyResponse> {
  throw new Error("The avatar emotion classifier is not available yet");
}
