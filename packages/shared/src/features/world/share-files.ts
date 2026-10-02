// ──────────────────────────────────────────────
// Kit and world share files (worldgen W9d): a setting kit, or a whole world (its kit, seed, brief and
// hand edits), as a file to pass on, read back into a new game's setup. Read strictly: a file in
// another format, a kit or brief that does not read, or a world from another generator is refused with
// the reason; what of the brief the kit no longer fits is left out with a note, as are hand edits that
// do not fit the world, so one stray part never costs the player the rest.
// ──────────────────────────────────────────────
import { parseWorldKit, type WorldKit } from "../../schemas/world-kit.schema.js";
import { checkWorldBrief, type WorldBrief } from "../../schemas/world-brief.schema.js";
import { WORLD_GENERATOR_VERSION } from "./compile.js";
import type { WorldEdits } from "./edits.js";
import { gameWorldSchema, worldEditIssues, type WORLD_GROUNDINGS } from "./game-world.js";

export const WORLD_KIT_FILE_FORMAT = "marinara-world-kit";
export const WORLD_FILE_FORMAT = "marinara-world";
export const WORLD_SHARE_FILE_VERSION = 1;
/** The largest share file read. */
export const WORLD_SHARE_FILE_MAX_BYTES = 2_000_000;

export interface WorldKitFile {
  format: typeof WORLD_KIT_FILE_FORMAT;
  version: typeof WORLD_SHARE_FILE_VERSION;
  exportedAt: string;
  kit: WorldKit;
}

/** A world as a file: everything its compile needs, and the hand edits kept with it. */
export interface WorldFileWorld {
  seed: number;
  generatorVersion: number;
  grounding: (typeof WORLD_GROUNDINGS)[number];
  brief: WorldBrief;
  edits?: WorldEdits;
}

export interface WorldFile {
  format: typeof WORLD_FILE_FORMAT;
  version: typeof WORLD_SHARE_FILE_VERSION;
  exportedAt: string;
  name: string;
  kit: WorldKit;
  world: WorldFileWorld;
}

export const worldKitFile = (kit: WorldKit, exportedAt = new Date().toISOString()): WorldKitFile => ({
  format: WORLD_KIT_FILE_FORMAT,
  version: WORLD_SHARE_FILE_VERSION,
  exportedAt,
  kit,
});

export const worldFile = (
  name: string,
  kit: WorldKit,
  world: WorldFileWorld,
  exportedAt = new Date().toISOString(),
): WorldFile => ({
  format: WORLD_FILE_FORMAT,
  version: WORLD_SHARE_FILE_VERSION,
  exportedAt,
  name: name.trim().slice(0, 120) || kit.label,
  kit,
  world,
});

/** An installed Experience's map pack (worldgen W9e) as the Engine read and checked it: its setting kit,
 *  the ready-made worlds built with it, and its tile pack. */
export interface ExperienceMapPack {
  packageId: string;
  /** The Experience's name. */
  name: string;
  kit: WorldKit;
  worlds: Array<{ path: string; name: string; world: WorldFileWorld }>;
  tiles: import("./tile-pack.js").TilePack | null;
}

type Read<T> = ({ ok: true; notes: string[] } & T) | { ok: false; issues: string[] };

/** The file's JSON object of the given format, or why it is not one. */
function readShareFile(
  text: string,
  format: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; issues: string[] } {
  if (new TextEncoder().encode(text).length > WORLD_SHARE_FILE_MAX_BYTES) {
    return { ok: false, issues: ["The file is larger than a share file can be."] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issues: ["The file is not JSON."] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, issues: ["The file is not a share file."] };
  const file = value as Record<string, unknown>;
  if (file.format !== format) {
    return {
      ok: false,
      issues: [
        file.format === WORLD_FILE_FORMAT || file.format === WORLD_KIT_FILE_FORMAT
          ? `This is a ${file.format === WORLD_FILE_FORMAT ? "world" : "setting kit"} file, not a ${format === WORLD_FILE_FORMAT ? "world" : "setting kit"} file.`
          : "The file is not a setting kit or world file.",
      ],
    };
  }
  if (file.version !== WORLD_SHARE_FILE_VERSION) {
    return { ok: false, issues: ["The file was made by a newer version of Marinara Engine."] };
  }
  return { ok: true, value: file };
}

/** A setting kit file, read. */
export function readWorldKitFile(text: string): Read<{ kit: WorldKit }> {
  const file = readShareFile(text, WORLD_KIT_FILE_FORMAT);
  if (!file.ok) return file;
  const kit = parseWorldKit(file.value.kit);
  if (!kit.ok) return { ok: false, issues: kit.issues.slice(0, 5) };
  return { ok: true, kit: kit.kit, notes: [] };
}

/** A world file, read: its kit, and its world as this Engine would make it. */
export function readWorldFile(text: string): Read<{ name: string; kit: WorldKit; world: WorldFileWorld }> {
  const file = readShareFile(text, WORLD_FILE_FORMAT);
  if (!file.ok) return file;
  const kit = parseWorldKit(file.value.kit);
  if (!kit.ok) return { ok: false, issues: kit.issues.slice(0, 5) };
  const stored = gameWorldSchema.safeParse(file.value.world);
  if (!stored.success) {
    return {
      ok: false,
      issues: stored.error.issues.slice(0, 5).map((issue) => `world.${issue.path.join(".")}: ${issue.message}`),
    };
  }
  if (stored.data.generatorVersion !== WORLD_GENERATOR_VERSION) {
    return { ok: false, issues: ["This world was made by another version of the generator."] };
  }
  const brief = checkWorldBrief(kit.kit, stored.data.brief);
  if (!brief.ok) return { ok: false, issues: brief.issues.slice(0, 5) };
  const notes = [...brief.repairs];
  const inputs = { kit: kit.kit, seed: stored.data.seed, grounding: stored.data.grounding, brief: brief.brief };
  let edits = stored.data.edits;
  if (edits) {
    const unfit = worldEditIssues(inputs, edits);
    if (unfit.length) {
      // First, so it is never cut off behind the brief's own notes.
      notes.unshift(`The world's hand edits do not fit it, so they were left out: ${unfit[0]}`);
      edits = undefined;
    }
  }
  const name =
    typeof file.value.name === "string" && file.value.name.trim()
      ? file.value.name.trim().slice(0, 120)
      : kit.kit.label;
  return {
    ok: true,
    name,
    kit: kit.kit,
    world: {
      seed: inputs.seed,
      generatorVersion: WORLD_GENERATOR_VERSION,
      grounding: inputs.grounding,
      brief: brief.brief,
      ...(edits ? { edits } : {}),
    },
    notes,
  };
}
