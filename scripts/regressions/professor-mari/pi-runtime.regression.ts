// Pins Professor Mari's optional pi runtime with a scripted fake provider: no network, no real model.
// Covers the tool-call round trip through WorkspaceCommands, the Permissions Mode floors (Manual holds,
// Plan refuses), abort, the classic default, the closed tool set and the claim-audit repair.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionResult, ChatMessage, ChatOptions } from "../../../packages/server/src/services/llm/base-provider.js";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-mari-pi-storage-"));
const workspaceDir = mkdtempSync(join(tmpdir(), "marinara-mari-pi-workspace-"));
const previousStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;
const { getDB, closeDB } = await import("../../../packages/server/src/db/connection.js");

type Scripted = ChatCompletionResult | ((options: ChatOptions) => Promise<ChatCompletionResult>);
const reply = (content: string, toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []) =>
  ({
    content,
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  }) satisfies ChatCompletionResult;

try {
  const db = await getDB();
  const { ProfessorMariWorkspaceService, WORKSPACE_TOOL_DEFINITIONS } =
    await import("../../../packages/server/src/services/professor-mari/workspace-agent.service.js");
  const { createChatsStorage } = await import("../../../packages/server/src/services/storage/chats.storage.js");
  const { createAppSettingsStorage } = await import("../../../packages/server/src/services/storage/app-settings.storage.js");
  const { MARI_RUNTIME_SETTINGS_KEY } = await import("../../../packages/shared/src/constants/mari-runtime.js");
  const chats = createChatsStorage(db);
  const settings = createAppSettingsStorage(db);

  writeFileSync(join(workspaceDir, "hello.txt"), "hi from the workspace file\n");

  const service = new ProfessorMariWorkspaceService({ db } as never);
  service.setEnabled(true, workspaceDir);
  let mode: "auto" | "manual" | "plan" = "auto";
  let script: Scripted[] = [];
  let requests: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  let runtimeSeen: unknown[] = [];
  let piEntered = 0;
  const originalRunPi = (service as unknown as { runPiRuntime: (args: unknown) => Promise<void> }).runPiRuntime.bind(service);
  Object.assign(service, {
    ensureMariCliShim: async () => {},
    resolveConnection: async () => ({
      id: "mari-pi-runtime",
      name: "Regression",
      provider: "custom",
      model: "fake-model",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "",
      maxContext: 32768,
    }),
    resolvePermissionsMode: async () => ({ mode, defaultMode: mode, source: "chat" }),
    buildPromptMessages: async (_chat: string, _conn: unknown, _mode: unknown, _handoff: unknown, runtime: unknown) => {
      runtimeSeen.push(runtime);
      return {
        messages: [
          { role: "system", content: "You are Professor Mari (regression).", contextKind: "prompt" },
          { role: "user", content: "Do the thing.", contextKind: "history" },
        ],
        manualApprovalArmed: false,
      };
    },
    runPiRuntime: async (args: unknown) => {
      piEntered += 1;
      return originalRunPi(args);
    },
    chatCompleteWorkspace: async (_provider: unknown, messages: ChatMessage[], options: ChatOptions) => {
      requests.push({ messages: structuredClone(messages), options });
      const next = script.shift();
      if (!next) throw new Error("The scripted provider ran out of replies.");
      return typeof next === "function" ? next(options) : next;
    },
  });

  const run = async (name: string, nextScript: Scripted[], runtime: "pi" | "classic" = "pi") => {
    script = [...nextScript];
    requests = [];
    runtimeSeen = [];
    piEntered = 0;
    await settings.set(MARI_RUNTIME_SETTINGS_KEY, runtime);
    const chat = await chats.create({ name, mode: "conversation", characterIds: [] });
    const events: Array<{ type: string; data?: unknown }> = [];
    const done = service.prompt({ chatId: chat.id, text: "Do the thing.", onEvent: (event) => events.push(event) });
    return { chat, events, done };
  };
  const lastAssistant = async (chatId: string) => {
    const rows = (await chats.listMessages(chatId)).filter((message) => message.role === "assistant");
    const row = rows[rows.length - 1];
    return row ? { content: String(row.content), extra: JSON.parse(String(row.extra ?? "{}")) as Record<string, unknown> } : null;
  };

  // (a) + (f): a read tool call runs through WorkspaceCommands and its result reaches the next model request,
  // and the model is offered only Marinara's tools (their descriptions, never pi's built-ins).
  {
    mode = "auto";
    const { chat, done } = await run("pi read", [
      reply("Let me read it.", [{ id: "call-read", name: "read", args: { path: "hello.txt" } }]),
      reply("The file says hi."),
    ]);
    await done;
    assert.equal(piEntered, 1);
    assert.equal(requests.length, 2);
    const offered = requests[0]!.options.tools ?? [];
    const allowed = new Map<string, string>(WORKSPACE_TOOL_DEFINITIONS.map((tool) => [tool.name as string, tool.description]));
    allowed.set("suggestions", offered.find((tool) => tool.function.name === "suggestions")?.function.description ?? "");
    allowed.set("plan", offered.find((tool) => tool.function.name === "plan")?.function.description ?? "");
    assert.deepEqual(offered.map((tool) => tool.function.name).sort(), [...allowed.keys()].sort());
    for (const tool of offered) assert.equal(tool.function.description, allowed.get(tool.function.name));
    assert.equal(requests[0]!.options.responseFormat, undefined);
    assert.notEqual(requests[0]!.options.reasoningEffort, "none", "pi must not force reasoning off");
    assert.ok(!requests[0]!.messages.some((m) => m.content.includes("workspace_command_protocol")), "no JSON protocol prompt");
    const toolMessage = requests[1]!.messages.find((message) => message.role === "tool");
    assert.equal(toolMessage?.tool_call_id, "call-read");
    assert.match(toolMessage?.content ?? "", /workspace_command_result name="read" success="true"/u);
    assert.match(toolMessage?.content ?? "", /hi from the workspace file/u);
    assert.equal((await lastAssistant(chat.id))?.content, "The file says hi.");
  }

  // (b) Manual: a described mutation is held, not executed, and the stored message carries the deferral flag.
  {
    mode = "manual";
    const { chat, events, done } = await run("pi manual", [
      reply("I will create made.txt. Shall I go ahead?", [
        { id: "call-write", name: "write", args: { path: "made.txt", content: "x", reason: "test" } },
      ]),
      reply("This second reply must never be requested."),
    ]);
    await done;
    assert.equal(existsSync(join(workspaceDir, "made.txt")), false, "a held change must not run");
    assert.equal(requests.length, 1, "the run ends as a deferral after the round");
    const saved = await lastAssistant(chat.id);
    assert.equal(saved?.extra.mariDeferredMutations, true);
    assert.ok(Array.isArray(saved?.extra.mariHeldChanges) || saved?.extra.mariHeldChanges === undefined);
    assert.match(saved?.content ?? "", /Shall I go ahead/u);
    assert.ok(events.some((event) => event.type === "suggestions"), "the Accept chip is sent");
  }

  // (c) Plan: a mutation is refused by the executor floor and the model sees the refusal.
  {
    mode = "plan";
    const { chat, done } = await run("pi plan", [
      reply("", [{ id: "call-plan-write", name: "write", args: { path: "planned.txt", content: "x", reason: "test" } }]),
      reply("I would create planned.txt."),
    ]);
    await done;
    assert.equal(existsSync(join(workspaceDir, "planned.txt")), false);
    const toolMessage = requests[1]!.messages.find((message) => message.role === "tool");
    assert.match(toolMessage?.content ?? "", /Plan mode is active/u);
    assert.equal((await lastAssistant(chat.id))?.extra.mariDeferredMutations, undefined);
  }

  // (d) Abort stops the run immediately: no tool runs, no further request.
  {
    mode = "auto";
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => (started = resolve));
    const { done } = await run("pi abort", [
      (options) => {
        started();
        return new Promise<ChatCompletionResult>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true });
        });
      },
      reply("This reply must never be requested."),
    ]);
    await requestStarted;
    await service.abort();
    await done;
    assert.equal(requests.length, 1);
    assert.equal(existsSync(join(workspaceDir, "made.txt")), false);
  }

  // (g) A completion claim with no mutation is sent back to the model as a repair message.
  {
    mode = "auto";
    const { chat, done } = await run("pi claim", [
      reply("I have updated the character card and saved it."),
      reply("I did not change anything yet. Tell me which card to edit."),
    ]);
    await done;
    assert.equal(requests.length, 2);
    const repair = requests[1]!.messages.filter((message) => message.role === "user").pop();
    assert.match(repair?.content ?? "", /no mutating command succeeded/u);
    assert.match((await lastAssistant(chat.id))?.content ?? "", /did not change anything/u);
  }

  // (e) With mariRuntime = classic the pi path is never entered and the JSON protocol is used.
  {
    mode = "auto";
    const { done } = await run(
      "classic",
      [reply(JSON.stringify({ say: "Plain classic answer.", commands: [], stop: true }))],
      "classic",
    );
    await done;
    assert.equal(piEntered, 0, "classic must not enter the pi runtime");
    assert.deepEqual(runtimeSeen, ["classic"]);
    assert.equal(requests[0]!.options.tools, undefined);
  }

  // The status reports the selected and the active runtime.
  {
    await settings.set(MARI_RUNTIME_SETTINGS_KEY, "pi");
    const status = await service.status(null, null);
    assert.equal(status.runtimeSelected, "pi");
    assert.equal(status.runtimeActive, "pi");
  }

  // (f) Source pin: the pi session is created with built-in tools off and an allowlist, and nothing from disk.
  {
    const source = readFileSync(
      new URL("../../../packages/server/src/services/professor-mari/pi-runtime.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /noTools: "builtin"/u);
    assert.match(source, /tools: tools\.map\(\(tool\) => tool\.name\)/u);
    assert.match(source, /modelsPath: null/u);
    assert.match(source, /SessionManager\.inMemory/u);
    assert.match(source, /SettingsManager\.inMemory/u);
    assert.match(source, /getAgentsFiles: \(\) => \(\{ agentsFiles: \[\] \}\)/u);
  }

  console.log("Professor Mari pi runtime regression passed.");
} finally {
  await closeDB();
  if (previousStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
}
