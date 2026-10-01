// ──────────────────────────────────────────────
// A world's brief (worldgen W1): what exists, written once by the model at setup in the setting kit's
// words, and read by the compile, which decides where everything is. Pixelforge's rule: the model says
// what exists, code says where. Bounded lists and the kit's own ids; a reference the kit does not have
// is dropped with a note rather than trusted.
// ──────────────────────────────────────────────
import { z } from "zod";
import { promptSafeText } from "./ruleset.schema.js";
import type { WorldKit } from "./world-kit.schema.js";

export const WORLD_BRIEF_LIMITS = Object.freeze({ places: 60, names: 160, cultures: 12, allNames: 400 });

const ref = z.string().max(40);
const placeName = promptSafeText(60);

const briefPlace = z
  .object({
    name: placeName,
    /** One of the kit's layers. */
    layer: ref,
    /** The name of the place it lies in, one of this brief's places in an outer layer. */
    parent: placeName.optional(),
    /** One of the kit's sizes, for a place in the settlements layer. */
    size: ref.optional(),
    tags: z.array(ref).max(4).default([]),
    note: promptSafeText(240).optional(),
    /** Where the party starts. */
    start: z.literal(true).optional(),
    /** The lore entries this place comes from (canon), when it was read from the player's lore. */
    lore: z.array(z.string().max(64)).max(20).optional(),
  })
  .strict();

export const worldBriefSchema = z
  .object({
    briefVersion: z.literal(1),
    /** The present day: what is going on as the game begins. */
    premise: promptSafeText(600),
    places: z.array(briefPlace).max(WORLD_BRIEF_LIMITS.places).default([]),
    /** Names for the places the compile draws, per culture, in that culture's own sound. */
    placeNames: z
      .array(z.object({ culture: ref, names: z.array(placeName).max(WORLD_BRIEF_LIMITS.names) }).strict())
      .max(WORLD_BRIEF_LIMITS.cultures)
      .default([])
      .refine((groups) => groups.reduce((sum, group) => sum + group.names.length, 0) <= WORLD_BRIEF_LIMITS.allNames, {
        message: `At most ${WORLD_BRIEF_LIMITS.allNames} place names in all`,
      }),
  })
  .strict();

export type WorldBrief = z.infer<typeof worldBriefSchema>;
export type WorldBriefInput = z.input<typeof worldBriefSchema>;
export type WorldBriefPlace = WorldBrief["places"][number];

/** The deepest layer a brief may place: the settlements layer, and for a world of one site or one
 *  town the layer inside it too, since that town is the whole world. */
export function worldBriefDeepestLayer(kit: WorldKit): number {
  const settlements = kit.layers.findIndex((layer) => layer.settlements);
  return (kit.scale === "site" || kit.scale === "town") && settlements + 1 < kit.layers.length
    ? settlements + 1
    : settlements;
}

/**
 * Reads a brief against its kit: the shape is checked (refused with the reasons when it is wrong), and
 * every reference the kit or the brief does not have is dropped with a note, so one stray tag never
 * costs the player their world.
 */
export function checkWorldBrief(
  kit: WorldKit,
  input: unknown,
): { ok: true; brief: WorldBrief; repairs: string[] } | { ok: false; issues: string[] } {
  const parsed = worldBriefSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "brief"}: ${issue.message}`),
    };
  }
  const repairs: string[] = [];
  const layerAt = new Map(kit.layers.map((layer, index) => [layer.id, index]));
  const settlements = kit.layers.findIndex((layer) => layer.settlements);
  const deepest = worldBriefDeepestLayer(kit);
  const sizes = new Set(kit.sizes.map((size) => size.id));
  const tags = new Set(kit.placeTags.map((tag) => tag.id));
  const cultures = new Set(kit.cultures.map((culture) => culture.id));

  const seen = new Set<string>();
  let started = false;
  const places: WorldBriefPlace[] = [];
  for (const place of parsed.data.places) {
    const key = place.name.toLowerCase();
    const depth = layerAt.get(place.layer);
    if (depth === undefined || depth > deepest) {
      repairs.push(`${place.name}: left out, "${place.layer}" is not a layer a world is made of`);
      continue;
    }
    if (seen.has(key)) {
      repairs.push(`${place.name}: left out, the name is already used`);
      continue;
    }
    seen.add(key);
    const next: WorldBriefPlace = { ...place, tags: place.tags.filter((tag) => tags.has(tag)) };
    if (next.tags.length < place.tags.length) repairs.push(`${place.name}: a tag the kit does not have was left out`);
    if (place.size !== undefined && (depth !== settlements || !sizes.has(place.size))) {
      delete next.size;
      repairs.push(`${place.name}: its size was left out, the compile gives it one`);
    }
    if (place.start) {
      if (started) {
        delete next.start;
        repairs.push(`${place.name}: only the first starting place is kept`);
      }
      started = true;
    }
    places.push(next);
  }
  // Parents are read once every place is known, so a brief may list a town before its province.
  const depthOf = new Map(places.map((place) => [place.name.toLowerCase(), layerAt.get(place.layer)!]));
  for (const place of places) {
    if (place.parent === undefined) continue;
    const parentDepth = depthOf.get(place.parent.toLowerCase());
    if (parentDepth === undefined || parentDepth >= layerAt.get(place.layer)!) {
      repairs.push(`${place.name}: "${place.parent}" is not a place it can lie in, the compile places it`);
      delete place.parent;
    }
  }

  const placeNames: WorldBrief["placeNames"] = [];
  for (const group of parsed.data.placeNames) {
    if (!cultures.has(group.culture)) {
      repairs.push(`placeNames: "${group.culture}" is not one of the kit's cultures`);
      continue;
    }
    const names = [...new Set(group.names.map((name) => name.trim()))].filter(
      (name) => name && !seen.has(name.toLowerCase()),
    );
    placeNames.push({ culture: group.culture, names });
  }
  return { ok: true, brief: { ...parsed.data, places, placeNames }, repairs };
}
