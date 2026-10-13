// ──────────────────────────────────────────────
// Avatar import: VRM 0.x / 1.0 models and `.vrma` animations (lane: 3D)
// ──────────────────────────────────────────────
// A `.vrm` is a binary glTF (GLB). Validate the GLB header and chunk lengths against the real byte
// length, parse only the JSON chunk, read the VRM or VRMC_vrm extension for the spec version and the
// expression names, and bind them to the AVATAR_EXPRESSION_SLOTS. A `.vrma` attaches to an imported VRM.
//
// Contract stub: claims no file until the 3D lane fills it in.
import { AVATAR_IMPORT_EXTENSIONS, AvatarImportError, type AvatarFormatImporter } from "@marinara-engine/shared";

export const vrmImporter: AvatarFormatImporter<"vrm"> = {
  kind: "vrm",
  extensions: AVATAR_IMPORT_EXTENSIONS.vrm,
  detect: () => false,
  validate: async () => {
    throw new AvatarImportError("unsupported-format", "VRM files can't be imported yet.");
  },
  extract: async () => {
    throw new AvatarImportError("unsupported-format", "VRM files can't be imported yet.");
  },
};
