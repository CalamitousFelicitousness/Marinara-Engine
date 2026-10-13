// ──────────────────────────────────────────────
// Avatar import: PNGTuber Plus `.save` files (lane: 2D)
// ──────────────────────────────────────────────
// PNGTuber Plus saves (Unlicense) are JSON with base64 PNG layers and talk/blink visibility flags. The
// 2D lane flattens them into PNGTuber layer sets (base, mouth open, eyes closed) per costume.
//
// Contract stub: claims no file until the 2D lane fills it in.
import { AVATAR_IMPORT_EXTENSIONS, AvatarImportError, type AvatarFormatImporter } from "@marinara-engine/shared";

export const pngtuberImporter: AvatarFormatImporter<"pngtuber"> = {
  kind: "pngtuber",
  extensions: AVATAR_IMPORT_EXTENSIONS.pngtuber,
  detect: () => false,
  validate: async () => {
    throw new AvatarImportError("unsupported-format", "PNGTuber Plus files can't be imported yet.");
  },
  extract: async () => {
    throw new AvatarImportError("unsupported-format", "PNGTuber Plus files can't be imported yet.");
  },
};
