import {
  VIDEO_GENERATION_SETTINGS_KEY,
  normalizeVideoGenerationUserSettings,
  type GeneratedSceneVideo,
  type VideoReferenceImage,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { resolveVideoConnectionFallback } from "../generation/media-connection-fallback.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createConnectionsStorage } from "../storage/connections.storage.js";
import { createGameSceneVideosStorage } from "../storage/game-scene-videos.storage.js";
import { resolveSceneVideoConnectionId, serializeSceneVideo } from "./chat-video-messages.js";
import { resolveGameVideoRuntime } from "./game-video-runtime.js";
import { generateVideo, removeSavedVideoFromDisk, saveVideoToDisk } from "./video-generation.js";

/** A problem the user can fix (missing connection, unusable picture); `statusCode` suits an HTTP reply. */
export class ChatVideoError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 502,
    message: string,
  ) {
    super(message);
    this.name = "ChatVideoError";
  }
}

export type ChatVideoSetup = Awaited<ReturnType<typeof resolveChatVideoSetup>>;

/** The chat's video connection with its runtime, clip length and aspect ratio. */
export async function resolveChatVideoSetup(db: DB, chatMeta: Record<string, unknown>) {
  const connections = createConnectionsStorage(db);
  const videoConnectionId = await resolveSceneVideoConnectionId(chatMeta, connections);
  if (!videoConnectionId) {
    throw new ChatVideoError(400, "Choose a video connection in Chat Settings before making a video.");
  }
  const videoConn = await connections.getWithKey(videoConnectionId);
  if (!videoConn) throw new ChatVideoError(404, "Video generation connection not found");
  if (videoConn.provider !== "video_generation") {
    throw new ChatVideoError(400, "The selected connection is not a video generation connection.");
  }
  const runtime = resolveGameVideoRuntime(videoConn);
  const videoSettings = normalizeVideoGenerationUserSettings(
    await createAppSettingsStorage(db).get(VIDEO_GENERATION_SETTINGS_KEY),
  );
  const durationSeconds = Math.min(
    runtime.maxDurationSeconds,
    Math.max(
      runtime.minDurationSeconds,
      Math.trunc(
        runtime.hasStoredDefaults ? runtime.activeDefaults.durationSeconds : videoSettings.sceneVideoDurationSeconds,
      ),
    ),
  );
  return { videoConnectionId, videoConn, runtime, durationSeconds, aspectRatio: runtime.activeDefaults.aspectRatio };
}

/** Generate the clip, save it to disk and the chat's scene videos, and return it. */
export async function generateAndSaveChatVideo(
  db: DB,
  setup: ChatVideoSetup,
  args: {
    chatId: string;
    prompt: string;
    referenceImage?: VideoReferenceImage;
    sourceTag: string | null;
    sourcePath: string | null;
    queue?: boolean;
    signal?: AbortSignal;
    debugMode?: boolean;
  },
): Promise<GeneratedSceneVideo> {
  const { runtime, videoConnectionId, durationSeconds, aspectRatio } = setup;
  let savedFilePath: string | null = null;
  try {
    const generated = await generateVideo(runtime.source, runtime.baseUrl, runtime.apiKey, runtime.serviceHint, {
      prompt: args.prompt,
      model: runtime.model,
      durationSeconds,
      aspectRatio,
      resolution: runtime.resolution,
      comfyWorkflow: runtime.comfyWorkflow,
      comfyLoras: runtime.comfyLoras,
      fps: runtime.comfyFps,
      atlasModelOptions: runtime.atlasModelOptions,
      referenceImage: args.referenceImage,
      publicReferenceUpload: runtime.publicReferenceUpload,
      queue: args.queue,
      connectionKey: videoConnectionId,
      signal: args.signal,
      debugMode: args.debugMode,
      fallback: await resolveVideoConnectionFallback(createConnectionsStorage(db), videoConnectionId),
    });
    savedFilePath = await saveVideoToDisk(args.chatId, generated.base64);
    const row = await createGameSceneVideosStorage(db).create({
      chatId: args.chatId,
      filePath: savedFilePath,
      sourceIllustrationTag: args.sourceTag,
      sourceIllustrationPath: args.sourcePath,
      prompt: args.prompt,
      provider: runtime.source,
      model: runtime.model,
      durationSeconds,
      aspectRatio,
    });
    if (!row) throw new Error("Video metadata could not be saved");
    savedFilePath = null;
    await createChatsStorage(db).patchMetadata(args.chatId, () => ({ sceneLastVideoId: row.id }));
    logger.info("[chat-video] saved video %s for chat %s", row.id, args.chatId);
    return serializeSceneVideo(row);
  } finally {
    if (savedFilePath) {
      await removeSavedVideoFromDisk(savedFilePath).catch((err) => {
        logger.warn(err, "[chat-video] Failed to clean up orphaned video file %s", savedFilePath);
      });
    }
  }
}

/** A video backend takes PNG or JPEG; tell them apart by their first bytes. */
export function readVideoReferenceImage(base64: string): VideoReferenceImage | null {
  const raw = base64.replace(/^data:[^,]+,/u, "");
  const head = Buffer.from(raw.slice(0, 16), "base64");
  if (head[0] === 0x89 && head.subarray(1, 4).toString("ascii") === "PNG")
    return { base64: raw, mimeType: "image/png" };
  if (head[0] === 0xff && head[1] === 0xd8) return { base64: raw, mimeType: "image/jpeg" };
  return null;
}
