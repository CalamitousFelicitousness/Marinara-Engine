import type { CustomTrackerField } from "../types/game-state.js";
import type { CharacterTrackerCustomFieldDefault } from "../types/character.js";

export function formatCustomTrackerFieldForPrompt(field: unknown): string {
  if (!field || typeof field !== "object" || Array.isArray(field)) return "- Field: ";
  const trackerField = field as Partial<CustomTrackerField>;
  const name = typeof trackerField.name === "string" ? trackerField.name : "Field";
  const value = typeof trackerField.value === "string" ? trackerField.value : "";
  const lockLabel = trackerField.locked === true ? " (locked)" : "";
  return `- ${name}: ${value}${lockLabel}`;
}

/**
 * Canonical form for tracker name collisions. Shared by field dedup and the
 * tracker-preset merge so "Outfit" and "outfit " are never two fields.
 */
export function comparableTrackerName(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

/**
 * Layer a tracker preset's entries under a card's own.
 *
 * Preset order defines the layout, so every card shows the same rows in the
 * same places. A card entry with a colliding name replaces the preset entry in
 * place and keeps the preset's slot; card-only entries append after. The preset
 * is therefore additive: nothing a card already configures is lost.
 */
export function mergeTrackerNamedEntries<T extends { name: string }>(
  presetEntries: readonly T[] | null | undefined,
  cardEntries: readonly T[] | null | undefined,
): T[] {
  const preset = Array.isArray(presetEntries) ? presetEntries : [];
  const card = Array.isArray(cardEntries) ? cardEntries : [];
  if (preset.length === 0) return [...card];

  const cardByName = new Map<string, T>();
  for (const entry of card) {
    const key = comparableTrackerName(entry?.name ?? "");
    if (key && !cardByName.has(key)) cardByName.set(key, entry);
  }

  const merged: T[] = [];
  const claimed = new Set<string>();
  for (const entry of preset) {
    const key = comparableTrackerName(entry?.name ?? "");
    if (!key || claimed.has(key)) continue;
    claimed.add(key);
    merged.push(cardByName.get(key) ?? entry);
  }
  for (const entry of card) {
    const key = comparableTrackerName(entry?.name ?? "");
    if (!key || claimed.has(key)) continue;
    claimed.add(key);
    merged.push(entry);
  }
  return merged;
}

export function normalizeCharacterTrackerCustomFieldDefaults(value: unknown): CharacterTrackerCustomFieldDefault[] {
  if (!Array.isArray(value)) return [];

  const fields: CharacterTrackerCustomFieldDefault[] = [];
  const seenNames = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    const comparableName = comparableTrackerName(name);
    if (seenNames.has(comparableName)) continue;
    seenNames.add(comparableName);
    fields.push({
      name,
      value: typeof record.value === "string" ? record.value : record.value == null ? "" : String(record.value),
    });
  }
  return fields;
}

export function characterTrackerCustomFieldDefaultsToRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    normalizeCharacterTrackerCustomFieldDefaults(value).map((field) => [field.name, field.value]),
  );
}
