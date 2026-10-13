// Pins Professor Mari's optional pi runtime with a scripted fake provider: no network, no real model.
// Covers the tool-call round trip through WorkspaceCommands, the Permissions Mode floors, abort, the classic
// default and fallback, the closed tool set, replay metadata, the per-turn review and the real prompt builder.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChatCompletionResult,
  ChatMessage,
  ChatOptions,
} from "../../../packages/server/src/services/llm/base-provider.js";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-mari-pi-storage-"));
const workspaceDir = mkdtempSync(join(tmpdir(), "marinara-mari-pi-workspace-"));
const previousStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;
const { getDB, closeDB } = await import("../../../packages/server/src/db/connection.js");

type Scripted = ChatCompletionResult | ((options: ChatOptions) => Promise<ChatCompletionResult>);
type Call = { id: string; name: string; args: Record<string, unknown> };
const reply = (content: string, toolCalls: Call[] = [], providerMetadata?: Record<string, unknown>) =>
  ({
    content,
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    ...(providerMetadata ? { providerMetadata } : {}),
  }) satisfies ChatCompletionResult;
const toolMessages = (messages: ChatMessage[]) => messages.filter((message) => message.role === "tool");

try {
  const db = await getDB();
  const { ProfessorMariWorkspaceService, WORKSPACE_TOOL_DEFINITIONS, MAX_REPEATED_COMMAND_FAILURES } =
    await import("../../../packages/server/src/services/professor-mari/workspace-agent.service.js");
  const { assertClosedToolSet } = await import("../../../packages/server/src/services/professor-mari/pi-runtime.js");
  const { createChatsStorage } = await import("../../../packages/server/src/services/storage/chats.storage.js");
  const { createAppSettingsStorage } =
    await import("../../../packages/server/src/services/storage/app-settings.storage.js");
  const { MARI_RUNTIME_SETTINGS_KEY } = await import("../../../packages/shared/src/constants/mari-runtime.js");
  const chats = createChatsStorage(db);
  const settings = createAppSettingsStorage(db);

  writeFileSync(join(workspaceDir, "hello.txt"), "hi from the workspace file\n");

  let mode: "auto" | "manual" | "plan" | "bypass" = "auto";
  let provider = "custom";
  let script: Scripted[] = [];
  let requests: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  let runtimeSeen: unknown[] = [];
  let piEntered = 0;
  let maxToolRounds: number | undefined;
  let sessionSeen: { active: string[]; closed: boolean } | null = null;

  const makeService = (stubPromptBuilder: boolean) => {
    const made = new ProfessorMariWorkspaceService({ db } as never);
    made.setEnabled(true, workspaceDir);
    const originalRunPi = (made as unknown as { runPiRuntime: (args: unknown) => Promise<void> }).runPiRuntime.bind(
      made,
    );
    const originalBuild = (
      made as unknown as { buildPromptMessages: (...args: unknown[]) => unknown }
    ).buildPromptMessages.bind(made);
    Object.assign(made, {
      ensureMariCliShim: async () => {},
      resolveConnection: async () => ({
        id: "mari-pi-runtime",
        name: "Regression",
        provider,
        model: "fake-model",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "",
        maxContext: 32768,
      }),
      resolvePermissionsMode: async () => ({ mode, defaultMode: mode, source: "chat" }),
      buildPromptMessages: async (...args: unknown[]) => {
        runtimeSeen.push(args[4]);
        if (!stubPromptBuilder) return originalBuild(...args);
        return {
          messages: [
            { role: "system", content: "You are Professor Mari (regression).", contextKind: "prompt" },
            { role: "user", content: "Do the thing.", contextKind: "history" },
          ],
          manualApprovalArmed: false,
        };
      },
      runPiRuntime: async (args: Record<string, unknown>) => {
        piEntered += 1;
        return originalRunPi({
          ...args,
          maxToolRounds,
          onSession: (session: { getActiveToolNames(): string[] }, tools: Array<{ name: string }>) => {
            let closed = true;
            try {
              assertClosedToolSet(session as never, tools as never);
            } catch {
              closed = false;
            }
            sessionSeen = { active: session.getActiveToolNames(), closed };
          },
        });
      },
      chatCompleteWorkspace: async (_provider: unknown, messages: ChatMessage[], options: ChatOptions) => {
        requests.push({ messages: structuredClone(messages), options });
        const next = script.shift();
        if (!next) throw new Error("The scripted provider ran out of replies.");
        return typeof next === "function" ? next(options) : next;
      },
    });
    return made;
  };
  const service = makeService(true);

  const start = async (
    name: string,
    nextScript: Scripted[],
    runtime: "pi" | "classic" = "pi",
    target: InstanceType<typeof ProfessorMariWorkspaceService> = service,
    chatId?: string,
  ) => {
    script = [...nextScript];
    requests = [];
    runtimeSeen = [];
    piEntered = 0;
    sessionSeen = null;
    await settings.set(MARI_RUNTIME_SETTINGS_KEY, runtime);
    const chat = chatId ? { id: chatId } : await chats.create({ name, mode: "conversation", characterIds: [] });
    const events: Array<{ type: string; data?: unknown }> = [];
    const done = target.prompt({ chatId: chat.id, text: "Do the thing.", onEvent: (event) => events.push(event) });
    return { chat, events, done };
  };
  const lastAssistant = async (chatId: string) => {
    const rows = (await chats.listMessages(chatId)).filter((message) => message.role === "assistant");
    const row = rows[rows.length - 1];
    return row
      ? { content: String(row.content), extra: JSON.parse(String(row.extra ?? "{}")) as Record<string, unknown> }
      : null;
  };
  const statusTexts = (events: Array<{ type: string; data?: unknown }>) =>
    events
      .filter((event) => event.type === "status")
      .map((event) =>
        typeof event.data === "string" ? event.data : String((event.data as { content?: string }).content),
      );

  // (a) + (f): a read tool call runs through WorkspaceCommands and its result reaches the next model request,
  // and the model is offered only Marinara's tools (their descriptions, never pi's built-ins).
  {
    mode = "auto";
    const { chat, done } = await start("pi read", [
      reply("Let me read it.", [{ id: "call-read", name: "read", args: { path: "hello.txt" } }]),
      reply("The file says hi."),
    ]);
    await done;
    assert.equal(piEntered, 1);
    assert.equal(requests.length, 2);
    const offered = requests[0]!.options.tools ?? [];
    const allowed = new Map<string, string>(
      WORKSPACE_TOOL_DEFINITIONS.map((tool) => [tool.name as string, tool.description]),
    );
    allowed.set(
      "suggestions",
      offered.find((tool) => tool.function.name === "suggestions")?.function.description ?? "",
    );
    allowed.set("plan", offered.find((tool) => tool.function.name === "plan")?.function.description ?? "");
    assert.deepEqual(offered.map((tool) => tool.function.name).sort(), [...allowed.keys()].sort());
    for (const tool of offered) assert.equal(tool.function.description, allowed.get(tool.function.name));
    assert.equal(requests[0]!.options.responseFormat, undefined);
    assert.notEqual(requests[0]!.options.reasoningEffort, "none", "pi must not force reasoning off");
    assert.ok(!requests[0]!.messages.some((m) => m.content.includes("workspace_command_protocol")));
    const toolMessage = toolMessages(requests[1]!.messages)[0];
    assert.equal(toolMessage?.tool_call_id, "call-read");
    assert.match(toolMessage?.content ?? "", /workspace_command_result name="read" success="true"/u);
    assert.match(toolMessage?.content ?? "", /hi from the workspace file/u);
    assert.equal((await lastAssistant(chat.id))?.content, "The file says hi.");
    // The real boundary: every ACTIVE tool of the session is one of Marinara's own definitions (pi keeps its
    // built-ins registered under the allowlist, but each Marinara tool replaces its namesake).
    assert.ok(sessionSeen, "the session inspection hook must run");
    const seen = sessionSeen as { active: string[]; closed: boolean };
    assert.deepEqual([...seen.active].sort(), [...allowed.keys()].sort());
    assert.equal(seen.closed, true);
  }

  // The boundary check fails closed when an active tool is not Marinara's.
  {
    const mine = { name: "read", execute: async () => ({}) };
    const piBuiltIn = { name: "read", execute: async () => ({}) };
    assert.throws(
      () =>
        assertClosedToolSet(
          { getActiveToolNames: () => ["read"], getToolDefinition: () => piBuiltIn } as never,
          [mine] as never,
        ),
      /not one of Professor Mari's own tools/u,
    );
    assert.throws(
      () =>
        assertClosedToolSet(
          { getActiveToolNames: () => ["grep"], getToolDefinition: () => undefined } as never,
          [mine] as never,
        ),
      /not one of Professor Mari's own tools/u,
    );
  }

  // Provider replay metadata (Anthropic thinking, Gemini parts, ...) rides back on the assistant message.
  {
    mode = "auto";
    const metadata = { anthropicThinking: [{ type: "thinking", thinking: "plan", signature: "sig" }] };
    const { done } = await start("pi metadata", [
      reply("", [{ id: "call-meta", name: "read", args: { path: "hello.txt" } }], metadata),
      reply("Done."),
    ]);
    await done;
    const replayed = requests[1]!.messages.find(
      (message) => message.role === "assistant" && message.tool_calls?.length,
    );
    assert.deepEqual(replayed?.providerMetadata, metadata);
  }

  // (b) Manual: a described mutation is held, not executed; the stored message carries the flag and the held change.
  {
    mode = "manual";
    const { chat, events, done } = await start("pi manual", [
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
    const held = saved?.extra.mariHeldChanges as Array<Record<string, unknown>> | undefined;
    assert.equal(held?.length, 1, "the held change is stored for the Accept card");
    assert.match(JSON.stringify(held), /made\.txt/u);
    assert.match(saved?.content ?? "", /Shall I go ahead/u);
    assert.ok(
      events.some((event) => event.type === "suggestions"),
      "the Accept chip is sent",
    );
  }

  // (c) Plan: a mutation is refused by the executor floor and the model sees the refusal.
  {
    mode = "plan";
    const { chat, done } = await start("pi plan", [
      reply("", [{ id: "call-plan-write", name: "write", args: { path: "planned.txt", content: "x", reason: "t" } }]),
      reply("I would create planned.txt."),
    ]);
    await done;
    assert.equal(existsSync(join(workspaceDir, "planned.txt")), false);
    assert.match(toolMessages(requests[1]!.messages)[0]?.content ?? "", /Plan mode is active/u);
    assert.equal((await lastAssistant(chat.id))?.extra.mariDeferredMutations, undefined);
  }

  // Bypass: the same described mutation runs without a hold.
  {
    mode = "bypass";
    const { chat, done } = await start("pi bypass", [
      reply("I will create bypass.txt. Shall I?", [
        { id: "call-bypass", name: "write", args: { path: "bypass.txt", content: "x", reason: "test" } },
      ]),
      reply("Created bypass.txt."),
    ]);
    await done;
    assert.equal(existsSync(join(workspaceDir, "bypass.txt")), true, "Bypass never holds");
    assert.equal((await lastAssistant(chat.id))?.extra.mariDeferredMutations, undefined);
  }

  // (d) Abort stops the run immediately: no tool starts, no further request.
  {
    mode = "auto";
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => (started = resolve));
    const { events, done } = await start("pi abort", [
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
    assert.ok(!events.some((event) => event.type === "tool_start"));
    assert.equal((await service.status(null, null)).active, false);
  }

  // (g) A completion claim with no mutation is sent back to the model as a repair message.
  {
    mode = "auto";
    const { chat, done } = await start("pi claim", [
      reply("I have updated the character card and saved it."),
      reply("I did not change anything yet. Tell me which card to edit."),
    ]);
    await done;
    assert.equal(requests.length, 2);
    const repair = requests[1]!.messages.filter((message) => message.role === "user").pop();
    assert.match(repair?.content ?? "", /no mutating command succeeded/u);
    assert.match((await lastAssistant(chat.id))?.content ?? "", /did not change anything/u);
  }

  // A model that repeats one invalid tool call is stopped by the repeated-failure rule (pi answers such calls itself).
  {
    mode = "auto";
    const bad = (n: number) => reply("", [{ id: `bad-${n}`, name: "no_such_tool", args: {} }]);
    const { events, done } = await start("pi repeated invalid", [bad(1), bad(2), bad(3), bad(4), bad(5), bad(6)]);
    await done;
    assert.equal(requests.length, MAX_REPEATED_COMMAND_FAILURES, "the third identical failure stops the run");
    assert.ok(statusTexts(events).some((text) => /same no_such_tool error/u.test(text)));
  }

  // Ask-latch: a question in a turn whose only call pi rejects still binds the run, so a silent write next round is refused.
  {
    mode = "auto";
    const { done } = await start("pi ask latch", [
      reply("Shall I save it now?", [{ id: "call-bad", name: "no_such_tool", args: {} }]),
      reply("", [{ id: "call-silent", name: "write", args: { path: "latched.txt", content: "x", reason: "t" } }]),
      reply("I will wait for your answer."),
    ]);
    await done;
    assert.equal(existsSync(join(workspaceDir, "latched.txt")), false, "a silent write after asking must not run");
    assert.match(toolMessages(requests[2]!.messages).pop()?.content ?? "", /already asked the user for approval/u);
  }

  // The same question next to a rejected call AND a write holds the write and ends the run.
  {
    mode = "auto";
    const { chat, done } = await start("pi ask hold", [
      reply("Shall I save it now?", [
        { id: "call-bad2", name: "no_such_tool", args: {} },
        { id: "call-write2", name: "write", args: { path: "held.txt", content: "x", reason: "t" } },
      ]),
      reply("This reply must never be requested."),
    ]);
    await done;
    assert.equal(existsSync(join(workspaceDir, "held.txt")), false);
    assert.equal(requests.length, 1);
    assert.equal((await lastAssistant(chat.id))?.extra.mariDeferredMutations, true);
  }

  // The tool round cap also counts rounds that only show chips next to a rejected call.
  {
    mode = "auto";
    maxToolRounds = 2;
    const chips = [{ label: "Yes", prompt: "Yes, go on." }];
    const { events, done } = await start("pi cap", [
      reply("", [
        { id: "cap-1a", name: "suggestions", args: { chips } },
        { id: "cap-1b", name: "bad_one", args: {} },
      ]),
      reply("", [
        { id: "cap-2a", name: "suggestions", args: { chips } },
        { id: "cap-2b", name: "bad_two", args: {} },
      ]),
      reply("This reply must never be requested."),
    ]);
    await done;
    maxToolRounds = undefined;
    assert.equal(requests.length, 2);
    assert.ok(statusTexts(events).some((text) => /Tool round limit reached/u.test(text)));
  }

  // A final answer with chips is one model request, and the stored answer is the first text.
  {
    mode = "auto";
    const { chat, events, done } = await start("pi chips", [
      reply("Here is your answer.", [
        { id: "chips-1", name: "suggestions", args: { chips: [{ label: "More", prompt: "Tell me more." }] } },
      ]),
      reply("A second answer that must never be requested."),
    ]);
    await done;
    assert.equal(requests.length, 1);
    assert.equal((await lastAssistant(chat.id))?.content, "Here is your answer.");
    assert.ok(events.some((event) => event.type === "suggestions"));
  }

  // Chips with no words are not the answer yet: the run goes on, keeps the chips and stores the next text.
  {
    mode = "auto";
    const { chat, events, done } = await start("pi chips first", [
      reply("", [
        { id: "chips-2", name: "suggestions", args: { chips: [{ label: "More", prompt: "Tell me more." }] } },
      ]),
      reply("Now the answer."),
    ]);
    await done;
    assert.equal(requests.length, 2);
    assert.equal((await lastAssistant(chat.id))?.content, "Now the answer.");
    assert.ok(events.some((event) => event.type === "suggestions"));
  }

  // (e) With mariRuntime = classic the pi path is never entered and the JSON protocol is used.
  {
    mode = "auto";
    const { done } = await start(
      "classic",
      [reply(JSON.stringify({ say: "Plain classic answer.", commands: [], stop: true }))],
      "classic",
    );
    await done;
    assert.equal(piEntered, 0, "classic must not enter the pi runtime");
    assert.deepEqual(runtimeSeen, ["classic"]);
    assert.equal(requests[0]!.options.tools, undefined);
  }

  // Fallback: pi selected on a connection without native tool calls runs classic with one plain status event.
  {
    mode = "auto";
    provider = "claude_subscription";
    const { events, done } = await start("fallback", [
      reply(JSON.stringify({ say: "Classic fallback answer.", commands: [], stop: true })),
    ]);
    await done;
    provider = "custom";
    assert.equal(piEntered, 0, "pi must not be constructed without native tool calls");
    assert.deepEqual(runtimeSeen, ["classic"]);
    assert.equal(requests[0]!.options.tools, undefined);
    assert.equal(statusTexts(events).filter((text) => /classic runtime/u.test(text)).length, 1);
  }

  // The status reports the selected and the active runtime.
  {
    await settings.set(MARI_RUNTIME_SETTINGS_KEY, "pi");
    const status = await service.status(null, null);
    assert.equal(status.runtimeSelected, "pi");
    assert.equal(status.runtimeActive, "pi");
  }

  // The real prompt builder: pi prompt instead of the JSON protocol, and the stored chat as plain text.
  {
    mode = "auto";
    const realService = makeService(false);
    const chat = await chats.create({ name: "pi real prompt", mode: "conversation", characterIds: [] });
    await chats.createMessage({ chatId: chat.id, role: "user", characterId: null, content: "Earlier question" });
    await chats.createMessage({ chatId: chat.id, role: "assistant", characterId: null, content: "Earlier answer" });
    const { done } = await start("unused", [reply("Real prompt answer.")], "pi", realService, chat.id);
    await done;
    const system = requests[0]!.messages.find((message) => message.role === "system")?.content ?? "";
    assert.match(system, /<workspace_tools>/u);
    assert.match(system, /There is no JSON frame/u);
    assert.doesNotMatch(system, /workspace_command_protocol/u);
    const history = requests[0]!.messages.filter((message) => message.role !== "system");
    assert.deepEqual(
      history.map((message) => [message.role, message.content]),
      [
        ["user", "Earlier question"],
        ["assistant", "Earlier answer"],
        ["user", "Do the thing."],
      ],
    );
    assert.deepEqual(runtimeSeen, ["pi"]);
  }

  console.log("Professor Mari pi runtime regression passed.");
} finally {
  await closeDB();
  if (previousStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
}
