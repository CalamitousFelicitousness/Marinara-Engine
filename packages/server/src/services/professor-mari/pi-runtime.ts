// Professor Mari's optional second runtime, built on the pi SDK: native tool calls instead of the JSON frame.
// It calls Marinara's own provider layer for the model, runs every tool through WorkspaceCommands, and applies
// the same Permissions Mode, claim audit and repeated-failure rules as the classic loop. The sandbox is closed
// on purpose: no pi built-in tools, no resources read from disk, no pi auth/model files, in-memory session.
import { randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AgentSession, ResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  MARI_AUTHORIZATION_ACCEPT_CHIP,
  type ChatCompletionResult,
  type ChatMessage,
  type LLMToolDefinition,
  type MariHeldChange,
  type MariPermissionsMode,
  type MariSuggestionChip,
  type MariWorkspaceActionResult,
  type MariWorkspaceTraceItem,
} from "@marinara-engine/shared";
import {
  appendTraceStatus,
  appendVisibleText,
  chunkText,
  describeHeldCommands,
  emitRoundText,
  formatCommandResultForPrompt,
  isLengthFinishReason,
  isMutatingWorkspaceCommand,
  sanitizePlanSteps,
  sanitizeSuggestionChips,
  visibleTextAsksApplyPermission,
  WORKSPACE_TOOL_DEFINITIONS,
  type PromptEventSink,
  type WorkspaceCommandCall,
  type WorkspaceCommandResult,
  type WorkspaceConnection,
} from "./workspace-agent.service.js";
import type { WorkspaceCommands } from "./workspace-commands.js";
import { newRoundReviewState, reviewRepeatedFailures, reviewRoundClaim, shouldDeferRoundMutations } from "./workspace-round-review.js";

// ponytail: a generous safety net per run, not a budget. Upgrade path: derive it from the token budget.
export const MAX_PI_TOOL_ROUNDS = 400;

const PI_PROVIDER = "marinara";
const PI_API = "marinara-chat";
const UI_TOOLS = ["suggestions", "plan"] as const;

/** The run state prompt() persists on the saved message; the pi loop writes it, prompt() copies it back. */
export type PiRunState = {
  assistantText: string;
  endedWithDeferral: boolean;
  heldChanges: MariHeldChange[];
  suggestions: MariSuggestionChip[];
};

export type PiRunInput = {
  signal: AbortSignal;
  state: PiRunState;
  /** What buildPromptMessages built: system prompts, then the stored chat ending in the current user message. */
  messages: ChatMessage[];
  connection: WorkspaceConnection;
  permissionsMode: MariPermissionsMode;
  manualApprovalArmed: boolean;
  trace: MariWorkspaceTraceItem[];
  actionResults: MariWorkspaceActionResult[];
  /** Every command result of the run; the claim audit reads it. */
  commandResults: WorkspaceCommandResult[];
  onEvent: PromptEventSink;
  /** One provider call through Marinara's provider layer. */
  complete: (messages: ChatMessage[], tools: LLMToolDefinition[]) => Promise<ChatCompletionResult>;
  setRoundFlags: (flags: { manualSilentMutationBlocked: boolean; askLatchSilentMutationBlocked: boolean }) => void;
};

type Round = {
  text: string;
  /** Tool calls in order, UI tools included. */
  calls: WorkspaceCommandCall[];
  finished: number;
  results: WorkspaceCommandResult[];
  deferred: boolean | null;
  truncated: boolean;
};

const UI_TOOL_SCHEMAS: Record<(typeof UI_TOOLS)[number], { description: string; parameters: Record<string, unknown> }> = {
  suggestions: {
    description:
      "Show quick-reply chips under your answer (at most 5). Changes nothing. Each chip: label (short button text), prompt (the exact message sent when tapped), optional detail, entity, tone (danger|caution|success) and action.",
    parameters: {
      type: "object",
      properties: { chips: { type: "array", items: { type: "object" }, maxItems: 6 } },
      required: ["chips"],
    },
  },
  plan: {
    description:
      "Show a guided plan for a vague create or edit request, one step per field. Changes nothing. Each step: fieldKey, question and chips (label, prompt).",
    parameters: {
      type: "object",
      properties: { steps: { type: "array", items: { type: "object" }, maxItems: 8 } },
      required: ["steps"],
    },
  },
};

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

export async function runPiLoop(input: PiRunInput & { commands: WorkspaceCommands }): Promise<void> {
  const { signal, state, commands, trace, onEvent } = input;
  const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { InMemoryCredentialStore, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } =
    await import("@earendil-works/pi-ai");

  const reviewState = newRoundReviewState();
  const systemPrompt = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const history = input.messages.filter((message) => message.role !== "system");
  const last = history[history.length - 1];
  if (!last || last.role !== "user") throw new Error("The pi runtime needs the current user message last.");
  // Images and files ride on the stored chat messages; pi only sees text, so they are re-attached by text.
  const attachmentsByText = new Map<string, Pick<ChatMessage, "images" | "files">>();
  for (const message of history) {
    if (message.role === "user" && (message.images?.length || message.files?.length)) {
      attachmentsByText.set(message.content, { images: message.images, files: message.files });
    }
  }

  let stopRequested = false;
  let providerError: unknown = null;
  let runAskedForApproval = false;
  let toolRounds = 0;
  let round: Round | null = null;
  let session: AgentSession | null = null;
  const currentRound = (): Round | null => round;

  const addNote = (content: string, kind: "retry" | "info" | "output_limit", level: "info" | "warning") => {
    state.assistantText = appendVisibleText(state.assistantText, content);
    appendTraceStatus(trace, content);
    onEvent({ type: "status", data: { content, kind, level } });
    for (const chunk of chunkText(content)) onEvent({ type: "token", data: chunk });
  };

  const toChatMessages = (context: TranscriptContext): ChatMessage[] => {
    const out: ChatMessage[] = [];
    const prompt = getCurrentSystemPrompt(context.messages);
    if (prompt) out.push({ role: "system", content: prompt, contextKind: "prompt" });
    for (const message of context.messages as Message[]) {
      if (message.role === "user") {
        const content = textOf(message.content as never);
        out.push({ role: "user", content, contextKind: "history", ...attachmentsByText.get(content) });
      } else if (message.role === "assistant") {
        const toolCalls = message.content.flatMap((part) =>
          part.type === "toolCall"
            ? [{ id: part.id, type: "function" as const, function: { name: part.name, arguments: JSON.stringify(part.arguments) } }]
            : [],
        );
        out.push({
          role: "assistant",
          content: textOf(message.content as never),
          contextKind: "history",
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      } else if (message.role === "toolResult") {
        out.push({ role: "tool", tool_call_id: message.toolCallId, content: textOf(message.content), contextKind: "history" });
      }
    }
    return out;
  };

  const streamSimple = (
    model: { api: string; provider: string; id: string },
    context: TranscriptContext,
    _options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    void (async () => {
      try {
        stream.push({ type: "start", partial: message });
        const tools = getCurrentTools(context.messages);
        // Summaries from pi's own compaction come through here without tools; only the agent's turns are rounds.
        const isAgentTurn = tools.length > 0;
        if (stopRequested && isAgentTurn) {
          stream.push({ type: "done", reason: "stop", message });
          return;
        }
        signal.throwIfAborted();
        const toolDefs: LLMToolDefinition[] = tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)) },
        }));
        const result = await input.complete(toChatMessages(context), toolDefs);
        const truncated = isLengthFinishReason(result.finishReason);
        const text = result.content?.trim() ? result.content : "";
        // A truncated frame never runs: its tool calls may be cut off mid-argument.
        const calls = truncated ? [] : result.toolCalls;
        if (result.usage) {
          message.usage = {
            ...message.usage,
            input: result.usage.promptTokens,
            output: result.usage.completionTokens,
            cacheRead: result.usage.cachedPromptTokens ?? 0,
            totalTokens: result.usage.totalTokens,
          };
        }
        if (text) {
          message.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        }
        const workspaceCalls: WorkspaceCommandCall[] = [];
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(call.function.arguments || "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          } catch {
            // Unparsable arguments reach the tool as {}: schema validation answers the model with an error.
          }
          const id = call.id || randomUUID();
          const toolCall = { type: "toolCall" as const, id, name: call.function.name, arguments: args as never };
          const index = message.content.length;
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
          workspaceCalls.push({ id, name: call.function.name as WorkspaceCommandCall["name"], arguments: args });
        }
        if (isAgentTurn) {
          round = { text, calls: workspaceCalls, finished: 0, results: [], deferred: null, truncated };
          if (workspaceCalls.length > 0) toolRounds += 1;
        }
        message.stopReason = truncated ? "length" : workspaceCalls.length > 0 ? "toolUse" : "stop";
        stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
      } catch (error) {
        const aborted = signal.aborted;
        if (!aborted) providerError = error;
        message.stopReason = aborted ? "aborted" : "error";
        message.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
      }
    })();
    return stream;
  };

  /** Review a finished round: claim audit, then its words, then the repeated-failure stop and the round cap. */
  const finishRound = async (current: Round, hasWorkspaceCalls: boolean) => {
    const workspaceCalls = current.calls.filter((call) => !isUiTool(call.name));
    const action = { visibleText: current.text, commands: workspaceCalls, stop: !hasWorkspaceCalls, protocolValid: true };
    if (current.deferred) {
      // Same outcome as classic: the words show, the held changes wait behind Accept, the run ends.
      const content =
        "Deferred hidden mutating workspace commands because the assistant asked the user for approval in the same turn.";
      appendTraceStatus(trace, content);
      onEvent({ type: "status", data: { content, kind: "info", level: "warning" } });
      state.assistantText = current.text.trim();
      emitRoundText(trace, current.text, onEvent);
      state.suggestions = [
        MARI_AUTHORIZATION_ACCEPT_CHIP,
        ...state.suggestions.filter((chip) => chip.id !== MARI_AUTHORIZATION_ACCEPT_CHIP.id),
      ];
      onEvent({ type: "suggestions", data: state.suggestions });
      stopRequested = true;
      return "done" as const;
    }
    const decision = reviewRoundClaim(reviewState, {
      action,
      commandResultsForContinuity: input.commandResults,
      truncated: current.truncated,
    });
    if (decision.kind === "repair") return decision;
    if (decision.kind === "stop") {
      addNote(decision.content, "retry", "warning");
      stopRequested = true;
      return "done" as const;
    }
    if (current.text.trim()) {
      if (visibleTextAsksApplyPermission(current.text)) runAskedForApproval = true;
      state.assistantText = current.text.trim();
      emitRoundText(trace, current.text, onEvent);
      if (current.results.length > 0 && hasWorkspaceCalls) onEvent({ type: "metadata", data: { narration: true } });
    }
    if (current.truncated) {
      addNote("Professor Mari hit the model output limit. Ask her to continue and she can pick up from here.", "output_limit", "warning");
      stopRequested = true;
      return "done" as const;
    }
    if (!hasWorkspaceCalls) return "done" as const;
    const repeatedFailure = reviewRepeatedFailures(reviewState, current.results);
    if (repeatedFailure !== null) {
      addNote(repeatedFailure, "retry", "warning");
      stopRequested = true;
    } else if (toolRounds >= MAX_PI_TOOL_ROUNDS) {
      addNote("Tool round limit reached for this run. Ask Professor Mari to continue and she can pick up from here.", "info", "warning");
      stopRequested = true;
    }
    return "done" as const;
  };

  const runTool = async (name: string, toolCallId: string, params: Record<string, unknown>) => {
    const current = round;
    if (!current) throw new Error("A tool ran outside a model round.");
    const call = current.calls.find((entry) => entry.id === toolCallId) ?? { id: toolCallId, name: name as never, arguments: params };
    const hasWorkspaceCalls = current.calls.some((entry) => !isUiTool(entry.name));
    if (current.deferred === null) {
      const mutating = current.calls.filter((entry) => !isUiTool(entry.name) && isMutatingWorkspaceCommand(entry));
      current.deferred = shouldDeferRoundMutations({
        permissionsMode: input.permissionsMode,
        parsedAction: { visibleText: current.text, awaitingAuthorization: false, commands: mutating },
        runAskedForApproval,
      });
      if (current.deferred) {
        state.endedWithDeferral = true;
        state.heldChanges = describeHeldCommands(mutating);
      } else {
        const silent = !current.text;
        input.setRoundFlags({
          manualSilentMutationBlocked: input.permissionsMode === "manual" && silent && !input.manualApprovalArmed,
          askLatchSilentMutationBlocked:
            runAskedForApproval && silent && input.permissionsMode !== "manual" && input.permissionsMode !== "bypass",
        });
      }
    }
    let text: string;
    let isError = false;
    if (name === "suggestions") {
      const chips = sanitizeSuggestionChips(params.chips);
      if (chips.length > 0) {
        state.suggestions = chips;
        onEvent({ type: "suggestions", data: chips });
      }
      text = chips.length > 0 ? "Chips shown." : "No valid chips; nothing was shown.";
    } else if (name === "plan") {
      const steps = sanitizePlanSteps(params.steps);
      if (steps.length > 0) onEvent({ type: "plan", data: steps });
      text = steps.length > 0 ? "Plan shown." : "No valid plan steps; nothing was shown.";
    } else if (current.deferred) {
      text = "Held: this change waits for the user's Accept and was not applied. Do not repeat it.";
    } else {
      const result = await commands.executeWorkspaceCommand(call, signal, trace, onEvent, input.actionResults);
      input.commandResults.push(result);
      current.results.push(result);
      text = formatCommandResultForPrompt([result]);
      isError = !result.success;
    }
    current.finished += 1;
    if (current.finished === current.calls.length) {
      const decision = await finishRound(current, hasWorkspaceCalls);
      if (decision !== "done") {
        // The repair reaches the model right after this round's tool results, before its next turn.
        await session!.steer(decision.prompt);
      }
    }
    return { content: [{ type: "text" as const, text }], details: {}, isError };
  };

  const tools: ToolDefinition[] = [
    ...WORKSPACE_TOOL_DEFINITIONS.map((definition) => ({ name: definition.name as string, description: definition.description, parameters: definition.parameters })),
    ...UI_TOOLS.map((name) => ({ name: name as string, ...UI_TOOL_SCHEMAS[name] })),
  ].map(
    (tool) =>
      ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        // Plain JSON Schema, validated by pi before execute.
        parameters: tool.parameters as never,
        executionMode: "sequential",
        execute: (toolCallId: string, params: unknown) => runTool(tool.name, toolCallId, params as Record<string, unknown>),
      }) satisfies ToolDefinition,
  );

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const modelId = input.connection.model || "model";
  modelRuntime.registerProvider(PI_PROVIDER, {
    api: PI_API as never,
    baseUrl: "http://marinara.invalid",
    apiKey: "unused",
    streamSimple: streamSimple as never,
    models: [
      {
        id: modelId,
        name: modelId,
        // Thinking stays with the provider layer and the connection's own settings; pi never asks for it.
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: input.connection.maxContext || 128_000,
        maxTokens: 16_384,
      },
    ],
  });
  const model = modelRuntime.getModel(PI_PROVIDER, modelId);
  if (!model) throw new Error("The pi runtime could not register the Marinara model.");

  // Nothing is discovered or loaded from disk: no extensions, skills, prompt templates, themes or context files.
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const cwd = commands.workspaceRoot;
  // ponytail: the session starts from the stored chat every turn, so a compaction summary does not persist
  // across turns. Upgrade path: store the summary with the chat and seed it here.
  const sessionManager = SessionManager.inMemory(cwd);
  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  history.slice(0, -1).forEach((message, index) => {
    const timestamp = index + 1;
    if (message.role === "user") sessionManager.appendMessage({ role: "user", content: message.content, timestamp });
    else if (message.role === "assistant") {
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api: PI_API,
        provider: PI_PROVIDER,
        model: modelId,
        usage: zeroUsage,
        stopReason: "stop",
        timestamp,
      } as never);
    }
  });

  ({ session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    sessionManager,
    // Marinara's own rate-limit layer retries; pi compacts long runs.
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } }),
    // Security boundary: no pi built-in tools, only the allowlisted Marinara tools below.
    noTools: "builtin",
    tools: tools.map((tool) => tool.name),
    customTools: tools,
  }));
  const onAbort = () => void session?.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    let next = last.content;
    for (;;) {
      round = null;
      await session.prompt(next, { expandPromptTemplates: false });
      if (providerError) throw providerError;
      if (signal.aborted) throw new Error("aborted");
      const finished = currentRound();
      // A terminal turn (no tool call) is reviewed here; tool turns were reviewed inside their last tool.
      if (stopRequested || !finished || finished.calls.length > 0) break;
      const decision = await finishRound(finished, false);
      if (decision === "done") break;
      next = decision.prompt;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    session.dispose();
  }
}

function isUiTool(name: string): boolean {
  return (UI_TOOLS as readonly string[]).includes(name);
}
