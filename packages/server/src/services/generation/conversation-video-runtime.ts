import { readFileSync } from "node:fs";
import {
  extractLeadingThinkingBlocks,
  mergeBuiltInAgentSettings,
  normalizeVideoFirstFrame,
  parseAgentSettingsRecord,
  type GeneratedSceneVideo,
  type VideoReferenceImage,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { isDebugAgentsEnabled } from "../../config/runtime-config.js";
import { logger, logDebugOverride } from "../../lib/logger.js";
import { removeCopiedPromptGuidance } from "../image/image-prompt-compiler.js";
import { resolveGalleryImagePath } from "../image/gallery-image-path.js";
import { readPreferredCharacterReferenceImage } from "../image/illustrator-references.js";
import { CONVERSATION_VIDEO, loadPrompt } from "../prompt-overrides/index.js";
import { createCharacterGalleryStorage } from "../storage/character-gallery.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createConnectionsStorage } from "../storage/connections.storage.js";
import { createGalleryStorage } from "../storage/gallery.storage.js";
import { createPromptOverridesStorage } from "../storage/prompt-overrides.storage.js";
import {
  ChatVideoError,
  generateAndSaveChatVideo,
  readVideoReferenceImage,
  resolveChatVideoSetup,
} from "../video/chat-video-generation.js";
import { formatRecentVideoContext } from "../video/prompt-context.js";
import { createAgentsStorage } from "../storage/agents.storage.js";
import { normalizeAgentContextSize } from "../agents/agent-executor.js";
import { resolveSceneVideoPrompt } from "../video/scene-video-prompt-review.js";
import { resolveBaseUrl } from "./connection-base-url.js";
import { handleConversationSelfieCommand } from "./conversation-selfie-command-runtime.js";
import { appendVideoPromptInstructions } from "./image-prompt-instructions.js";
import { resolveIllustratorPromptRuntime, type IllustratorPromptConnection } from "./illustrator-prompt-runtime.js";

export interface ConversationVideoPreview {
  prompt: string;
  durationSeconds: number;
  aspectRatio: "16:9" | "9:16";
  resolution: string | null;
  maxPromptLength: number | null;
}

export interface ConversationVideoResult {
  video: GeneratedSceneVideo;
  characterName: string;
  /** What the clip started from. */
  firstFrame: "gallery" | "selfie" | "avatar" | "none";
}

const VIDEO_PROMPT_WRITER_MAX_TOKENS = 8_196;
const SELFIE_CONTEXT_MAX_CHARS = 2_000;
const UNCLOSED_THINKING_RE = /^<(?:think|thinking|reasoning)\b/iu;

type PromptCharacter = Parameters<typeof handleConversationSelfieCommand>[0]["charInfo"][number];

export async function generateConversationVideo(args: {
  db: DB;
  chatId: string;
  chatMeta: Record<string, unknown>;
  characterId: string;
  /** Every character in the chat, for the selfie first frame. */
  charInfo: PromptCharacter[];
  /** The chat's own text connection; the chat's Prompt Model override wins over it. */
  promptConnection: IllustratorPromptConnection | null;
  promptConnectionId: string | null;
  context?: string | null;
  promptOverride?: string | null;
  /** Animate this gallery image instead of using the chat's first-frame setting. */
  galleryImageId?: string | null;
  previewOnly?: boolean;
  queue?: boolean;
  debugMode?: boolean;
  serviceTier?: "flex" | "priority" | null;
  signal?: AbortSignal;
}): Promise<ConversationVideoPreview | ConversationVideoResult> {
  const debugOverrideEnabled = args.debugMode === true || isDebugAgentsEnabled();
  const connections = createConnectionsStorage(args.db);
  const characters = createCharactersStorage(args.db);
  const chats = createChatsStorage(args.db);

  const setup = await resolveChatVideoSetup(args.db, args.chatMeta);
  const { videoConn, runtime, durationSeconds, aspectRatio } = setup;

  const characterRow = await characters.getById(args.characterId);
  if (!characterRow) throw new ChatVideoError(404, "Character not found");
  const charData = parseRecord(characterRow.data);
  const extensions = parseRecord(charData.extensions);
  const characterName = typeof charData.name === "string" && charData.name.trim() ? charData.name.trim() : "character";

  // A clip the user asks for (/video, the Gallery's Video button) has no context of its own: it reads the recent
  // conversation instead, as much of it as Illustrator reads for a picture (its Agent Budget). The video prompt and
  // a selfie first frame both use it, so the clip and its starting picture show the same moment.
  const names = new Map(args.charInfo.map((character) => [character.id, character.name]));
  const recent = args.context?.trim()
    ? ""
    : formatRecentVideoContext(await chats.listMessages(args.chatId), {
        count: await loadIllustratorContextSize(args.db),
        speaker: (message) =>
          message.role === "user"
            ? "User"
            : (names.get(typeof message.characterId === "string" ? message.characterId : "") ?? characterName),
      });
  // The selfie writer takes a short context; the end of the conversation is the moment the clip shows.
  const selfieContext =
    args.context?.trim() ||
    (recent ? `The latest moment of this conversation:\n${recent.slice(-SELFIE_CONTEXT_MAX_CHARS)}` : "");

  let prompt = args.promptOverride?.trim() ?? "";
  if (!prompt) {
    const promptRuntime = await resolveIllustratorPromptRuntime({
      chatMetadata: args.chatMeta,
      defaultConnection: args.promptConnection,
      defaultConnectionId: args.promptConnectionId,
      connections,
      resolveBaseUrl,
    });
    const appearance =
      (typeof extensions.appearance === "string" && extensions.appearance.trim()) ||
      (typeof charData.description === "string" ? charData.description.trim() : "");
    const system = await loadPrompt(createPromptOverridesStorage(args.db), CONVERSATION_VIDEO, {
      charName: characterName,
      appearance,
      personality: typeof charData.personality === "string" ? charData.personality.trim() : "",
      durationSeconds,
    });
    let request = `Write a short video message from ${characterName} that fits the current conversation.`;
    if (args.context?.trim()) {
      request = `Context for the video message: ${args.context.trim()}`;
    } else if (recent) {
      request = `Recent conversation:\n${recent}\n\nWrite a short video message from ${characterName} that shows the latest moment of this conversation.`;
    }
    const user = appendVideoPromptInstructions(request, videoConn.videoPromptInstructions);
    logDebugOverride(debugOverrideEnabled, "[debug/conversation/video] prompt-builder system:\n%s", system);
    logDebugOverride(debugOverrideEnabled, "[debug/conversation/video] prompt-builder user:\n%s", user);
    const result = await promptRuntime.provider.chatComplete(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      {
        model: promptRuntime.model,
        ...(promptRuntime.suppressModelParameters
          ? {}
          : // Reasoning models spend part of this on thinking first; 1,200 left some with no answer at all.
            { temperature: 0.7, maxTokens: VIDEO_PROMPT_WRITER_MAX_TOKENS, serviceTier: args.serviceTier ?? null }),
        suppressModelParameters: promptRuntime.suppressModelParameters,
        signal: args.signal,
        enableCaching: promptRuntime.enableCaching,
        anthropicExtendedCacheTtl: promptRuntime.anthropicExtendedCacheTtl,
      },
    );
    // Some local models put their reasoning inline; an unclosed block means it never got to the answer.
    const answer = extractLeadingThinkingBlocks(result.content ?? "").content.trim();
    // A sentence of the connection's instructions the writer copied word for word is not video-model text.
    prompt = UNCLOSED_THINKING_RE.test(answer)
      ? ""
      : removeCopiedPromptGuidance(answer, [videoConn.videoPromptInstructions]);
    if (!prompt) {
      throw new ChatVideoError(
        502,
        result.finishReason === "length"
          ? "The Prompt Model used its whole response budget before writing the video prompt. Try a model that thinks less, or shorter Video Prompting Instructions."
          : "The Prompt Model returned an empty video prompt.",
      );
    }
  }
  prompt = resolveSceneVideoPrompt({
    generatedPrompt: prompt,
    promptOverride: args.promptOverride ?? undefined,
    maxPromptLength: runtime.promptLimits.finalPrompt,
  });
  logDebugOverride(debugOverrideEnabled, "[debug/conversation/video] final prompt:\n%s", prompt);

  if (args.previewOnly) {
    return {
      prompt,
      durationSeconds,
      aspectRatio,
      resolution: runtime.resolution ?? null,
      maxPromptLength: runtime.promptLimits.finalPrompt,
    };
  }

  const firstFrame = await resolveFirstFrame({
    ...args,
    characterName,
    avatarPath: characterRow.avatarPath ?? null,
    selfieContext,
  });

  const video = await generateAndSaveChatVideo(args.db, setup, {
    chatId: args.chatId,
    prompt,
    referenceImage: firstFrame.image,
    sourceTag: firstFrame.tag,
    sourcePath: firstFrame.path,
    queue: args.queue,
    signal: args.signal,
    debugMode: args.debugMode,
  });
  logger.info("[conversation/video] %s sent video %s in chat %s", characterName, video.id, args.chatId);
  return { video, characterName, firstFrame: firstFrame.kind };
}

async function resolveFirstFrame(
  args: Parameters<typeof generateConversationVideo>[0] & {
    characterName: string;
    avatarPath: string | null;
    selfieContext: string;
  },
): Promise<{
  kind: ConversationVideoResult["firstFrame"];
  image: VideoReferenceImage | undefined;
  tag: string | null;
  path: string | null;
}> {
  const gallery = createGalleryStorage(args.db);
  const fromGallery = async (galleryImageId: string) => {
    const image = await gallery.getById(galleryImageId, args.chatId);
    const path = image ? resolveGalleryImagePath(image) : null;
    if (!image || !path) throw new ChatVideoError(404, "Gallery image not found");
    const reference = readVideoReferenceImage(readFileSync(path).toString("base64"));
    if (!reference) throw new ChatVideoError(400, "Video messages need a PNG or JPEG picture to start from.");
    return {
      kind: "gallery" as const,
      image: reference,
      tag: `gallery:${image.id}`,
      path: `gallery/${image.filePath.replace(/\\/g, "/")}`,
    };
  };
  if (args.galleryImageId?.trim()) return fromGallery(args.galleryImageId.trim());

  const mode = normalizeVideoFirstFrame(args.chatMeta.sceneVideoFirstFrame);
  if (mode === "prompt_only") return { kind: "none", image: undefined, tag: null, path: null };

  const hasSelfieConnection =
    typeof args.chatMeta.imageGenConnectionId === "string" && args.chatMeta.imageGenConnectionId.trim().length > 0;
  if (mode === "picture" || (mode === "picture_or_avatar" && hasSelfieConnection)) {
    try {
      const selfie = await takeSelfie(args);
      return { ...(await fromGallery(selfie)), kind: "selfie" };
    } catch (err) {
      if (mode === "picture") throw err;
      logger.warn(err, "[conversation/video] Selfie first frame failed; using the avatar instead");
    }
  }

  const avatar = await readPreferredCharacterReferenceImage({
    characterId: args.characterId,
    avatarPath: args.avatarPath,
    characterGallery: createCharacterGalleryStorage(args.db),
  });
  const reference = avatar ? readVideoReferenceImage(avatar.base64) : null;
  if (!reference) {
    throw new ChatVideoError(
      400,
      `${args.characterName} needs a PNG or JPEG avatar or sprite to start a video from. Pick another first frame in Chat Settings.`,
    );
  }
  return { kind: "avatar", image: reference, tag: `avatar:${args.characterId}`, path: null };
}

/** Run the chat's selfie pipeline for one image and return its gallery id. */
async function takeSelfie(
  args: Parameters<typeof generateConversationVideo>[0] & { characterName: string; selfieContext: string },
): Promise<string> {
  let galleryId: string | null = null;
  let error: string | null = null;
  await handleConversationSelfieCommand({
    command: { type: "selfie", context: args.selfieContext || undefined },
    characterId: args.characterId,
    chatId: args.chatId,
    messageId: null,
    chatMeta: { ...args.chatMeta, illustratorImagesPerGeneration: 1 },
    charInfo: args.charInfo,
    persona: null,
    // The selfie runtime resolves the Prompt Model the same way; a chat with neither reports it as a selfie error.
    promptConnection: args.promptConnection as IllustratorPromptConnection,
    promptConnectionId: args.promptConnectionId ?? "",
    debugMode: args.debugMode,
    serviceTier: args.serviceTier ?? null,
    db: args.db,
    chars: createCharactersStorage(args.db),
    chats: createChatsStorage(args.db),
    connections: createConnectionsStorage(args.db),
    sendEvent: (event) => {
      const data = parseRecord(event.data);
      if (event.type === "selfie" && typeof data.galleryId === "string") galleryId ??= data.galleryId;
      if (event.type === "selfie_error") error = typeof data.error === "string" ? data.error : "Selfie failed";
    },
  });
  if (!galleryId) throw new ChatVideoError(502, error ?? "The selfie for this video could not be made.");
  return galleryId;
}

function parseRecord(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/** How many recent messages Illustrator reads for a picture (its Agent Budget context size); videos read as many. */
export async function loadIllustratorContextSize(db: DB): Promise<number> {
  const illustrator = await createAgentsStorage(db)
    .getByType("illustrator")
    .catch(() => null);
  return normalizeAgentContextSize(
    mergeBuiltInAgentSettings("illustrator", parseAgentSettingsRecord(illustrator?.settings)).contextSize,
  );
}
