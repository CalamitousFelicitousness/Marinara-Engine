// ──────────────────────────────────────────────
// Furniture (worldgen W13): what a building's rooms are furnished with, by what each piece is. A module of
// its own (no imports), so the edit layer's schema can name the pieces without loading the rooms' layout.
// ──────────────────────────────────────────────

/** Furniture, by what it is; each setting family's tiles draw their own look of it. */
export const WORLD_FURNITURE = Object.freeze([
  "bed",
  "table",
  "chair",
  "counter",
  "shelf",
  "hearth",
  "crate",
  "barrel",
  "altar",
  "bench",
  "workbench",
  "furnace",
  "desk",
  "bookshelf",
  "rack",
  "rug",
  "plant",
  "lamp",
] as const);
export type WorldFurniture = (typeof WORLD_FURNITURE)[number];
