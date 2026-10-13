// ──────────────────────────────────────────────
// Avatar generation: PNGTuber blink and talk variants (lane: generation)
// ──────────────────────────────────────────────
// One click from a sprite: edit it into "eyes closed" and "mouth open" variants with the existing
// image generation (services/image, the same provider routing, fallback connection and style settings
// as sprite generation), using the 2D agent's `avatar-pngtuber-eyes-closed` / `avatar-pngtuber-mouth-open`
// templates. Generating returns drafts and stores nothing, so the avatar stays as it was until the user
// keeps a picture; saving stores the kept pictures as PNGTuber layers through services/avatars/storage.ts.
// The final prompt is logged with logDebugOverride (debugMode / DEBUG_AGENTS) before it reaches the provider.
import { createHash } from "node:crypto";
import {
  AVATAR_PROMPT_TEMPLATE_IDS,
  avatarKindDataSchema,
  detectSpriteEmotionBindings,
  isAvatarFilePath,
  normalizeSpriteExpressionKey,
  type AvatarExpressionMap,
  type AvatarExtractedFile,
  type AvatarFilePath,
  type AvatarGenerationResponse,
  type AvatarOwnerRef,
  type AvatarPngtuberVariant,
  type AvatarPngtuberVariantsRequest,
  type PngtuberAvatarData,
  type PngtuberLayerSet,
} from "@marinara-engine/shared";
import type { DB } from "../../../db/connection.js";
import { isAllowedImageBuffer } from "../../../utils/security.js";
import { resolveReviewedImagePromptSubmission } from "../../image/image-prompt-review.js";
import { getSharp } from "../../image/sharp-runtime.js";
import { readAvatarConfig, readAvatarFile, saveExtractedAvatar } from "../storage.js";
import {
  AvatarGenerationError,
  avatarGenerationDebug,
  avatarImageRequestSize,
  compileAvatarImagePrompt,
  drawAvatarImageEdit,
  listAvatarSourceSprites,
  readAvatarAgentSettings,
  readAvatarOwnerInfo,
  readAvatarSourceSprite,
  renderAvatarPromptTemplate,
  resolveAvatarImageConnection,
  withAvatarGenerationJob,
  type AvatarAgentSettings,
  type AvatarImageConnection,
  type AvatarOwnerInfo,
  type AvatarSourceSprite,
} from "./generation-context.js";

export interface AvatarGenerationOptions {
  signal?: AbortSignal;
}

/** A reviewed prompt from the image prompt review dialog, by `variantPromptId`. */
export interface AvatarPromptOverride {
  id: string;
  prompt: string;
  negativePrompt?: string;
}

export interface PngtuberVariantsGenerateRequest extends AvatarPngtuberVariantsRequest {
  promptOverrides?: AvatarPromptOverride[];
}

/** A generated picture that is not stored yet. */
export interface PngtuberVariantDraft {
  /** The sprite it was made from. */
  label: string;
  variant: AvatarPngtuberVariant;
  /** PNG data URL, the sprite's exact size. */
  image: string;
  width: number;
  height: number;
}

export interface PngtuberVariantsDraftResponse {
  drafts: PngtuberVariantDraft[];
  failed: Array<{ label: string; variant: AvatarPngtuberVariant; error: string }>;
}

export interface PngtuberVariantsSaveRequest {
  owner: AvatarOwnerRef;
  images: Array<{ label: string; variant: AvatarPngtuberVariant; image: string }>;
}

export interface AvatarPromptReviewItem {
  id: string;
  kind: "sprite";
  title: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
}

const VARIANT_TEMPLATE_IDS = {
  "eyes-closed": AVATAR_PROMPT_TEMPLATE_IDS.pngtuberEyesClosed,
  "mouth-open": AVATAR_PROMPT_TEMPLATE_IDS.pngtuberMouthOpen,
} as const;

const VARIANT_LAYER_KEYS = { "eyes-closed": "eyesClosed", "mouth-open": "mouthOpen" } as const;

const FULL_BODY_LABEL = /^full[_\s-]/iu;

const DEFAULT_PNGTUBER_MOTION = Object.freeze({ bounceOnTalk: true, bounceHeight: 0.04, blinkIntervalSeconds: 4 });

/** The review id of one variant prompt, shared by the preview and the generate request. */
export function variantPromptId(label: string, variant: AvatarPngtuberVariant): string {
  return `avatar:pngtuber:${label}:${variant}`;
}

/** The layer key of a sprite label (the contract keys PNGTuber layer sets by normalized label). */
export function pngtuberLayerKey(label: string): string {
  const key = normalizeSpriteExpressionKey(label).slice(0, 64);
  if (!key) throw new AvatarGenerationError(400, `"${label}" can't be used as an expression name.`);
  return key;
}

/** Stored file names for a layer set: ASCII, with a short hash when the label had other characters. */
export function pngtuberVariantFilePath(key: string, part: "base" | AvatarPngtuberVariant): AvatarFilePath {
  const ascii = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  const stem =
    ascii && ascii === key.replace(/_/gu, "-")
      ? ascii
      : `${ascii || "expression"}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
  const path = `pngtuber/${stem}-${part}.png`;
  if (!isAvatarFilePath(path)) throw new AvatarGenerationError(400, `"${key}" can't be used as an expression name.`);
  return path;
}

export interface KeptPngtuberSet {
  key: string;
  variants: AvatarPngtuberVariant[];
  /** The set's other pictures were drawn for this same base, so they stay. */
  keepOthers: boolean;
}

/** Puts kept pictures into the owner's PNGTuber setup, creating one when there is none. A layer set
 *  that was built from another picture (another sprite, or a PNGTuber Plus import) is replaced, so a
 *  blink never swaps to a picture drawn for a different base. Bindings the user or an import chose stay. */
export function mergePngtuberVariants(
  current: PngtuberAvatarData | undefined,
  kept: readonly KeptPngtuberSet[],
): PngtuberAvatarData {
  const layers: Record<string, PngtuberLayerSet> = { ...(current?.layers ?? {}) };
  for (const { key, variants, keepOthers } of kept) {
    const base = { source: "file" as const, path: pngtuberVariantFilePath(key, "base") };
    const set: PngtuberLayerSet = keepOthers && layers[key] ? { ...layers[key], base } : { base };
    for (const variant of variants) {
      set[VARIANT_LAYER_KEYS[variant]] = { source: "file", path: pngtuberVariantFilePath(key, variant) };
    }
    // A combined blink-and-talk picture was drawn for the old pictures; it would not match the new ones.
    delete set.eyesClosedMouthOpen;
    layers[key] = set;
  }
  const expressionMap: AvatarExpressionMap = detectSpriteEmotionBindings(Object.keys(layers));
  for (const [slot, binding] of Object.entries(current?.expressionMap ?? {})) {
    if (binding && binding.source !== "missing" && (binding.target === null || binding.target in layers)) {
      expressionMap[slot as keyof AvatarExpressionMap] = binding;
    }
  }
  return {
    layers,
    expressionMap,
    motion: current?.motion ?? { ...DEFAULT_PNGTUBER_MOTION },
    source: current?.source ?? "generated",
  };
}

export interface AvatarVariantPromptContext extends AvatarOwnerInfo {
  template: AvatarAgentSettings["template"];
}

/** The provider prompt for one variant of one sprite: the reviewed prompt when the user edited it, else
 *  the agent's template rendered with the owner's card text and compiled like a sprite prompt. Mesh
 *  avatars draw their closed eyes and open mouth with these same prompts. */
export async function avatarVariantPrompt(
  db: DB,
  image: AvatarImageConnection,
  context: AvatarVariantPromptContext,
  label: string,
  variant: AvatarPngtuberVariant,
  override?: AvatarPromptOverride,
): Promise<{ prompt: string; negativePrompt: string }> {
  const id = VARIANT_TEMPLATE_IDS[variant];
  const rendered = renderAvatarPromptTemplate(context.template(id), id, {
    characterName: context.name || "the character",
    appearance: context.appearance,
    expression: label.replace(/[_-]+/gu, " "),
  });
  const compiled = await compileAvatarImagePrompt(db, image, rendered);
  return resolveReviewedImagePromptSubmission({
    generatedPrompt: compiled.prompt,
    generatedNegativePrompt: compiled.negativePrompt,
    promptOverride: override?.prompt,
    negativePromptOverride: override?.negativePrompt,
  });
}

function requestedLabels(request: AvatarPngtuberVariantsRequest, setupLabels: string[]): string[] {
  const labels = request.labels?.length ? request.labels : setupLabels;
  return [...new Set(labels)];
}

async function setupSpriteLabels(owner: AvatarOwnerRef): Promise<string[]> {
  const sprites = listAvatarSourceSprites(owner.ownerId);
  const config = await readAvatarConfig(owner).catch(() => null);
  const keys = Object.keys(config?.kinds.pngtuber?.layers ?? {});
  if (!keys.length) return sprites.filter((label) => !FULL_BODY_LABEL.test(label));
  return sprites.filter((label) => keys.includes(normalizeSpriteExpressionKey(label)));
}

/** The exact prompts the variants would send, for the image prompt review dialog. */
export async function previewPngtuberVariantPrompts(
  db: DB,
  request: AvatarPngtuberVariantsRequest,
): Promise<AvatarPromptReviewItem[]> {
  const [owner, agent, image] = await Promise.all([
    readAvatarOwnerInfo(db, request.owner),
    readAvatarAgentSettings(db),
    resolveAvatarImageConnection(db, request.connectionId),
  ]);
  const labels = requestedLabels(request, await setupSpriteLabels(request.owner));
  const items: AvatarPromptReviewItem[] = [];
  for (const label of labels) {
    const source = await readAvatarSourceSprite(request.owner.ownerId, label);
    const size = avatarImageRequestSize(source.width, source.height, image.conn.model || "");
    for (const variant of request.variants) {
      const prompt = await avatarVariantPrompt(db, image, { template: agent.template, ...owner }, label, variant);
      items.push({
        id: variantPromptId(label, variant),
        kind: "sprite",
        title: `${label.replace(/_/gu, " ")}: ${variant.replace("-", " ")}`,
        ...prompt,
        ...size,
      });
    }
  }
  return items;
}

/** Draws the requested variants one after another and returns them without storing anything. One
 *  failed picture does not stop the others. */
export async function generatePngtuberVariants(
  db: DB,
  request: PngtuberVariantsGenerateRequest,
  options: AvatarGenerationOptions = {},
): Promise<PngtuberVariantsDraftResponse> {
  return withAvatarGenerationJob(request.owner, "pngtuber", async () => {
    const [owner, agent, image] = await Promise.all([
      readAvatarOwnerInfo(db, request.owner),
      readAvatarAgentSettings(db),
      resolveAvatarImageConnection(db, request.connectionId),
    ]);
    const labels = requestedLabels(request, await setupSpriteLabels(request.owner));
    if (!labels.length) throw new AvatarGenerationError(400, "Add a sprite first, then make variants from it.");
    const overrides = new Map((request.promptOverrides ?? []).map((entry) => [entry.id, entry]));
    const debug = avatarGenerationDebug(request.debugMode);
    const response: PngtuberVariantsDraftResponse = { drafts: [], failed: [] };
    for (const label of labels) {
      pngtuberLayerKey(label); // refuse a label that can't be stored before paying for a picture
      const source = await readAvatarSourceSprite(request.owner.ownerId, label);
      for (const variant of request.variants) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("Cancelled");
        try {
          const prompt = await avatarVariantPrompt(
            db,
            image,
            { template: agent.template, ...owner },
            label,
            variant,
            overrides.get(variantPromptId(label, variant)),
          );
          const png = await drawAvatarImageEdit({
            image,
            ...prompt,
            source,
            signal: options.signal,
            debug,
            logLabel: `pngtuber ${label} ${variant}`,
          });
          response.drafts.push({
            label,
            variant,
            image: `data:image/png;base64,${png.toString("base64")}`,
            width: source.width,
            height: source.height,
          });
        } catch (error) {
          if (options.signal?.aborted || error instanceof AvatarGenerationError) throw error;
          const message = String(error instanceof Error ? error.message : error)
            .replace(/<[^>]*>/gu, "")
            .slice(0, 300);
          response.failed.push({ label, variant, error: message || "The picture could not be made." });
        }
      }
    }
    if (!response.drafts.length && response.failed.length) {
      throw new AvatarGenerationError(502, response.failed[0]!.error);
    }
    return response;
  });
}

function decodeDataUrl(value: string): Buffer {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  return Buffer.from(comma >= 0 ? value.slice(comma + 1) : value, "base64");
}

/** A kept picture from the browser: must be a picture of exactly the sprite's size. Re-encoded so only
 *  pixels are stored. */
async function keptPicturePng(image: string, source: AvatarSourceSprite): Promise<Buffer> {
  const bytes = decodeDataUrl(image);
  if (!isAllowedImageBuffer(bytes)) throw new AvatarGenerationError(400, "A kept picture isn't a picture.");
  const sharp = await getSharp();
  const { data, info } = await sharp(bytes, { animated: false })
    .ensureAlpha()
    .png()
    .toBuffer({ resolveWithObject: true })
    .catch((error: unknown) => {
      throw new AvatarGenerationError(400, "A kept picture couldn't be read.", { cause: error });
    });
  if (info.width !== source.width || info.height !== source.height) {
    throw new AvatarGenerationError(
      409,
      `The sprite "${source.label}" changed size since its variants were made. Make them again.`,
    );
  }
  return data;
}

/** Stores the kept pictures as PNGTuber layers and returns the saved setup. The sprite each picture was
 *  made from is copied next to it, so the base and its variants always line up. */
export async function savePngtuberVariants(request: PngtuberVariantsSaveRequest): Promise<AvatarGenerationResponse> {
  const current = await readAvatarConfig(request.owner);
  const layers = current?.kinds.pngtuber?.layers ?? {};
  const files = new Map<AvatarFilePath, Uint8Array>();
  const sets = new Map<string, KeptPngtuberSet & { label: string; source: AvatarSourceSprite }>();
  for (const entry of request.images) {
    const key = pngtuberLayerKey(entry.label);
    let set = sets.get(key);
    if (set && set.label !== entry.label) {
      throw new AvatarGenerationError(400, `Keep pictures from one sprite per expression ("${key}").`);
    }
    if (!set) {
      const source = await readAvatarSourceSprite(request.owner.ownerId, entry.label);
      const basePath = pngtuberVariantFilePath(key, "base");
      const existing = layers[key]?.base;
      // Earlier variants stay only when they were drawn for this very picture.
      const keepOthers =
        existing?.source === "sprite"
          ? existing.label === key && !FULL_BODY_LABEL.test(entry.label)
          : existing?.path === basePath && !!(await readAvatarFile(request.owner, basePath))?.equals(source.png);
      set = { key, label: entry.label, source, variants: [], keepOthers };
      sets.set(key, set);
      files.set(basePath, source.png);
    }
    files.set(pngtuberVariantFilePath(key, entry.variant), await keptPicturePng(entry.image, set.source));
    if (!set.variants.includes(entry.variant)) set.variants.push(entry.variant);
  }
  const data = mergePngtuberVariants(current?.kinds.pngtuber, [...sets.values()]);
  const checked = avatarKindDataSchema.safeParse({ pngtuber: data });
  if (!checked.success) {
    throw new AvatarGenerationError(400, checked.error.issues[0]?.message ?? "The PNGTuber setup isn't valid.");
  }
  const extracted: AvatarExtractedFile[] = [...files].map(([path, bytes]) => ({ path, bytes }));
  const saved = await saveExtractedAvatar(request.owner, {
    kind: "pngtuber",
    files: extracted,
    data,
    detected: data.expressionMap,
    warnings: [],
  });
  return { kind: "pngtuber", config: saved.config, files: [...files.keys()], warnings: saved.warnings };
}
