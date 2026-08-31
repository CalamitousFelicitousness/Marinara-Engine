import type { CharacterData } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { characters } from "../../db/schema/index.js";
import { PROFESSOR_MARI_ID } from "@marinara-engine/shared";

export type CharacterCatalogEntry = {
  id: string;
  name: string;
  comment: string;
  creator: string;
  version: string;
  tags: string[];
  favorite: boolean;
  summary: string;
  searchText: string;
  avatarPath: string | null;
  avatarCrop: unknown;
  createdAt: string;
  updatedAt: string;
  data: Partial<CharacterData>;
};

type CatalogOptions = {
  includeBuiltIn?: boolean;
  search?: string;
  sort?: string;
  favoriteFilter?: string;
  limit: number;
  offset: number;
};

type CatalogCache = { generation: number; entries: CharacterCatalogEntry[] };
const caches = new WeakMap<DB, CatalogCache>();

function readData(value: string): CharacterData {
  try {
    return JSON.parse(value) as CharacterData;
  } catch {
    return { name: "Unknown" } as CharacterData;
  }
}

function strings(data: CharacterData, comment: string) {
  const extensions =
    data.extensions && typeof data.extensions === "object" ? (data.extensions as Record<string, unknown>) : {};
  const backstory = typeof extensions.backstory === "string" ? extensions.backstory : "";
  const appearance = typeof extensions.appearance === "string" ? extensions.appearance : "";
  const tags = Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string") : [];
  return {
    tags,
    searchText: [
      data.name,
      comment,
      data.creator,
      data.character_version,
      data.creator_notes,
      data.description,
      data.personality,
      data.scenario,
      data.first_mes,
      backstory,
      appearance,
      ...tags,
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .toLocaleLowerCase(),
  };
}

function entry(row: typeof characters.$inferSelect): CharacterCatalogEntry {
  const data = readData(row.data);
  const { tags, searchText } = strings(data, row.comment ?? "");
  const extensions =
    data.extensions && typeof data.extensions === "object" ? (data.extensions as Record<string, unknown>) : {};
  const summary =
    [data.creator_notes, data.description, data.personality].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ) ?? "";
  return {
    id: row.id,
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Unknown",
    comment: row.comment ?? "",
    creator: typeof data.creator === "string" ? data.creator : "",
    version: typeof data.character_version === "string" ? data.character_version : "",
    tags,
    favorite: extensions.fav === true,
    summary,
    searchText,
    avatarPath: row.avatarPath ?? null,
    avatarCrop: extensions.avatarCrop ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    data: {
      name: data.name,
      description: data.description,
      personality: data.personality,
      scenario: data.scenario,
      first_mes: data.first_mes,
      tags: data.tags,
      creator: data.creator,
      character_version: data.character_version,
      creator_notes: data.creator_notes,
      extensions: data.extensions,
    },
  };
}

function sortEntries(entries: CharacterCatalogEntry[], sort: string) {
  return [...entries].sort((a, b) => {
    if (sort === "favorites") return Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name);
    if (sort === "name-desc") return b.name.localeCompare(a.name) || a.id.localeCompare(b.id);
    if (sort === "name-asc") return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    if (sort === "oldest") return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    if (sort === "newest") return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
    return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  });
}

export function createCharacterCatalog(db: DB) {
  async function getEntries() {
    const cached = caches.get(db);
    const generation = db._fileStore.getTableWriteGeneration("characters");
    if (cached?.generation === generation) return cached.entries;
    const rows = await db.select().from(characters);
    const entries = rows.map(entry);
    const completedGeneration = db._fileStore.getTableWriteGeneration("characters");
    if (completedGeneration !== generation) {
      const freshRows = await db.select().from(characters);
      const freshEntries = freshRows.map(entry);
      caches.set(db, {
        generation: db._fileStore.getTableWriteGeneration("characters"),
        entries: freshEntries,
      });
      return freshEntries;
    }
    caches.set(db, { generation, entries });
    return entries;
  }

  return {
    async list(options: CatalogOptions) {
      let entries = await getEntries();
      if (!options.includeBuiltIn) entries = entries.filter((item) => item.id !== PROFESSOR_MARI_ID);
      const query = options.search?.trim().toLocaleLowerCase();
      if (query) entries = entries.filter((item) => item.searchText.includes(query));
      if (options.favoriteFilter === "favorites") entries = entries.filter((item) => item.favorite);
      if (options.favoriteFilter === "non-favorites") entries = entries.filter((item) => !item.favorite);
      entries = sortEntries(entries, options.sort ?? "");
      const page = entries.slice(options.offset, options.offset + options.limit + 1);
      return {
        items: page.slice(0, options.limit),
        limit: options.limit,
        offset: options.offset,
        hasMore: page.length > options.limit,
      };
    },
  };
}
