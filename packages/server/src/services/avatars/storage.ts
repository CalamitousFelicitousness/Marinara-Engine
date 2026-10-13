// ──────────────────────────────────────────────
// Avatar agents: per-owner storage (lane: base)
// ──────────────────────────────────────────────
// Layout, one folder per character or persona:
//   DATA_DIR/avatar-models/<ownerType>/<ownerId>/avatar.json      AvatarConfig v1 (avatarConfigSchema)
//   DATA_DIR/avatar-models/<ownerType>/<ownerId>/pngtuber/*.png    PNGTuber layers (imported or generated)
//   DATA_DIR/avatar-models/<ownerType>/<ownerId>/mesh-avatar/*.mavatar
//   DATA_DIR/avatar-models/<ownerType>/<ownerId>/vrm/*.vrm, *.vrma
// `DATA_DIR/avatars` already holds profile pictures, so model files live apart from it. Owner sprites
// stay in DATA_DIR/sprites; a PNGTuber setup that reuses them stores only sprite labels.
//
// Contract stub: the base lane fills these in. Import routes and generation call only these functions,
// so every write goes through one per-owner queue and every path through one containment check.
import { join } from "node:path";
import type {
  AvatarConfig,
  AvatarExtractedFile,
  AvatarExtractedImport,
  AvatarFilePath,
  AvatarImportResult,
  AvatarKind,
  AvatarOwnerRef,
  AvatarOwnerSummary,
} from "@marinara-engine/shared";
import { DATA_DIR } from "../../utils/data-dir.js";

export const AVATAR_MODELS_DIR = join(DATA_DIR, "avatar-models");

/** The global upload cap (MAX_UPLOAD_BYTES in app.ts). Avatar imports add no lower limit: archive
 *  entries are read with this as their bound, and only dishonest archives are refused. */
export const AVATAR_IMPORT_MAX_BYTES = 256 * 1024 * 1024;

function notReady(): never {
  throw new Error("Avatar storage is not available yet");
}

/** Absolute folder of one owner. Validates the owner id; never creates anything. */
export function avatarOwnerDir(_owner: AvatarOwnerRef): string {
  return notReady();
}

/** Absolute path of a stored file, checked to stay inside the owner's folder. */
export function resolveAvatarFile(_owner: AvatarOwnerRef, _path: AvatarFilePath): string {
  return notReady();
}

/** The owner's parsed and validated `avatar.json`, or null when there is none. */
export async function readAvatarConfig(_owner: AvatarOwnerRef): Promise<AvatarConfig | null> {
  return notReady();
}

/** Read-modify-write of `avatar.json`, queued per owner so concurrent writes never interleave. `mutate`
 *  gets null when no config exists yet (start from createAvatarConfig). Validates before writing. */
export async function updateAvatarConfig(
  _owner: AvatarOwnerRef,
  _mutate: (current: AvatarConfig | null) => AvatarConfig | Promise<AvatarConfig>,
): Promise<AvatarConfig> {
  return notReady();
}

/** Every owner that has an `avatar.json`. */
export async function listAvatarOwners(): Promise<AvatarOwnerSummary[]> {
  return notReady();
}

/** Write files into the owner's folder (atomic per file), replacing same-named ones. */
export async function writeAvatarFiles(
  _owner: AvatarOwnerRef,
  _files: readonly AvatarExtractedFile[],
): Promise<AvatarFilePath[]> {
  return notReady();
}

/** Bytes of a stored file, or null when it is missing. */
export async function readAvatarFile(_owner: AvatarOwnerRef, _path: AvatarFilePath): Promise<Buffer | null> {
  return notReady();
}

/** Store an import or a generation result: write its files, set its kind data, make it the active kind
 *  when none is set, and remove files of that kind the new data no longer names. */
export async function saveExtractedAvatar(
  _owner: AvatarOwnerRef,
  _extracted: AvatarExtractedImport,
): Promise<AvatarImportResult> {
  return notReady();
}

/** Remove one kind's files and data; returns the remaining config, or null when nothing remains. */
export async function removeAvatarKind(_owner: AvatarOwnerRef, _kind: AvatarKind): Promise<AvatarConfig | null> {
  return notReady();
}

/** Remove the owner's whole avatar folder (when the avatar or its character or persona is deleted). */
export async function removeAvatarOwner(_owner: AvatarOwnerRef): Promise<void> {
  return notReady();
}
