// ──────────────────────────────────────────────
// A world's edit layer (worldgen W9c): the hand edits kept with a world, applied after its seeded
// compile so every reader of the world (the Game Master's prompt, the World tab, the overworld, towns,
// the atlas) sees the edited world. A world stays its seed, kit and brief plus this small layer: the
// ground painted cell by cell, compiled places renamed or moved, places added, drawn people renamed,
// people added, tactical boards painted for places (W9g), and towns laid out by hand (W9h). Nothing
// compiled is removed.
//
// A layer is checked strictly when it is saved (an unknown place, a cell off the map, a name another
// place has is refused with the reason), and again when its world is read: one that does not fit (written
// around the editor's route) is not applied at all, so a stored layer never makes a world unreadable or
// breaks what the check keeps (one name per place).
// ──────────────────────────────────────────────
import { z } from "zod";
import type { WorldKit } from "../../schemas/world-kit.schema.js";
import { promptSafeText } from "../../schemas/ruleset.schema.js";
import { compileLinks, worldTerrainEntries, type CompiledWorld, type WorldPlace } from "./compile.js";
import { WORLD_BATTLEFIELDS_MAX, worldBattlefieldIssues, worldBattlefieldMapSchema } from "./battlefield-maps.js";

/** The most places a layer adds, people it renames or adds, and compiled places it changes. */
export const WORLD_EDITS_MAX_ADDED = 200;
export const WORLD_EDITS_MAX_PEOPLE = 500;
/** The largest ground a world has (the world scale's 96 by 64 cells). */
const MAX_CELLS = 96 * 64;

const ref = z.string().max(40);
const placeId = z.string().min(1).max(16);
const placeName = promptSafeText(60).refine((value) => value.trim().length > 0, "A name needs more than spaces");
const personName = promptSafeText(40).refine((value) => value.trim().length > 0, "A name needs more than spaces");
const cell = z.object({ x: z.number().int().min(0).max(255), y: z.number().int().min(0).max(255) }).strict();

export const worldEditsSchema = z
  .object({
    editsVersion: z.literal(1),
    /** The ground as painted: one character per cell, "." where it is as compiled, else the base-36
     *  index of a kit terrain class. */
    ground: z
      .string()
      .max(MAX_CELLS)
      .regex(/^[.0-9a-z]*$/, "The painted ground is one of . 0-9 a-z per cell")
      .optional(),
    /** Compiled places renamed or moved. */
    places: z
      .array(z.object({ id: placeId, name: placeName.optional(), at: cell.optional() }).strict())
      .max(WORLD_EDITS_MAX_PEOPLE)
      .optional(),
    /** Places added by hand: `e<n>` ids, in the order they were added (a place's parent before it). */
    added: z
      .array(
        z
          .object({
            id: z.string().regex(/^e\d{1,4}$/, "An added place's id is e and a number"),
            name: placeName,
            layer: ref,
            parentId: placeId.optional(),
            at: cell,
            size: ref.optional(),
            tags: z.array(ref).max(4).optional(),
            note: promptSafeText(240).optional(),
          })
          .strict(),
      )
      .max(WORLD_EDITS_MAX_ADDED)
      .optional(),
    /** Drawn people renamed, by id (`<placeId>-<n>`). */
    people: z
      .array(z.object({ id: z.string().min(1).max(24), name: personName }).strict())
      .max(WORLD_EDITS_MAX_PEOPLE)
      .optional(),
    /** People added by hand to a place: `<placeId>-e<n>` ids. */
    addedPeople: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-z0-9]{1,16}-e\d{1,4}$/, "An added person's id is the place's id, -e and a number"),
            placeId,
            name: personName,
            role: promptSafeText(40).optional(),
          })
          .strict(),
      )
      .max(WORLD_EDITS_MAX_PEOPLE)
      .optional(),
    /** Tactical boards painted for places (worldgen W9g): `b<n>` ids. */
    battlefields: z.array(worldBattlefieldMapSchema).max(WORLD_BATTLEFIELDS_MAX).optional(),
    /** Towns laid out by hand (worldgen W9h): buildings moved between the town's lots (a lot by its
     *  top-left corner and its width, as two lots can share a corner), in turn, and its ground painted: "." as laid out, else s street, q square, o open ground, t a
     *  tree, w a well. Checked against the town when saved (`worldTownEditIssues`). */
    towns: z
      .array(
        z
          .object({
            settlement: placeId,
            moves: z
              .array(
                z
                  .object({
                    building: z.string().min(1).max(16),
                    x: z.number().int().min(0).max(255),
                    y: z.number().int().min(0).max(255),
                    w: z.number().int().min(1).max(16),
                  })
                  .strict(),
              )
              .max(WORLD_EDITS_MAX_PEOPLE)
              .optional(),
            ground: z
              .string()
              // The biggest town, a city's 52 by 36 cells.
              .max(52 * 36)
              .regex(/^[.sqotw]*$/, "A town's painted ground is one of . s q o t w per cell")
              .optional(),
          })
          .strict(),
      )
      .max(WORLD_EDITS_MAX_ADDED)
      .optional(),
  })
  .strict();
export type WorldEdits = z.infer<typeof worldEditsSchema>;
export type WorldEditsInput = z.input<typeof worldEditsSchema>;

/** True for a person added by hand (`<placeId>-e<n>`); drawn people are `<placeId>-<n>`. */
export const worldPersonByHand = (id: string) => /-e\d+$/.test(id);

/** True when a layer changes nothing. */
export function worldEditsEmpty(edits: WorldEdits | null | undefined): boolean {
  return (
    !edits ||
    (!edits.ground?.replace(/\./g, "") &&
      !edits.places?.length &&
      !edits.added?.length &&
      !edits.people?.length &&
      !edits.addedPeople?.length &&
      !edits.battlefields?.length &&
      !edits.towns?.length)
  );
}

const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Why a layer cannot be kept with this world, or nothing when it can: checked against the world as
 * compiled, before any edit. Drawn people are checked by their id's place and number, since they are
 * drawn rather than stored.
 */
export function checkWorldEdits(
  kit: WorldKit,
  world: CompiledWorld,
  edits: WorldEdits,
  castSize: (place: WorldPlace) => number,
): string[] {
  const issues: string[] = [];
  const inside = (at: { x: number; y: number }) => at.x < world.width && at.y < world.height;
  if (edits.ground !== undefined && edits.ground.length > 0) {
    if (edits.ground.length !== world.width * world.height) {
      issues.push(`The painted ground has ${edits.ground.length} cells; this world has ${world.width * world.height}.`);
    } else if ([...edits.ground].some((char) => char !== "." && parseInt(char, 36) >= world.terrain.length)) {
      issues.push("The painted ground uses a terrain this world's kit does not have.");
    }
  }
  const byId = new Map(world.places.map((place) => [place.id, place]));
  const names = new Map(world.places.map((place) => [place.id, place.name]));
  const seen = new Set<string>();
  for (const edit of edits.places ?? []) {
    if (!byId.has(edit.id)) issues.push(`No place "${edit.id}" to change.`);
    else if (seen.has(edit.id)) issues.push(`Place "${edit.id}" is changed twice.`);
    seen.add(edit.id);
    if (edit.at && !inside(edit.at)) issues.push(`Place "${edit.id}" is moved off the map.`);
    if (edit.name) names.set(edit.id, edit.name.trim());
  }
  const settlementsDepth = kit.layers.findIndex((layer) => layer.settlements);
  const added = new Map<string, { depth: number }>();
  for (const add of edits.added ?? []) {
    const depth = kit.layers.findIndex((layer) => layer.id === add.layer);
    const parent = add.parentId ? (byId.get(add.parentId) ?? added.get(add.parentId)) : undefined;
    if (byId.has(add.id) || added.has(add.id)) issues.push(`Place "${add.id}" is added twice.`);
    if (depth < 0) issues.push(`"${add.name}": no layer "${add.layer}" in this kit.`);
    else if (depth === 0 && add.parentId) issues.push(`"${add.name}": a place in the outermost layer has no parent.`);
    else if (depth > 0 && parent?.depth !== depth - 1) {
      issues.push(`"${add.name}": its parent must be a place one layer out.`);
    }
    if (!inside(add.at)) issues.push(`"${add.name}" is off the map.`);
    if (add.size !== undefined && (depth !== settlementsDepth || !kit.sizes.some((size) => size.id === add.size))) {
      issues.push(`"${add.name}": "${add.size}" is not a settlement size of this kit.`);
    }
    for (const tag of add.tags ?? []) {
      if (!kit.placeTags.some((entry) => entry.id === tag)) issues.push(`"${add.name}": no place tag "${tag}".`);
    }
    names.set(add.id, add.name.trim());
    if (depth >= 0) added.set(add.id, { depth });
  }
  // Every place keeps a name of its own: the Game Master and the ledger find places by name.
  const taken = new Map<string, string>();
  // A renamed place still answers to its old name, so no other place may take it.
  for (const edit of edits.places ?? []) {
    const original = byId.get(edit.id);
    if (edit.name && original && nameKey(edit.name) !== nameKey(original.name)) {
      taken.set(nameKey(original.name), edit.id);
    }
  }
  for (const [id, name] of names) {
    const key = nameKey(name);
    if (taken.has(key) && taken.get(key) !== id) issues.push(`Two places would be called "${name}".`);
    taken.set(key, id);
  }
  const peopleSeen = new Set<string>();
  for (const edit of edits.people ?? []) {
    const match = /^(.+)-(\d+)$/.exec(edit.id);
    const place = match ? byId.get(match[1]!) : undefined;
    if (!match || !place || Number(match[2]) < 1 || Number(match[2]) > castSize(place)) {
      issues.push(`No person "${edit.id}" to rename.`);
    }
    if (peopleSeen.has(edit.id)) issues.push(`Person "${edit.id}" is renamed twice.`);
    peopleSeen.add(edit.id);
  }
  for (const person of edits.addedPeople ?? []) {
    const place = byId.get(person.placeId) ?? added.get(person.placeId);
    if (!place) issues.push(`"${person.name}": no place "${person.placeId}".`);
    else if (place.depth < settlementsDepth)
      issues.push(`"${person.name}": people live in a settlement or in a place inside one.`);
    if (!person.id.startsWith(`${person.placeId}-e`))
      issues.push(`"${person.name}": the id must start with its place's.`);
    if (peopleSeen.has(person.id)) issues.push(`Person "${person.id}" is added twice.`);
    peopleSeen.add(person.id);
  }
  const battlefieldsSeen = new Set<string>();
  for (const map of edits.battlefields ?? []) {
    if (!byId.has(map.place) && !added.has(map.place)) issues.push(`"${map.name}": no place "${map.place}".`);
    if (battlefieldsSeen.has(map.id)) issues.push(`Battlefield "${map.id}" is given twice.`);
    battlefieldsSeen.add(map.id);
    for (const issue of worldBattlefieldIssues(map)) issues.push(`"${map.name}": ${issue}`);
  }
  return [...new Set(issues)].slice(0, 20);
}

/** The world with its edit layer applied: anything that no longer fits is skipped. */
export function applyWorldEdits(
  kit: WorldKit,
  world: CompiledWorld,
  edits: WorldEdits | null | undefined,
): CompiledWorld {
  if (worldEditsEmpty(edits)) return world;
  const { width } = world;
  const inside = (at: { x: number; y: number }) => at.x >= 0 && at.y >= 0 && at.x < width && at.y < world.height;
  let ground = world.ground;
  if (edits!.ground && edits!.ground.length === ground.length) {
    ground = Array.from(ground, (compiled, index) => {
      const painted = edits!.ground![index]!;
      return painted === "." || parseInt(painted, 36) >= world.terrain.length ? compiled : painted;
    }).join("");
  }
  let relink = ground !== world.ground;

  const places = world.places.map((place) => ({ ...place }));
  const byId = new Map(places.map((place) => [place.id, place]));
  for (const edit of edits!.places ?? []) {
    const place = byId.get(edit.id);
    if (!place) continue;
    const name = edit.name?.trim();
    if (name && name !== place.name) {
      place.aliases = [...(place.aliases ?? []), place.name];
      place.name = name;
    }
    if (edit.at && inside(edit.at) && (edit.at.x !== place.at.x || edit.at.y !== place.at.y)) {
      place.at = { x: edit.at.x, y: edit.at.y };
      relink = true;
    }
  }
  const settlementsDepth = kit.layers.findIndex((layer) => layer.settlements);
  for (const add of edits!.added ?? []) {
    const depth = kit.layers.findIndex((layer) => layer.id === add.layer);
    const parent = add.parentId ? byId.get(add.parentId) : undefined;
    if (depth < 0 || byId.has(add.id) || !inside(add.at)) continue;
    if (depth === 0 ? add.parentId : parent?.depth !== depth - 1) continue;
    const settlement = depth === settlementsDepth;
    const rank = Math.max(
      0,
      kit.sizes.findIndex((size) => size.id === add.size),
    );
    const place: WorldPlace = {
      id: add.id,
      name: add.name.trim(),
      layer: add.layer,
      depth,
      parentId: parent?.id ?? null,
      at: { x: add.at.x, y: add.at.y },
      culture: parent?.culture ?? kit.cultures[0]?.id ?? world.places[0]?.culture ?? "",
      ...(settlement ? { size: kit.sizes[rank]!.id, rank, prosperity: "modest" as const } : {}),
      tags: [...(add.tags ?? [])],
      ...(add.note ? { note: add.note } : {}),
      named: true,
      byHand: true,
    };
    places.push(place);
    byId.set(place.id, place);
    if (settlement) relink = true;
  }

  const terrain = worldTerrainEntries(kit);
  const links = relink
    ? compileLinks(
        kit,
        Uint8Array.from(ground, (char) => parseInt(char, 36)),
        world.terrain.map((id) => terrain.find((entry) => entry.id === id) ?? { kind: "open" }),
        width,
        places.filter((place) => place.depth === settlementsDepth),
      )
    : world.links;
  return { ...world, ground, places, links };
}

/** The world's place a name is, by its name or a name it went by, ignoring case and spacing. */
export function worldPlaceNamed<T extends { name: string; aliases?: string[] }>(
  places: readonly T[],
  name: string | undefined,
): T | undefined {
  if (!name) return undefined;
  const key = nameKey(name);
  return (
    places.find((place) => nameKey(place.name) === key) ??
    places.find((place) => place.aliases?.some((alias) => nameKey(alias) === key))
  );
}
