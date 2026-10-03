// ──────────────────────────────────────────────
// A world for a maker (worldgen W9c, W9f, W10): what a world editor draws, a place's people, what a
// story can name, and whether hand edits leave a story whole. Shared by a game's world and a world in
// the library, so a maker edits either the same way.
// ──────────────────────────────────────────────
import {
  STORY_EXPRESSIONS,
  WORLD_DEED_KINDS,
  checkStoryScript,
  compileGameWorld,
  worldCast,
  worldGroundLooks,
  worldKitArtFamily,
  worldPersonByHand,
  worldTerrainEntries,
  worldTown,
  type CompiledWorld,
  type GameWorld,
  type StoryScript,
  type WorldEdits,
} from "@marinara-engine/shared";

/** A world as compiled, in the shape a world editor draws: the ground and its classes (with the look
 *  each is drawn as), the places, and the kit's words for layers, sizes and tags. */
export function worldForEditor(game: GameWorld) {
  const compiled: CompiledWorld = compileGameWorld({ ...game, edits: undefined });
  const looks = worldGroundLooks({ ...game, world: compiled });
  const terrain = worldTerrainEntries(game.kit);
  return {
    width: compiled.width,
    height: compiled.height,
    ground: compiled.ground,
    terrain: compiled.terrain.map((id, index) => {
      const entry = terrain.find((each) => each.id === id);
      return { id, label: entry?.label ?? id, kind: entry?.kind ?? "open", look: looks[index] };
    }),
    places: compiled.places.map((place) => ({
      id: place.id,
      name: place.name,
      layer: place.layer,
      depth: place.depth,
      parentId: place.parentId,
      at: place.at,
      ...(place.size ? { size: place.size, rank: place.rank } : {}),
      tags: place.tags,
    })),
    startId: compiled.startId,
    layers: game.kit.layers.map((layer) => ({
      id: layer.id,
      label: layer.label,
      settlements: Boolean(layer.settlements),
    })),
    sizes: game.kit.sizes.map((size) => ({ id: size.id, label: size.label })),
    placeTags: game.kit.placeTags.map((tag) => ({ id: tag.id, label: tag.label })),
    family: worldKitArtFamily(game.kit) ?? null,
  };
}

/** A settlement's town as a town editor lays it out (worldgen W9h): as the world lays it out, without its
 *  own hand layout (which the editor applies as it edits), with its lots; and that layout. Null for a
 *  place that is not a settlement. */
export function worldTownForEditor(game: GameWorld, settlementId: string) {
  const town = worldTown(game, settlementId, undefined, { byHand: false });
  if (!town) return null;
  const { people: _people, homeOf: _homeOf, workOf: _workOf, ...drawn } = town;
  return { town: drawn, layout: game.edits?.towns?.find((each) => each.settlement === settlementId) ?? null };
}

/** A place's people as the world has them, its hand edits applied. */
export function worldPeopleOf(game: GameWorld, placeId: string) {
  return worldCast(game, placeId).map((person) => ({
    id: person.id,
    name: person.name,
    named: person.named,
    role: person.role,
    byHand: worldPersonByHand(person.id),
  }));
}

/** What a story can name in this world, for a story maker: its places as edited, its groups, the deeds
 *  its kit has on, and the expressions a speaker can wear (its people come from `worldPeopleOf`). */
export function storyNamesOf(game: GameWorld) {
  return {
    places: game.world.places.map((place) => ({
      id: place.id,
      name: place.name,
      parentId: place.parentId ?? null,
      settlement: place.rank !== undefined,
    })),
    groups: game.brief.groups.map((group) => group.name),
    deeds: (Object.keys(WORLD_DEED_KINDS) as Array<keyof typeof WORLD_DEED_KINDS>).filter(
      (deed) => game.kit.change.kinds[WORLD_DEED_KINDS[deed]].on,
    ),
    expressions: STORY_EXPRESSIONS,
  };
}

/** Why a world's story would not survive these hand edits (it names something they take away), or
 *  null. */
export function editsStoryRefusal(
  game: GameWorld,
  edits: WorldEdits | undefined,
  story: StoryScript | null,
): { error: string; issues: string[] } | null {
  if (!story) return null;
  const fits = checkStoryScript({ ...game, edits, world: compileGameWorld({ ...game, edits }) }, story);
  return fits.ok
    ? null
    : { error: `The game's story names what these edits take away: ${fits.issues[0]}`, issues: fits.issues };
}
