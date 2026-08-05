import {
  noodleGeneratedFanRefreshSchema,
  type NoodleAccount,
  type NoodleGeneratedFanRefresh,
  type NoodleInteraction,
  type NoodlePost,
  type NoodleSettings,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { logDebugOverride } from "../../lib/logger.js";
import { resolveBaseUrl } from "../generation/connection-base-url.js";
import { resolveStoredChatOptions, resolveStoredMaxTokens } from "../generation/generation-parameters.js";
import { clampGenerationMaxOutputTokens } from "../generation/output-token-limits.js";
import { parseGameJsonish } from "../game/jsonish.js";
import { withConnectionFallbackProvider } from "../llm/connection-fallback-provider.js";
import type { ChatMessage } from "../llm/base-provider.js";
import { createLLMProvider } from "../llm/provider-registry.js";
import { createConnectionsStorage } from "../storage/connections.storage.js";
import { createNoodleStorage } from "../storage/noodle.storage.js";
import { ensureAmbientNoodleAccounts, isAmbientNoodleAccount } from "./noodle-ambient-profiles.js";
import { formatNoodleMessagesForLog } from "./noodle-generation-log.js";
import { noodleResponseFormat } from "./noodle-response-format.js";

type GenerationConnection = NonNullable<Awaited<ReturnType<ReturnType<typeof createConnectionsStorage>["getWithKey"]>>>;

const MAX_FAN_POSTS = 80;

export function selectNoodlerFanActivities(input: {
  activities: NoodleGeneratedFanRefresh["activities"];
  actors: readonly NoodleAccount[];
  posts: readonly Pick<NoodlePost, "id" | "access">[];
  existingInteractions: readonly Pick<NoodleInteraction, "postId" | "actorAccountId" | "type" | "content">[];
  quotas: { like: number; reply: number; repost: number };
}) {
  const actorByHandle = new Map(input.actors.map((actor) => [actor.handle.toLowerCase(), actor]));
  const publicPostIds = new Set(input.posts.filter((post) => post.access === "public").map((post) => post.id));
  const seen = new Set(
    input.existingInteractions.map(
      (interaction) =>
        `${interaction.postId}:${interaction.actorAccountId}:${interaction.type}:${interaction.content ?? ""}`,
    ),
  );
  const quotas = { ...input.quotas };
  const selected: Array<{
    actor: NoodleAccount;
    postId: string;
    type: "like" | "reply" | "repost";
    content: string | null;
  }> = [];
  for (const activity of input.activities) {
    if (quotas[activity.type] <= 0 || !publicPostIds.has(activity.targetPostId)) continue;
    const actor = actorByHandle.get(activity.actorHandle.toLowerCase());
    if (!actor) continue;
    const content = activity.type === "reply" ? activity.content?.trim() || null : null;
    if (activity.type === "reply" && !content) continue;
    const key = `${activity.targetPostId}:${actor.id}:${activity.type}:${content ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    quotas[activity.type] -= 1;
    selected.push({ actor, postId: activity.targetPostId, type: activity.type, content });
  }
  return selected;
}

function buildFanActivityMessages(input: {
  actors: NoodleAccount[];
  posts: Array<{ id: string; title: string | null; content: string }>;
  settings: NoodleSettings;
}): ChatMessage[] {
  const system = [
    "You propose a small amount of synthetic audience activity for public NoodleR posts.",
    "Use only the supplied random audience accounts and post IDs.",
    "Likes and reposts have no content. Replies are short, natural, and relevant to the post.",
    "Do not mention hidden information, locked posts, private data, or that the audience is synthetic.",
    "Return JSON only with an activities array. Never invent an actor handle or post ID.",
    `At most ${input.settings.fanLikesPerRefresh} likes, ${input.settings.fanRepliesPerRefresh} replies, and ${input.settings.fanRepostsPerRefresh} reposts may be proposed.`,
  ].join("\n");
  const data = {
    actors: input.actors.map((actor) => ({ handle: actor.handle, displayName: actor.displayName, bio: actor.bio })),
    posts: input.posts,
  };
  return [
    { role: "system", content: system },
    { role: "user", content: `# NoodleR audience data\n${JSON.stringify(data, null, 2)}` },
  ];
}

async function generateFanActivity(input: {
  db: DB;
  connection: GenerationConnection;
  settings: NoodleSettings;
  actors: NoodleAccount[];
  posts: Array<{ id: string; title: string | null; content: string }>;
  debugMode: boolean;
}): Promise<NoodleGeneratedFanRefresh> {
  const connections = createConnectionsStorage(input.db);
  const fallbackConnection = await connections.getFallbackForMain();
  const provider = withConnectionFallbackProvider({
    primary: createLLMProvider(
      input.connection.provider,
      resolveBaseUrl(input.connection),
      input.connection.apiKey,
      input.connection.maxContext,
      input.connection.openrouterProvider,
      input.connection.maxTokensOverride,
      input.connection.claudeFastMode === "true",
      input.connection.treatAsLocalEndpoint === "true",
      input.connection.defaultParameters,
    ),
    primaryConnectionId: input.connection.id,
    fallbackConnection,
    fallbackBaseUrl: fallbackConnection ? resolveBaseUrl(fallbackConnection) : "",
    category: "main",
  });
  const messages = buildFanActivityMessages(input);
  logDebugOverride(
    input.debugMode,
    "[debug/noodler-fan] Prompt sent to model:\n%s",
    formatNoodleMessagesForLog(messages),
  );
  const response = await provider.chatComplete(messages, {
    model: input.connection.model,
    maxTokens: clampGenerationMaxOutputTokens({
      provider: input.connection.provider,
      model: input.connection.model,
      maxTokens: resolveStoredMaxTokens(input.connection.defaultParameters, 1024),
      maxTokensOverride: input.connection.maxTokensOverride,
    }),
    temperature: 0.8,
    topP: 0.95,
    ...resolveStoredChatOptions(input.connection.defaultParameters, input.connection.provider, input.connection.model),
    stream: false,
    debugMode: input.debugMode,
    responseFormat: noodleResponseFormat(input.connection.model, "noodler_fan_activity"),
  });
  const content = response.content ?? "";
  logDebugOverride(input.debugMode, "[debug/noodler-fan] Raw model response:\n%s", content);
  return noodleGeneratedFanRefreshSchema.parse(parseGameJsonish(content));
}

export async function generateAndApplyNoodlerFanActivity(input: { db: DB; debugMode?: boolean }): Promise<{
  status: "generated" | "disabled" | "connection_required" | "connection_not_found" | "no_actors" | "no_posts";
  created: number;
}> {
  const noodle = createNoodleStorage(input.db);
  const settings = await noodle.getSettings();
  if (!settings.enableNoodler || !settings.fanActivityEnabled) return { status: "disabled", created: 0 };
  if (!settings.generationConnectionId) return { status: "connection_required", created: 0 };
  const connection = await createConnectionsStorage(input.db).getWithKey(settings.generationConnectionId);
  if (!connection) return { status: "connection_not_found", created: 0 };

  await ensureAmbientNoodleAccounts(noodle, false);
  const actors = (await noodle.listAccounts()).filter(isAmbientNoodleAccount);
  if (actors.length === 0) return { status: "no_actors", created: 0 };
  const creators = await noodle.listNoodlerAccounts();
  const grouped = await noodle.listNoodlerPostsByAccounts(
    creators.map((creator) => creator.id),
    MAX_FAN_POSTS,
  );
  const posts = [...grouped.values()]
    .flat()
    .filter((post) => post.access === "public")
    .slice(0, MAX_FAN_POSTS)
    .map((post) => ({ id: post.id, title: post.title, content: post.content }));
  if (posts.length === 0) return { status: "no_posts", created: 0 };

  const generated = await generateFanActivity({
    db: input.db,
    connection,
    settings,
    actors,
    posts,
    debugMode: input.debugMode === true,
  });
  const interactions = await noodle.listNoodlerInteractions(posts.map((post) => post.id));
  const selected = selectNoodlerFanActivities({
    activities: generated.activities,
    actors,
    posts: posts.map((post) => ({ id: post.id, access: "public" as const })),
    existingInteractions: interactions,
    quotas: {
      like: settings.fanLikesPerRefresh,
      reply: settings.fanRepliesPerRefresh,
      repost: settings.fanRepostsPerRefresh,
    },
  });
  let created = 0;
  for (const activity of selected) {
    const result = await noodle.createNoodlerFanInteraction(activity.postId, {
      actorAccountId: activity.actor.id,
      type: activity.type,
      content: activity.content,
    });
    if (!result?.created) continue;
    created += 1;
  }
  return { status: "generated", created };
}
