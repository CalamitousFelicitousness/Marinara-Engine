import type { GameNpc } from "@marinara-engine/shared";

export const BUILT_IN_MARI_AVATAR = "/sprites/mari/Mari_profile.png";

const CHARACTER_NAME_LEADING_PREFIX_WORDS = new Set([
  "a",
  "an",
  "the",
  "il",
  "lo",
  "la",
  "le",
  "l",
  "el",
  "sir",
  "lady",
  "lord",
  "professor",
  "old",
  "young",
  "elder",
  "great",
  "captain",
]);

export function normalizeAvatarLookupName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function nameLookupWithoutLeadingPrefix(normalizedName: string): string {
  const words = normalizedName.split(/\s+/).filter(Boolean);
  return words.length > 1 && CHARACTER_NAME_LEADING_PREFIX_WORDS.has(words[0]!)
    ? words.slice(1).join(" ")
    : normalizedName;
}

function avatarLookupAliases(value: string): string[] {
  const normalized = normalizeAvatarLookupName(value);
  const words = normalized.split(/\s+/).filter(Boolean);
  const withoutLeadingPrefix = nameLookupWithoutLeadingPrefix(normalized);
  return Array.from(
    new Set([
      value.normalize("NFKC").trim().toLocaleLowerCase(),
      normalized,
      withoutLeadingPrefix,
      ...words.filter((word) => word.length >= 3 && !CHARACTER_NAME_LEADING_PREFIX_WORDS.has(word)),
    ]),
  ).filter(Boolean);
}

export function addNameLookupEntry(map: Map<string, string>, name: unknown, value: unknown): void {
  if (typeof name !== "string" || typeof value !== "string") return;
  const trimmedValue = value.trim();
  if (!trimmedValue) return;
  for (const alias of avatarLookupAliases(name)) map.set(alias, trimmedValue);
}

/** Resolve title and partial-name aliases before creating a replacement portrait. */
export function findCharAvatarFuzzy(npcName: string, charAvatarByName: Map<string, string>): string | undefined {
  const npcAliases = avatarLookupAliases(npcName);
  for (const alias of npcAliases) {
    const exact = charAvatarByName.get(alias);
    if (exact) return exact;
  }

  for (const [charName, avatar] of charAvatarByName) {
    const charAliases = avatarLookupAliases(charName);
    for (const npcAlias of npcAliases) {
      for (const charAlias of charAliases) {
        if (npcAlias === charAlias) return avatar;
        if (charAlias.length >= 3 && npcAlias.includes(charAlias)) return avatar;
        if (npcAlias.length >= 3 && charAlias.includes(npcAlias)) return avatar;
      }
    }
  }
  return undefined;
}

export function npcAvatarSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeNpcName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/'/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMariNpcName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = normalizeNpcName(name);
  return normalized === "mari" || normalized === "professor mari";
}

export function isInvalidBuiltInMariNpcAvatar(npc: Pick<GameNpc, "name" | "avatarUrl">): boolean {
  const avatarPath = typeof npc.avatarUrl === "string" ? npc.avatarUrl.split("?")[0] : "";
  return avatarPath === BUILT_IN_MARI_AVATAR && !isMariNpcName(npc.name);
}

export function sanitizeGameNpcAvatarUrls(npcs: GameNpc[]): GameNpc[] {
  let changed = false;
  const sanitized = npcs.map((npc) => {
    const { met: _met, ...withoutMet } = npc as GameNpc & { met?: unknown };
    const hasLegacyMet = "met" in npc;
    if (!isInvalidBuiltInMariNpcAvatar(withoutMet)) {
      if (hasLegacyMet) changed = true;
      return withoutMet;
    }
    changed = true;
    const { avatarUrl: _avatarUrl, ...rest } = withoutMet;
    return rest;
  });
  return changed ? sanitized : npcs;
}
