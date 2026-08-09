import { PROFESSOR_MARI_ID } from "@marinara-engine/shared";

import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { MARI_ASSISTANT_PROMPT } from "../../db/seed-mari.js";
import { createEntityEmbeddingStore } from "../../services/entity-embedding-store.js";
import type { EntitySearchType } from "../../services/entity-semantic-search.js";
import { localEmbed } from "../../services/local-embedder.js";
import { cosineSimilarity } from "../../services/lorebook/embeddings.js";
import { embedMemoryRecallTexts, type MemoryRecallEmbeddingSource } from "../../services/memory-recall.js";

type ProfessorMariCharactersStore = {
  list(): Promise<Array<{ id?: string | null; data?: unknown }>>;
  listPersonas(): Promise<Array<{ name?: unknown }>>;
};

type NamedListStore = {
  list(): Promise<unknown[]>;
};

// When the conversation can be embedded, the name lists are ranked by relevance
// to it and trimmed to a small top-K — the entities that matter *now* — instead
// of an arbitrary alphabetical slice, which is both cheaper and more useful on a
// large library. This runs only on the volatile tail (so it never churns the
// cached system prefix), embeds ONLY the conversation query per turn (never the
// entities — those are the persisted store's vectors), and degrades to the
// alphabetical list below when the embedder is unavailable or cold.
const MAX_MARI_RELEVANT_NAMES_PER_TYPE = 12;
const MARI_RELEVANCE_TYPES: EntitySearchType[] = ["character", "persona", "lorebook", "chat", "preset"];

// Per-category cap on the <available_names> reference lists. Bounds the token
// noise on large libraries and — together with the deterministic sort below —
// keeps the block byte-stable across turns so it no longer churns the prompt
// prefix (and, with caching enabled, the cache). A code constant, mirroring
// MAX_MARI_FETCHED_PRESET_CONTEXT_CHARS; not a user setting. Fetching still
// works for any exact name even when it is beyond the cap (see <data_access>).
export const MAX_MARI_AVAILABLE_NAMES_PER_TYPE = 100;

// Lexicographic UTF-16 code-unit order (JS string relational comparison), not
// localeCompare: spec-defined and ICU-independent, so the emitted block is
// byte-identical across Node builds (small-icu vs full-icu). That determinism
// is the whole point — it keeps the block stable and the regression pin
// reliable — and it does not depend on true codepoint ordering.
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asName(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Dedupe → sort (deterministic) → cap. Only the set of distinct names and the
// rename of one changes the output; merely touching an item (updatedAt bump)
// no longer reorders it, because we sort by name rather than trust store order.
function buildNameSection(type: string, rawNames: Array<string | null>): string | null {
  const unique = Array.from(new Set(rawNames.filter((name): name is string => name !== null)));
  if (unique.length === 0) return null;
  unique.sort(compareCodeUnit);

  const shown = unique.slice(0, MAX_MARI_AVAILABLE_NAMES_PER_TYPE);
  const overflow = unique.length - shown.length;
  const lines = [shown.join(", ")];
  if (overflow > 0) {
    lines.push(
      `…and ${overflow} more not listed — you can still fetch any of them by exact name if the user names one.`,
    );
  }
  return `<available_names type="${type}">\n${lines.join("\n")}\n</available_names>`;
}

// Emit names in a caller-provided order (relevance rank), deduped and capped to a
// small top-K, with an overflow hint that points at fetch for the long tail.
function buildRankedNameSection(type: string, orderedNames: string[], totalCount: number): string | null {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of orderedNames) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  if (unique.length === 0) return null;
  const shown = unique.slice(0, MAX_MARI_RELEVANT_NAMES_PER_TYPE);
  const overflow = totalCount - shown.length;
  const lines = [shown.join(", ")];
  if (overflow > 0) {
    lines.push(
      `…and ${overflow} more not shown (these are ranked by relevance to this conversation) — fetch any item by name or description.`,
    );
  }
  return `<available_names type="${type}">\n${lines.join("\n")}\n</available_names>`;
}

// Rank each type's entities by cosine similarity of their stored embedding to the
// conversation query. Embeds ONLY the query (one call); entities are never
// embedded here — unranked (not-yet-warmed or wrong-dimension) ones sort last so
// warm relevant items lead. Returns null (→ alphabetical fallback) when the
// embedder is unavailable.
async function buildRelevanceRankedSections(
  db: DB,
  queryText: string,
  embeddingSource: MemoryRecallEmbeddingSource | null | undefined,
): Promise<string[] | null> {
  try {
    const sourceId = embeddingSource?.spaceId ?? embeddingSource?.label ?? "local";
    const store = createEntityEmbeddingStore(db, sourceId);
    const [queryEmbedding] = await embedMemoryRecallTexts([queryText], { embeddingSource, localEmbedder: localEmbed });
    if (!queryEmbedding || queryEmbedding.length === 0) return null; // unavailable ⇒ fall back

    const sections: string[] = [];
    for (const type of MARI_RELEVANCE_TYPES) {
      const candidates = await store.listCandidates(type);
      if (candidates.length === 0) continue;
      const ordered = candidates
        .map((candidate) => ({
          name: candidate.name,
          score:
            candidate.embedding && candidate.embedding.length === queryEmbedding.length
              ? cosineSimilarity(queryEmbedding, candidate.embedding)
              : -1,
        }))
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.name);
      const section = buildRankedNameSection(type, ordered, candidates.length);
      if (section) sections.push(section);
    }
    return sections.length > 0 ? sections : null;
  } catch (err) {
    logger.warn(err, "[mari-prompt] relevance ranking failed; falling back to alphabetical names");
    return null;
  }
}

/**
 * Builds Professor Mari's Home-assistant prompt context, split into two halves:
 *
 * - `stablePrompt`: the invariant instruction block (MARI_ASSISTANT_PROMPT).
 *   The caller appends this to the system message.
 * - `volatileContext`: the `<available_names>` reference lists plus any
 *   `<loaded_context>` fetched data. The caller injects this as a tail
 *   user-role message (contextKind "injection") so a change to the library or
 *   a `[fetch:]` no longer invalidates the static system prefix.
 */
export async function resolveProfessorMariPromptContext(args: {
  chatMeta: Record<string, unknown>;
  chars: ProfessorMariCharactersStore;
  lorebooksStore: NamedListStore;
  chats: NamedListStore;
  presets: NamedListStore;
  /** Enables relevance ranking (all four are needed; otherwise the list is alphabetical). */
  db?: DB;
  queryText?: string;
  embeddingSource?: MemoryRecallEmbeddingSource | null;
  vectorizerAvailable?: boolean;
}): Promise<{ stablePrompt: string; volatileContext: string }> {
  const volatileSections: string[] = [];

  // Preferred path: rank the lists by relevance to the conversation. Falls
  // through to the alphabetical list when ranking is disabled/unavailable.
  let namesSections: string[] | null = null;
  if (args.db && args.vectorizerAvailable && args.queryText?.trim()) {
    namesSections = await buildRelevanceRankedSections(args.db, args.queryText, args.embeddingSource);
  }

  if (!namesSections) {
    try {
      const allChars = await args.chars.list();
      const allPersonasList = await args.chars.listPersonas();
      const allLorebooks = await args.lorebooksStore.list();
      const allChats = await args.chats.list();
      const allPresets = await args.presets.list();

      const charNames = allChars
        .filter((c) => c.id !== PROFESSOR_MARI_ID)
        .map((c) => {
          try {
            const d = typeof c.data === "string" ? JSON.parse(c.data) : c.data;
            return asName(d?.name);
          } catch {
            return null;
          }
        });

      const personaNames = allPersonasList.map((p) => asName(p.name));
      const lorebookNames = allLorebooks.map((row) => asName((row as { name?: unknown })?.name));
      const chatNames = allChats.map((row) => asName((row as { name?: unknown })?.name));
      const presetNames = allPresets.map((row) => asName((row as { name?: unknown })?.name));

      namesSections = [
        buildNameSection("character", charNames),
        buildNameSection("persona", personaNames),
        buildNameSection("lorebook", lorebookNames),
        buildNameSection("chat", chatNames),
        buildNameSection("preset", presetNames),
      ].filter((section): section is string => section !== null);
    } catch {
      // Non-critical: continue without name lists.
      namesSections = null;
    }
  }

  if (namesSections && namesSections.length > 0) volatileSections.push(namesSections.join("\n\n"));

  const mariContext = args.chatMeta.mariContext as Record<string, string> | undefined;
  if (mariContext && Object.keys(mariContext).length > 0) {
    const contextSections: string[] = [];
    for (const [key, value] of Object.entries(mariContext)) {
      contextSections.push(`<fetched_data key="${key}">\n${value}\n</fetched_data>`);
    }
    volatileSections.push(
      "<loaded_context>\nThe following items were previously fetched and are available for reference:\n\n" +
        contextSections.join("\n\n") +
        "\n</loaded_context>",
    );
  }

  return {
    stablePrompt: MARI_ASSISTANT_PROMPT,
    volatileContext: volatileSections.join("\n\n"),
  };
}
