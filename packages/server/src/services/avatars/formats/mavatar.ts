// ──────────────────────────────────────────────
// Avatar import: mesh-avatar `.mavatar` archives (lane: 2D)
// ──────────────────────────────────────────────
// A `.mavatar` (MIT, npm "mesh-avatar" 0.1.1) is a ZIP of `rig.json`, built layers and an optional
// `avatar.json` manifest. Read it with openZipArchive() from lib/zip-reader.ts (strict: refuses archives
// whose records disagree) and AVATAR_IMPORT_MAX_BYTES as the entry bound; never write a new ZIP parser.
//
// Contract stub: claims no file until the 2D lane fills it in.
import { AVATAR_IMPORT_EXTENSIONS, AvatarImportError, type AvatarFormatImporter } from "@marinara-engine/shared";

export const mavatarImporter: AvatarFormatImporter<"mesh-avatar"> = {
  kind: "mesh-avatar",
  extensions: AVATAR_IMPORT_EXTENSIONS["mesh-avatar"],
  detect: () => false,
  validate: async () => {
    throw new AvatarImportError("unsupported-format", "Mesh avatar files can't be imported yet.");
  },
  extract: async () => {
    throw new AvatarImportError("unsupported-format", "Mesh avatar files can't be imported yet.");
  },
};
