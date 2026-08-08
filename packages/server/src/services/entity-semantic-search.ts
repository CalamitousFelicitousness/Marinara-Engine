// Tiered entity resolution for Professor Mari's [fetch:] (#4768 phase 2).
//
// Conversation Mari used to resolve a fetch by EXACT normalized name only, so a
// buried "Zander" (past the injected name-list cap) or a fuzzy reference ("the
// vampire guy") went silent. This module resolves a query in tiers — exact name
// → substring over name/description/tags → semantic embedding shortlist — for any
// entity type, driven by a per-type descriptor. It reuses the embed→cosine
// pipeline (embedMemoryRecallTexts + the lorebook calibration helpers) rather
// than inventing a new one.
//
// On a single confident hit it resolves to one entity (Mari auto-opens it). On a
// weak or ambiguous match it returns a ranked candidate LIST so Mari can ask the
// user which one — never a silent wrong guess.
import { normalizeTextForMatch } from "@marinara-engine/shared";
import { logger } from "../lib/logger.js";
import { localEmbed } from "./local-embedder.js";
import { calibrateLorebookSimilarity, cosineSimilarity, lorebookSimilarityBaseline } from "./lorebook/embeddings.js";
import { embedMemoryRecallTexts, type MemoryRecallEmbeddingOptions } from "./memory-recall.js";

export type EntitySearchType = "character" | "persona" | "lorebook" | "chat" | "preset";

/** A resolvable entity, projected to just what tiered resolution needs. */
export interface EntityCandidate {
  id: string;
  name: string;
  /** Concatenated searchable text (name/description/tags/…) for substring + embedding. */
  embedText: string;
  /** Persisted vector, or null when not yet computed (then embedded on the fly). */
  embedding: number[] | null;
  /** Short human-readable descriptor shown in a disambiguation list. */
  blurb: string;
}

export interface EntityDescriptor {
  type: EntitySearchType;
  /** Resolve every entity of this type into a candidate (parses blobs, hydrates embeddings). */
  listAll(): Promise<EntityCandidate[]>;
  /**
   * Narrow, embedding-only persisted setter (bypasses the entity's normal
   * update() so no version snapshot / JSON merge / recency bump fires). Absent
   * ⇒ this type is not persisted and is embedded on the fly each search.
   */
  updateEmbedding?(id: string, vector: number[] | null): Promise<void>;
}

export type EntityResolution =
  | { kind: "single"; candidate: EntityCandidate }
  | { kind: "candidates"; candidates: EntityCandidate[] }
  | { kind: "none" };

export interface EntityResolveOptions extends MemoryRecallEmbeddingOptions {
  /**
   * Whether the semantic tier may run (gate on isMemoryRecallVectorizerAvailable
   * upstream). When false, resolution degrades to exact + substring only.
   */
  vectorizerAvailable?: boolean;
  /** Max entries in a candidate list. */
  topK?: number;
}

// Calibrated-cosine thresholds for the semantic tier. Deliberately unrelated
// calibration texts (below) estimate the model's cosine floor so these operate
// on a normalized 0–1 scale; the auto-open bar is intentionally conservative so
// an uncertain match becomes a disambiguation list rather than a wrong open.
const AUTO_OPEN_MIN_SIMILARITY = 0.55;
const AUTO_OPEN_MIN_MARGIN = 0.1;
// Below this calibrated similarity a "match" is noise — better to report nothing
// than to offer five irrelevant guesses.
const CANDIDATE_MIN_SIMILARITY = 0.15;
const DEFAULT_CANDIDATE_TOP_K = 5;
const WARMUP_BATCH_SIZE = 64;

// Unrelated sentences used to estimate (and subtract) the embedding model's
// common cosine floor — same technique as the lorebook semantic path.
const SEMANTIC_CALIBRATION_TEXTS = [
  "A recipe explains how to bake a loaf of bread.",
  "A spacecraft studies distant galaxies and nebulae.",
  "A city council reviews municipal zoning regulations.",
] as const;

function embedTexts(texts: string[], options: EntityResolveOptions): Promise<number[][]> {
  return embedMemoryRecallTexts(texts, {
    embeddingSource: options.embeddingSource,
    localEmbedder: options.localEmbedder ?? localEmbed,
    signal: options.signal,
  });
}

function normalizeTopK(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CANDIDATE_TOP_K;
  return Math.min(25, Math.trunc(parsed));
}

/**
 * Backfill missing persisted embeddings for a candidate pool. No-op when the
 * descriptor has no persisted column (embed-on-the-fly types) or the embedder is
 * unavailable. Skips a whole batch if the embedding dimension drifted (a changed
 * embedding model), mirroring the lorebook warmup guard.
 */
export async function warmEntityEmbeddings(
  descriptor: EntityDescriptor,
  pool: EntityCandidate[],
  options: EntityResolveOptions,
): Promise<{ attempted: number; embedded: number }> {
  if (!descriptor.updateEmbedding) return { attempted: 0, embedded: 0 };
  const missing = pool.filter((c) => !c.embedding || c.embedding.length === 0).slice(0, WARMUP_BATCH_SIZE);
  if (missing.length === 0) return { attempted: 0, embedded: 0 };

  const embeddings = await embedTexts(
    missing.map((c) => c.embedText),
    options,
  );
  if (embeddings.length === 0) return { attempted: missing.length, embedded: 0 };

  const newDimension = embeddings.find((e) => e.length > 0)?.length ?? null;
  const existingDimension = pool.find((c) => c.embedding && c.embedding.length > 0)?.embedding?.length ?? null;
  if (newDimension && existingDimension && newDimension !== existingDimension) {
    logger.warn(
      "[entity-search] Skipping %s embedding warmup: dimension changed %d → %d. Refresh embeddings after changing embedding models.",
      descriptor.type,
      existingDimension,
      newDimension,
    );
    return { attempted: missing.length, embedded: 0 };
  }

  let embedded = 0;
  for (let i = 0; i < missing.length; i += 1) {
    const vector = embeddings[i];
    if (!vector || vector.length === 0) continue;
    await descriptor.updateEmbedding(missing[i]!.id, vector);
    missing[i]!.embedding = vector;
    embedded += 1;
  }
  if (embedded > 0) logger.debug("[entity-search] Warmed %d/%d %s embedding(s)", embedded, missing.length, descriptor.type);
  return { attempted: missing.length, embedded };
}

/**
 * Rank a candidate pool by calibrated cosine similarity to the query. Returns
 * null when the embedder is unavailable (empty query embedding) so the caller
 * degrades to substring. Candidates still lacking a persisted vector are embedded
 * on the fly, so this works for both persisted and on-the-fly descriptors.
 */
export async function shortlistEntities(
  descriptor: EntityDescriptor,
  query: string,
  pool: EntityCandidate[],
  options: EntityResolveOptions,
): Promise<Array<{ candidate: EntityCandidate; similarity: number }> | null> {
  if (pool.length === 0) return null;
  await warmEntityEmbeddings(descriptor, pool, options);

  const queryEmbeddings = await embedTexts([query, ...SEMANTIC_CALIBRATION_TEXTS], options);
  const queryEmbedding = queryEmbeddings[0];
  if (!queryEmbedding || queryEmbedding.length === 0) return null; // embedder unavailable
  const baseline = lorebookSimilarityBaseline(queryEmbeddings.slice(1));

  // Any candidate still without a stored vector (no persisted column, or warmup
  // declined) gets embedded on the fly so the whole pool is rankable.
  const unembedded = pool.filter((c) => !c.embedding || c.embedding.length === 0);
  if (unembedded.length > 0) {
    const fresh = await embedTexts(
      unembedded.map((c) => c.embedText),
      options,
    );
    unembedded.forEach((candidate, i) => {
      const vector = fresh[i];
      if (vector && vector.length > 0) candidate.embedding = vector;
    });
  }

  let dimensionWarned = false;
  const ranked = pool
    .map((candidate) => {
      const embedding = candidate.embedding;
      if (!embedding || embedding.length === 0) return null;
      if (embedding.length !== queryEmbedding.length) {
        if (!dimensionWarned) {
          dimensionWarned = true;
          logger.warn(
            "[entity-search] Skipping %s candidate(s) whose embedding dimension (%d) differs from the query (%d).",
            descriptor.type,
            embedding.length,
            queryEmbedding.length,
          );
        }
        return null;
      }
      return {
        candidate,
        similarity: calibrateLorebookSimilarity(cosineSimilarity(queryEmbedding, embedding), baseline),
      };
    })
    .filter((match): match is { candidate: EntityCandidate; similarity: number } => match !== null)
    .sort((a, b) => b.similarity - a.similarity);

  return ranked.length > 0 ? ranked : null;
}

/**
 * Resolve a fetch query to a single entity or a candidate list, in tiers:
 *  1. exact normalized name (preserves the original fetch behavior),
 *  2. substring over name/description/tags,
 *  3. semantic embedding shortlist (gated on vectorizerAvailable).
 * Auto-opens only a single confident hit; otherwise returns candidates.
 */
export async function tieredResolveEntity(
  descriptor: EntityDescriptor,
  query: string,
  options: EntityResolveOptions = {},
): Promise<EntityResolution> {
  const trimmed = query.trim();
  if (!trimmed) return { kind: "none" };
  const candidates = await descriptor.listAll();
  if (candidates.length === 0) return { kind: "none" };

  const topK = normalizeTopK(options.topK);
  const normalizedQuery = normalizeTextForMatch(trimmed);

  // Tier 1 — exact normalized name. One match auto-opens (unchanged behavior);
  // several identically-named entities disambiguate.
  const exactMatches = candidates.filter((c) => normalizeTextForMatch(c.name) === normalizedQuery);
  if (exactMatches.length === 1) return { kind: "single", candidate: exactMatches[0]! };
  if (exactMatches.length > 1) return { kind: "candidates", candidates: exactMatches.slice(0, topK) };

  // Tier 2 — substring over the searchable text. A single hit auto-opens.
  const lowerQuery = trimmed.toLowerCase();
  const substringMatches = candidates.filter(
    (c) => c.name.toLowerCase().includes(lowerQuery) || c.embedText.toLowerCase().includes(lowerQuery),
  );
  if (substringMatches.length === 1) return { kind: "single", candidate: substringMatches[0]! };

  // Tier 3 — semantic. Rank the substring survivors when there are any (cheap,
  // precise), else the whole set (the pure-paraphrase case).
  const pool = substringMatches.length > 0 ? substringMatches : candidates;
  if (options.vectorizerAvailable !== false) {
    const ranked = await shortlistEntities(descriptor, trimmed, pool, options);
    const relevant = (ranked ?? []).filter((r) => r.similarity >= CANDIDATE_MIN_SIMILARITY);
    if (relevant.length > 0) {
      const top = relevant[0]!;
      const margin = relevant[1] ? top.similarity - relevant[1].similarity : top.similarity;
      if (top.similarity >= AUTO_OPEN_MIN_SIMILARITY && margin >= AUTO_OPEN_MIN_MARGIN) {
        return { kind: "single", candidate: top.candidate };
      }
      return { kind: "candidates", candidates: relevant.slice(0, topK).map((r) => r.candidate) };
    }
  }

  // Degrade (semantic unavailable): surface substring survivors for the user to pick.
  if (substringMatches.length > 1) return { kind: "candidates", candidates: substringMatches.slice(0, topK) };
  return { kind: "none" };
}

export const ENTITY_SEARCH_TUNING = {
  AUTO_OPEN_MIN_SIMILARITY,
  AUTO_OPEN_MIN_MARGIN,
  DEFAULT_CANDIDATE_TOP_K,
} as const;
