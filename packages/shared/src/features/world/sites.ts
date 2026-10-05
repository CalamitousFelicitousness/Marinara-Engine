// ──────────────────────────────────────────────
// Sites on the overworld (design-game-overworld-sites.md): a cave, a mine, a crypt, a ruin or any place
// with a map made for it, out in the world rather than in a town. A site is worked out from the world,
// never stored: a place with its own cell that is not a settlement, not in one and holds none, and is one
// to go into. Trips to and from a site leave the world's ways on foot for the nearest settlement.
// ──────────────────────────────────────────────
import { worldKitArtFamily } from "./art-family.js";
import { WORLD_DAYS_PER_CELL, type WorldLink, type WorldPlace } from "./compile.js";
import { dungeonSetForPlace } from "./dungeon-map.js";
import { worldSettlementOf } from "./engine.js";
import { worldPlaceByName, type GameWorld } from "./game-world.js";
import type { WorldPresent } from "./ledger.js";
import { worldOverworldHere, worldRoute, type WorldRoute } from "./overworld.js";
import { worldPlaceMap } from "./place-maps.js";

const sitesOfGame = new WeakMap<GameWorld, WorldPlace[]>();

/** The world's sites, in the world's order. */
export function worldSites(game: GameWorld): WorldPlace[] {
  let found = sitesOfGame.get(game);
  if (!found) {
    const places = game.world.places;
    const byId = new Map(places.map((place) => [place.id, place]));
    // The places that hold a settlement (a realm, a province, a system): never a site.
    const holding = new Set<string>();
    for (const settlement of places.filter((place) => place.rank !== undefined))
      for (let up = byId.get(settlement.parentId ?? ""); up; up = byId.get(up.parentId ?? "")) holding.add(up.id);
    const family = worldKitArtFamily(game.kit);
    found = places.filter(
      (place) =>
        place.rank === undefined &&
        !holding.has(place.id) &&
        !worldSettlementOf(game, place.id) &&
        (worldPlaceMap(game, place.id) !== null || dungeonSetForPlace(place, family) !== null),
    );
    sitesOfGame.set(game, found);
  }
  return found;
}

/** Whether a place is one of the world's sites. */
export function worldIsSite(game: GameWorld, placeId: string | undefined): boolean {
  return placeId !== undefined && worldSites(game).some((site) => site.id === placeId);
}

/** The settlement a site's trips leave the world's ways at: the nearest by a straight line (ties to the one
 *  the world lists first). */
export function worldSiteAnchor(game: GameWorld, site: WorldPlace): WorldPlace | undefined {
  const away = (other: WorldPlace) => Math.hypot(other.at.x - site.at.x, other.at.y - site.at.y);
  return game.world.places
    .filter((place) => place.rank !== undefined)
    .reduce<WorldPlace | undefined>((best, place) => (!best || away(place) < away(best) ? place : best), undefined);
}

/** A leg off the world's ways, on foot: the straight line's cells at the kit's first way over open ground. */
function offRoad(game: GameWorld, from: WorldPlace, to: WorldPlace): WorldLink {
  const way = game.kit.travel.find((each) => (each.crosses ?? "open") === "open") ?? game.kit.travel[0]!;
  const cells = Math.hypot(from.at.x - to.at.x, from.at.y - to.at.y);
  const days = Math.round(((cells * WORLD_DAYS_PER_CELL[game.kit.scale]) / (way.speed ?? 1)) * 100) / 100;
  return { from: from.id, to: to.id, way: way.id, days: Math.max(0.01, days) };
}

/** A trip on the overworld between two settlements or sites: off the road from a site to its settlement,
 *  the world's ways between settlements, off the road to a site. Null when it is no trip (the same spot,
 *  or no way joins them). */
export function worldTrip(game: GameWorld, fromId: string, toId: string): WorldRoute | null {
  if (fromId === toId) return null;
  const place = (id: string) => game.world.places.find((each) => each.id === id);
  const [from, to] = [place(fromId), place(toId)];
  if (!from || !to) return null;
  const [fromSite, toSite] = [worldIsSite(game, fromId), worldIsSite(game, toId)];
  if (!fromSite && !toSite) return worldRoute(game.world, fromId, toId);
  const fromAnchor = fromSite ? worldSiteAnchor(game, from) : from;
  const toAnchor = toSite ? worldSiteAnchor(game, to) : to;
  if (!fromAnchor || !toAnchor) return null;
  const path: string[] = [fromId];
  const legs: WorldLink[] = [];
  if (fromSite) {
    legs.push(offRoad(game, from, fromAnchor));
    path.push(fromAnchor.id);
  }
  if (fromAnchor.id !== toAnchor.id) {
    const between = worldRoute(game.world, fromAnchor.id, toAnchor.id);
    if (!between) return null;
    legs.push(...between.legs);
    path.push(...between.path.slice(1));
  }
  if (toSite) {
    legs.push(offRoad(game, toAnchor, to));
    path.push(toId);
  }
  // A settlement's trip to its own site never passes through the settlement twice.
  const days = Math.round(legs.reduce((sum, leg) => sum + leg.days, 0) * 100) / 100;
  return { path: path.filter((id, index) => index === 0 || id !== path[index - 1]), legs, days };
}

/** Where the party is on the overworld: a site, when the place in force is one; else as before, the
 *  settlement of the place in force (`worldOverworldHere`). */
export function worldOverworldSpot(
  game: GameWorld,
  present: WorldPresent,
  name: string | undefined,
): WorldPlace | undefined {
  // A place the story added is in a settlement, never a site: only the world's own places are.
  const place = name ? worldPlaceByName(game.world, name) : undefined;
  if (place && worldIsSite(game, place.id)) return place;
  return worldOverworldHere(game, present, name);
}
