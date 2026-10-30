import assert from "node:assert/strict";
import { findAvatarImporter } from "../../packages/server/src/services/avatars/formats/registry.js";
import { mmdPmx, mmdVmd } from "./fixtures/avatar-mmd-fixtures.js";

const pmx = mmdPmx();
const modelImporter = findAvatarImporter({ filename: "fixture.pmx", head: pmx });
assert.equal(modelImporter?.kind, "mmd", "the real avatar registry must import a PMX model");

const motionImporter = findAvatarImporter({ filename: "idle.vmd", head: mmdVmd() });
assert.equal(motionImporter?.kind, "mmd", "the real avatar registry must attach VMD motion to an MMD model");
