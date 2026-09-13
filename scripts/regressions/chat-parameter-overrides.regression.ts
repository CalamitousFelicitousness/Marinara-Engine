// Chat parameter overrides: per-chat Connection / Override / Off states over the layers below the chat.
// Pins: tolerant parsing, legacy chatParameters conversion, the runtime layer order (scene, game mode, Gemma game
// setup, managed parameters), the one-way startup conversion, and the baseline endpoint the chat panel reads.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "marinara-chat-parameter-overrides-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const {
  CUSTOM_GENERATION_PARAMETERS_SETTINGS_KEY,
  DEFAULT_GENERATION_PARAMS,
  chatOverridesAsStoredParameters,
  effectiveChatParameterOverrides,
  legacyChatParameterOverrides,
  parseChatParameterOverrides,
  stripChatSamplerParameters,
  stripLegacyChatParameters,
} = await import("../../packages/shared/dist/index.js");
const { defaultGenerationParameterValues, resolveGenerationParameterRuntime } =
  await import("../../packages/server/src/services/generation/provider-generation-runtime.js");
const { resolveModelAccessPolicy } =
  await import("../../packages/server/src/services/generation/model-access-policy.js");
const { buildLegacyChatParameterPatch, hasLegacyChatParameters } =
  await import("../../packages/server/src/services/generation/legacy-chat-parameter-migration.js");
const { registerParameterBaselineRoute } =
  await import("../../packages/server/src/routes/generate/parameter-baseline-route.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createPromptsStorage } = await import("../../packages/server/src/services/storage/prompts.storage.js");
const { createAppSettingsStorage } = await import("../../packages/server/src/services/storage/app-settings.storage.js");

// ── Parsing ──

{
  const parsed = parseChatParameterOverrides(
    JSON.stringify({
      temperature: { mode: "override", value: 0 },
      topP: { mode: "override", value: 7 },
      verbosity: { mode: "override", value: null },
      assistantPrefill: { mode: "override", value: "" },
      maxTokens: { mode: "override" },
      topK: { mode: "off" },
      postProcessing: { mode: "off" },
      serviceTier: { mode: "override", value: "flex" },
      managed: { minp: { mode: "override", value: 0.2 } },
    }),
  );
  assert.deepEqual(parsed.temperature, { mode: "override", value: 0 }, "zero is a real value");
  assert.equal(parsed.topP, undefined, "an out-of-range value is dropped on its own");
  assert.deepEqual(parsed.verbosity, { mode: "override", value: null });
  assert.deepEqual(parsed.assistantPrefill, { mode: "override", value: "" });
  assert.equal(parsed.maxTokens, undefined, "an override without a value is dropped");
  assert.deepEqual(parsed.topK, { mode: "off" });
  assert.equal(parsed.postProcessing, undefined, "post-processing has no Off state");
  assert.deepEqual(parsed.serviceTier, { mode: "override", value: "flex" });
  assert.deepEqual(parsed.managed, { minp: { mode: "override", value: 0.2 } });
  assert.deepEqual(parseChatParameterOverrides("not json"), {});
}

// ── Legacy chatParameters ──

{
  const legacyBlob = {
    temperature: 0.9,
    topP: 0.5,
    minP: 0.1,
    enabledParameters: { topP: false },
    assistantPrefill: "Sure,",
    customThinkingTags: [{ open: "<t>", close: "</t>" }],
    strictRoleFormatting: false,
    serviceTier: "priority",
    managedCustomParameters: { minp: { enabled: false, value: 0.3 }, rep: { enabled: true, value: 1.1 } },
    customParameters: { seed: 7 },
    stopSequences: ["END"],
  };
  const legacy = legacyChatParameterOverrides(legacyBlob);
  assert.equal(legacy.temperature, undefined, "saved sampling values are not carried over");
  assert.equal(legacy.topP, undefined);
  assert.deepEqual(legacy.assistantPrefill, { mode: "override", value: "Sure," });
  assert.deepEqual(legacy.postProcessing, {
    mode: "override",
    value: { strictRoleFormatting: false, singleUserMessage: false },
  });
  assert.deepEqual(legacy.serviceTier, { mode: "override", value: "priority" });
  assert.deepEqual(legacy.managed, { minp: { mode: "off" }, rep: { mode: "override", value: 1.1 } });
  assert.deepEqual(stripLegacyChatParameters(legacyBlob), { customParameters: { seed: 7 }, stopSequences: ["END"] });
  assert.deepEqual(
    Object.keys(stripChatSamplerParameters(legacyBlob) ?? {}).sort(),
    [
      "assistantPrefill",
      "customParameters",
      "customThinkingTags",
      "managedCustomParameters",
      "serviceTier",
      "stopSequences",
      "strictRoleFormatting",
    ],
    "profiles and wizard defaults keep the fields that still convert",
  );
  assert.equal(stripLegacyChatParameters({ topP: 1 }), null);

  const effective = effectiveChatParameterOverrides(legacyBlob, {
    assistantPrefill: { mode: "off" },
    managed: { rep: { mode: "off" } },
  });
  assert.deepEqual(effective.assistantPrefill, { mode: "off" }, "explicit states win over legacy values");
  assert.deepEqual(effective.managed, { minp: { mode: "off" }, rep: { mode: "off" } });

  assert.deepEqual(
    chatOverridesAsStoredParameters({
      topP: { mode: "override", value: 0.8 },
      temperature: { mode: "off" },
      assistantPrefill: { mode: "off" },
      customThinkingTags: { mode: "off" },
      managed: { rep: { mode: "off" } },
    }),
    {
      topP: 0.8,
      enabledParameters: { temperature: false, topP: true },
      assistantPrefill: "",
      customThinkingTags: [],
      managedCustomParameters: { rep: { enabled: false, value: 0 } },
    },
  );
}

// ── Runtime layers ──

function resolve(args: {
  provider?: string;
  model?: string;
  chatMode?: string;
  isSceneChat?: boolean;
  connectionParameters?: unknown;
  chatParameters?: unknown;
  chatParameterOverrides?: unknown;
  gameSetupParameters?: unknown;
  managedParameterDefinitions?: Array<{ id: string; name: string; requestKey: string; min: number; max: number }>;
}) {
  const provider = args.provider ?? "openai";
  const model = args.model ?? "gpt-4o";
  return resolveGenerationParameterRuntime({
    connection: { provider, model, defaultParameters: args.connectionParameters },
    chatMode: args.chatMode ?? "roleplay",
    isSceneChat: args.isSceneChat ?? false,
    chatParameters: args.chatParameters,
    chatParameterOverrides: args.chatParameterOverrides,
    gameSetupParameters: args.gameSetupParameters,
    managedParameterDefinitions: args.managedParameterDefinitions ?? [],
    modelAccessPolicy: resolveModelAccessPolicy({ provider, model }),
    initial: { ...defaultGenerationParameterValues(), effectiveMaxContext: undefined },
  });
}

{
  const legacyOnly = resolve({
    connectionParameters: { topP: 0.95, assistantPrefill: "Hi" },
    chatParameters: { topP: 0.5, enabledParameters: { topP: false }, assistantPrefill: "Sure," },
  });
  assert.equal(legacyOnly.topP, 0.95);
  assert.equal(legacyOnly.enabledParameters?.topP, undefined);
  assert.equal(legacyOnly.assistantPrefill, "Sure,", "a saved prefill keeps working as an override");

  const off = resolve({
    connectionParameters: { topP: 0.95, enabledParameters: { topP: true } },
    chatParameterOverrides: {
      topP: { mode: "off" },
      assistantPrefill: { mode: "off" },
      customThinkingTags: { mode: "off" },
    },
  });
  assert.equal(off.enabledParameters?.topP, false);
  assert.equal(off.sendSwitchSources.topP, "chat");
  assert.equal(off.topP, 0.95, "Off keeps the value that would otherwise be sent");
  assert.equal(off.parameterSources.topP, "connection");
  assert.equal(off.assistantPrefill, "");
  assert.deepEqual(off.customThinkingTags, []);

  const definitions = [{ id: "minp", name: "Min P", requestKey: "min_p", min: 0, max: 1 }];
  const connectionManaged = { managedCustomParameters: { minp: { enabled: true, value: 0.1 } } };
  const managedOverride = resolve({
    managedParameterDefinitions: definitions,
    connectionParameters: connectionManaged,
    chatParameterOverrides: { managed: { minp: { mode: "override", value: 0.3 } } },
  });
  assert.equal(managedOverride.customParameters.min_p, 0.3);
  const managedOff = resolve({
    managedParameterDefinitions: definitions,
    connectionParameters: connectionManaged,
    chatParameterOverrides: { managed: { minp: { mode: "off" } } },
  });
  assert.equal(managedOff.customParameters.min_p, undefined);

  const postProcessing = resolve({
    connectionParameters: { strictRoleFormatting: true },
    chatParameterOverrides: {
      postProcessing: { mode: "override", value: { strictRoleFormatting: false, singleUserMessage: true } },
    },
  });
  assert.equal(postProcessing.chatOverrideParams?.strictRoleFormatting, false);
  assert.equal(postProcessing.chatOverrideParams?.singleUserMessage, true);

  const game = resolve({
    chatMode: "game",
    provider: "custom",
    model: "fixture",
    connectionParameters: { temperature: 0.4, maxTokens: 1000 },
  });
  assert.equal(game.temperature, 1);
  assert.equal(game.parameterSources.temperature, "game mode");
  assert.equal(game.maxTokens, 16_384);

  const gameOverride = resolve({
    chatMode: "game",
    provider: "custom",
    model: "fixture",
    chatParameterOverrides: {
      maxTokens: { mode: "override", value: 2000 },
      temperature: { mode: "override", value: 0.6 },
    },
  });
  assert.equal(gameOverride.maxTokens, 2000, "an overridden budget skips the game floor");
  assert.equal(gameOverride.temperature, 0.6);
  assert.equal(gameOverride.parameterSources.temperature, "chat");

  const gemma = resolve({
    chatMode: "game",
    provider: "custom",
    model: "gemma-3-27b",
    gameSetupParameters: { topP: 0.8, assistantPrefill: "GM:" },
  });
  assert.equal(gemma.topP, 0.8, "Gemma games keep their game setup values");
  assert.equal(gemma.parameterSources.topP, "game mode");
  assert.equal(gemma.assistantPrefill, "GM:");
  assert.equal(gemma.maxTokens, 16_384);

  const scene = resolve({ isSceneChat: true, connectionParameters: { maxTokens: 1000 } });
  assert.equal(scene.maxTokens, 8192);
  assert.equal(scene.parameterSources.maxTokens, "scene");
  const sceneOverride = resolve({
    isSceneChat: true,
    chatParameterOverrides: { maxTokens: { mode: "override", value: 3000 } },
  });
  assert.equal(sceneOverride.maxTokens, 3000, "a chat override wins over scene values");
  assert.equal(sceneOverride.parameterSources.maxTokens, "chat");
}

// ── Startup conversion ──

{
  const baseline = {
    connection: { kind: "connection", id: "c", provider: "openai", model: "gpt-4o" },
    mode: "roleplay",
    scene: false,
    suppressModelParameters: false,
    parameters: null,
    fields: {
      assistantPrefill: { value: "Sure,", source: "connection" },
      assistantReasoningPrefill: { value: "", source: "default" },
      customThinkingTags: { value: [], source: "default" },
      postProcessing: { value: { strictRoleFormatting: true, singleUserMessage: false }, source: "default" },
      serviceTier: { value: null, source: "default" },
    },
    managed: {
      minp: { enabled: false, value: 0, source: "default" },
      rep: { enabled: true, value: 1.1, source: "connection" },
    },
    customParameters: {},
  } as never;
  const metadata = {
    chatParameters: {
      topP: 0.5,
      enabledParameters: { topP: false },
      assistantPrefill: "Sure,",
      assistantReasoningPrefill: "Thinking:",
      strictRoleFormatting: true,
      singleUserMessage: false,
      managedCustomParameters: { minp: { enabled: false, value: 0.3 }, rep: { enabled: true, value: 1.5 } },
      customParameters: { seed: 7 },
    },
    chatParameterOverrides: { serviceTier: { mode: "override", value: "flex" } },
  };
  const patch = buildLegacyChatParameterPatch(metadata, baseline);
  assert.deepEqual(patch, {
    chatParameters: { customParameters: { seed: 7 } },
    chatParameterOverrides: {
      serviceTier: { mode: "override", value: "flex" },
      assistantReasoningPrefill: { mode: "override", value: "Thinking:" },
      managed: { rep: { mode: "override", value: 1.5 } },
    },
  });
  const applied = { ...metadata, ...patch };
  assert.equal(hasLegacyChatParameters(applied.chatParameters), false);
  assert.equal(buildLegacyChatParameterPatch(applied, baseline), null, "a second run finds nothing to convert");
  assert.deepEqual(
    buildLegacyChatParameterPatch({ chatParameters: { assistantPrefill: "Sure," } }, null),
    { chatParameters: null, chatParameterOverrides: { assistantPrefill: { mode: "override", value: "Sure," } } },
    "without a baseline every saved field stays an override",
  );
  assert.equal(buildLegacyChatParameterPatch({ chatParameters: { customParameters: { seed: 1 } } }, baseline), null);
}

// ── Baseline endpoint ──

const db = await getDB();
const chats = createChatsStorage(db);
const connections = createConnectionsStorage(db);
const presets = createPromptsStorage(db);
const appSettings = createAppSettingsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(async (instance) => registerParameterBaselineRoute(instance), { prefix: "/api/generate" });

try {
  const baselineFor = async (query: Record<string, string>) => {
    const response = await app.inject({
      method: "GET",
      url: `/api/generate/parameter-baseline?${new URLSearchParams(query).toString()}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  await appSettings.set(
    CUSTOM_GENERATION_PARAMETERS_SETTINGS_KEY,
    JSON.stringify([{ id: "minp", name: "Min P", requestKey: "min_p", min: 0, max: 1 }]),
  );

  const connectionInput = { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", apiKey: "k" };
  const tuned = (await connections.create({ name: "Tuned", ...connectionInput } as never)) as { id: string };
  await connections.updateDefaultParameters(tuned.id, {
    topP: 0.95,
    temperature: 0.7,
    enabledParameters: { temperature: false },
    assistantPrefill: "Sure,",
    managedCustomParameters: { minp: { enabled: true, value: 0.2 } },
  });
  const plain = (await connections.create({ name: "Plain", ...connectionInput } as never)) as { id: string };
  const chatInput = { characterIds: [], groupId: null, personaId: null, personaCharacterId: null };
  const chat = (await chats.create({
    name: "Tuned chat",
    mode: "conversation",
    promptPresetId: null,
    connectionId: tuned.id,
    ...chatInput,
  } as never)) as { id: string };

  const fromConnection = await baselineFor({ chatId: chat.id });
  assert.equal(fromConnection.connection.kind, "connection");
  assert.deepEqual(fromConnection.parameters.topP, { value: 0.95, sent: true, source: "connection", notSentBy: null });
  assert.equal(fromConnection.parameters.temperature.value, 0.7, "a switched-off value is still reported");
  assert.equal(fromConnection.parameters.temperature.sent, false);
  assert.equal(fromConnection.parameters.temperature.notSentBy, "connection");
  assert.deepEqual(fromConnection.fields.assistantPrefill, { value: "Sure,", source: "connection" });
  assert.deepEqual(fromConnection.managed.minp, { enabled: true, value: 0.2, source: "connection" });

  await chats.patchMetadata(chat.id, {
    chatParameterOverrides: { topP: { mode: "override", value: 0.5 } },
    chatParameters: { assistantPrefill: "Chat says" },
  });
  const stillBelow = await baselineFor({ chatId: chat.id });
  assert.equal(stillBelow.parameters.topP.value, 0.95, "the chat's own values are not part of the baseline");
  assert.equal(stillBelow.fields.assistantPrefill.value, "Sure,");

  const preset = (await presets.create({
    name: "Warm preset",
    parameters: { ...DEFAULT_GENERATION_PARAMS, temperature: 1.2 },
  } as never)) as { id: string };
  const roleplay = (await chats.create({
    name: "Roleplay chat",
    mode: "roleplay",
    promptPresetId: preset.id,
    connectionId: plain.id,
    ...chatInput,
  } as never)) as { id: string };
  const fromPreset = await baselineFor({ chatId: roleplay.id });
  assert.equal(fromPreset.parameters.temperature.value, 1.2);
  assert.equal(fromPreset.parameters.temperature.source, "preset");
  const withoutPreset = await baselineFor({ chatId: roleplay.id, promptPresetId: "" });
  assert.equal(withoutPreset.parameters.maxTokens.value, 4096);
  assert.equal(withoutPreset.parameters.maxTokens.source, "default");

  const gameBaseline = await baselineFor({ connectionId: plain.id, mode: "game" });
  assert.equal(gameBaseline.parameters.temperature.source, "game mode");

  await chats.patchMetadata(roleplay.id, { sceneStatus: "active" });
  const sceneBaseline = await baselineFor({ chatId: roleplay.id });
  assert.equal(sceneBaseline.parameters.maxTokens.value, 8192);
  assert.equal(sceneBaseline.parameters.maxTokens.source, "scene");

  const queryConnection = await baselineFor({ chatId: chat.id, connectionId: plain.id });
  assert.equal(queryConnection.connection.id, plain.id, "a query connection replaces the chat's");
  assert.equal(queryConnection.parameters.topP.source, "default");

  const random = await baselineFor({ connectionId: "random", mode: "roleplay" });
  assert.equal(random.connection.kind, "random");
  assert.equal(random.parameters, null);

  const missing = await app.inject({ method: "GET", url: "/api/generate/parameter-baseline?chatId=missing" });
  assert.equal(missing.statusCode, 404);
} finally {
  await app.close();
  await closeDB();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A handle Windows still holds on the temp directory is not a test result.
  }
}

console.log("Chat parameter overrides regression passed.");
