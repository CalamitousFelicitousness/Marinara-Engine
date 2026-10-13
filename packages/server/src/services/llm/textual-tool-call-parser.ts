import type { LLMToolCall, LLMToolDefinition } from "./base-provider.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toolCallId(index: number): string {
  return `text_tool_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  return parseJsonishObject(value) ?? {};
}

function parseJsonishObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidates = [
    trimmed,
    trimmed
      .replace(/([{,]\s*)([A-Za-z_][\w.-]*)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, (_, inner: string) => `: ${JSON.stringify(inner)}`),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return isRecord(parsed) ? parsed : null;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Gemma 4 uses <|"|>string value<|"|> as a string delimiter instead of "string value".
 * Normalize these to standard double-quoted strings so JSON parsing can succeed.
 * Also used by the agent executor's JSON extraction (#5537), so the same model
 * quirk cannot fail structured agent responses that the tool-call path tolerates.
 */
export function normalizeGemma4Delimiters(content: string): string {
  return content.replace(/<\|"\|>(.*?)<\|"\|>/gs, (_, inner: string) => JSON.stringify(inner));
}

function parseJsonishObjectWithGemmaDelimiters(value: string): Record<string, unknown> | null {
  return (
    parseJsonishObject(value) ?? (value.includes('<|"|>') ? parseJsonishObject(normalizeGemma4Delimiters(value)) : null)
  );
}

function rawToolCalls(payload: Record<string, unknown>): unknown[] {
  const plural = payload.tool_calls ?? payload.toolCalls ?? payload.calls;
  if (Array.isArray(plural)) return plural;
  const single = payload.tool_call ?? payload.toolCall;
  if (single) return [single];
  if (typeof payload.name === "string" || typeof payload.tool === "string" || typeof payload.command === "string") {
    return [payload];
  }
  // Handle {"type": "function", "function": {"name": "...", ...}} OpenAI-style wrapper
  if (isRecord(payload.function) && typeof (payload.function as Record<string, unknown>).name === "string") {
    return [payload];
  }
  return [];
}

type ParsedTaggedSnippet = {
  text: string;
  recoveryText?: string;
  allowCommandFallback: boolean;
  allowAnonymousJsonPayload: boolean;
};

function extractBalancedJson(text: string): string | null {
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  const start = brace === -1 ? bracket : bracket === -1 ? brace : Math.min(brace, bracket);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

const TAGGED_PATTERNS: Array<{ re: RegExp; allowCommandFallback: boolean; allowAnonymousJsonPayload: boolean }> = [
  {
    re: /(<\|tool_call\|?>)([\s\S]*?)(?:<tool_call\|>|<\|\/tool_call\|>|<\/tool_call>|$)/gi,
    allowCommandFallback: true,
    allowAnonymousJsonPayload: true,
  },
  {
    re: /(<tool_call>)([\s\S]*?)(?:<\/tool_call>|<\/arg_value>|$)/gi,
    allowCommandFallback: true,
    allowAnonymousJsonPayload: true,
  },
  { re: /(<tool_code>)([\s\S]*?)<\/tool_code>/gi, allowCommandFallback: true, allowAnonymousJsonPayload: true },
  { re: /(```(?:json)?\s*)([\s\S]*?)\s*```/gi, allowCommandFallback: false, allowAnonymousJsonPayload: false },
  // Meta Llama 3.1+ uses <|python_tag|> to delimit tool calls in content
  {
    re: /(<\|python_tag\|>)([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|<\|end_header_id\|>|$)/gi,
    allowCommandFallback: false,
    allowAnonymousJsonPayload: false,
  },
];

/**
 * DeepSeek V4 sometimes writes its native call markup as text instead of a native tool call:
 * <｜DSML｜tool_calls><｜DSML｜invoke name="app data"><｜DSML｜parameter name="action" string="true">lorebook get entry</｜DSML｜parameter>…
 * The bars are U+FF5C (an ASCII "|" variant is accepted). string="false" values are JSON. The markup also spaces out
 * identifiers ("app data", "lorebook get entry"); tool names are matched loosely below and a spaced action is rejoined.
 */
const DSML_BLOCK_RE = /<[｜|]DSML[｜|]tool_calls>[\s\S]*?(?:<\/[｜|]DSML[｜|]tool_calls>|$)/gi;
const DSML_INVOKE_RE = /<[｜|]DSML[｜|]invoke\s+name="([^"]*)"\s*>([\s\S]*?)(?:<\/[｜|]DSML[｜|]invoke>|$)/gi;
const DSML_PARAM_RE =
  /<[｜|]DSML[｜|]parameter\s+name="([^"]*)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/[｜|]DSML[｜|]parameter>/gi;

function parseDsmlCalls(content: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const block of content.matchAll(DSML_BLOCK_RE)) {
    for (const invoke of block[0].matchAll(DSML_INVOKE_RE)) {
      const args: Record<string, unknown> = {};
      for (const param of (invoke[2] ?? "").matchAll(DSML_PARAM_RE)) {
        const key = (param[1] ?? "").trim();
        const raw = (param[3] ?? "").trim();
        if (!key) continue;
        let value: unknown = raw;
        if (param[2] === "false") {
          try {
            value = JSON.parse(raw);
          } catch {
            value = raw;
          }
        } else if (key === "action" && /^[a-z]+(?: [a-z]+)+$/i.test(raw)) {
          const [head, ...rest] = raw.split(" ");
          value = `${head}.${rest.map((word, index) => (index === 0 ? word : word[0]!.toUpperCase() + word.slice(1))).join("")}`;
        }
        args[key] = value;
      }
      calls.push({ name: (invoke[1] ?? "").trim(), arguments: args });
    }
  }
  return calls;
}

/**
 * Other models' native call markup, written as text. Each block regex also strips the markup from visible text.
 * DeepSeek V3/R1 (<｜tool▁sep｜>NAME + json fence), Kimi K2 (<|tool_call_begin|>functions.NAME:0<|tool_call_argument_begin|>{json}),
 * GLM (<tool_call>NAME<arg_key>..<arg_value>..), Qwen3-Coder (<function=NAME><parameter=K>V), MiniMax M2
 * (<minimax:tool_call><invoke name=..>) and Mistral ([TOOL_CALLS]NAME[ARGS]{json} or [TOOL_CALLS][{json}]).
 * ponytail: Mistral's marker is terminal, so everything after it is stripped; a lone DeepSeek <call_begin> without a calls wrapper eats to the end.
 */
const DEEPSEEK_BLOCK_RE = /<｜tool▁calls?▁begin｜>[\s\S]*?(?:<｜tool▁calls▁end｜>|$)/gi;
const DEEPSEEK_CALL_RE = /<｜tool▁sep｜>\s*([^\s`<]+)\s*```(?:json)?\s*([\s\S]*?)\s*```/gi;
const KIMI_BLOCK_RE = /<\|tool_calls_section_begin\|>[\s\S]*?(?:<\|tool_calls_section_end\|>|$)/gi;
const KIMI_CALL_RE =
  /<\|tool_call_begin\|>\s*(?:functions\.)?([^\s<:]+)(?::\d+)?\s*<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/gi;
const GLM_CALL_RE =
  /<tool_call>\s*([^\s<{[]+)\s*((?:<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>[\s\S]*?<\/arg_value>\s*)+)(?:<\/tool_call>|$)/gi;
const GLM_ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
const QWEN_CALL_RE = /(?:<tool_call>\s*)?<function=([^>\s]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/gi;
const QWEN_PARAM_RE = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi;
const MINIMAX_BLOCK_RE = /<minimax:tool_call>[\s\S]*?(?:<\/minimax:tool_call>|$)/gi;
const MINIMAX_INVOKE_RE = /<invoke name="([^"]*)">([\s\S]*?)<\/invoke>/gi;
const MINIMAX_PARAM_RE = /<parameter name="([^"]*)">([\s\S]*?)<\/parameter>/gi;
const MISTRAL_RE = /\[TOOL_CALLS\][\s\S]*$/;
const MARKUP_STRIP_RES = [
  DSML_BLOCK_RE,
  DEEPSEEK_BLOCK_RE,
  KIMI_BLOCK_RE,
  GLM_CALL_RE,
  QWEN_CALL_RE,
  MINIMAX_BLOCK_RE,
  MISTRAL_RE,
];

function parseMarkupCalls(content: string): unknown[] {
  const calls: unknown[] = [...parseDsmlCalls(content)];
  const jsonOrString = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  const params = (body: string, re: RegExp) =>
    Object.fromEntries([...body.matchAll(re)].map((p) => [(p[1] ?? "").trim(), jsonOrString((p[2] ?? "").trim())]));
  for (const m of content.matchAll(DEEPSEEK_CALL_RE)) calls.push({ name: m[1], arguments: m[2] });
  for (const m of content.matchAll(KIMI_CALL_RE)) calls.push({ name: m[1], arguments: m[2] });
  for (const m of content.matchAll(GLM_CALL_RE)) calls.push({ name: m[1], arguments: params(m[2] ?? "", GLM_ARG_RE) });
  for (const m of content.matchAll(QWEN_CALL_RE))
    calls.push({ name: m[1], arguments: params(m[2] ?? "", QWEN_PARAM_RE) });
  for (const block of content.matchAll(MINIMAX_BLOCK_RE)) {
    for (const m of block[0].matchAll(MINIMAX_INVOKE_RE)) {
      calls.push({ name: m[1], arguments: params(m[2] ?? "", MINIMAX_PARAM_RE) });
    }
  }
  for (const segment of content.split("[TOOL_CALLS]").slice(1)) {
    const named = segment.match(/^\s*([^\s[\]{]+)\s*\[ARGS\]/);
    const json = extractBalancedJson(named ? segment.slice(named[0].length) : segment);
    if (named) calls.push({ name: named[1], arguments: json ?? "{}" });
    else {
      const list = json && jsonOrString(json);
      if (Array.isArray(list)) calls.push(...list);
    }
  }
  return calls;
}

function parseTaggedSnippets(content: string): ParsedTaggedSnippet[] {
  const snippets: ParsedTaggedSnippet[] = [];
  for (const pattern of TAGGED_PATTERNS) {
    for (const match of content.matchAll(pattern.re)) {
      const opening = match[1] ?? "";
      const snippet = match[2]?.trim();
      if (snippet) {
        snippets.push({
          text: snippet,
          recoveryText: opening ? content.slice((match.index ?? 0) + opening.length) : undefined,
          allowCommandFallback: pattern.allowCommandFallback,
          allowAnonymousJsonPayload: pattern.allowAnonymousJsonPayload,
        });
      }
    }
  }
  const trimmed = content.trim();
  if (/^(?:call\s*:\s*)?[A-Za-z_][\w.-]*\s*\{[\s\S]*\}$/.test(trimmed)) {
    snippets.push({ text: trimmed, allowCommandFallback: false, allowAnonymousJsonPayload: false });
  }
  return snippets;
}

function normalizeSnippetText(text: string): string {
  return text.includes('<|"|>') ? normalizeGemma4Delimiters(text) : text;
}

function appendArrayToolCalls(
  text: string,
  calls: LLMToolCall[],
  knownTools: Set<string>,
  hasBashTool: boolean,
): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(normalizeSnippetText(trimmed));
    if (!Array.isArray(parsed)) return false;
    parsed.forEach((raw) => {
      const call = toolCallFromRaw(raw, calls.length, knownTools, hasBashTool);
      if (call) calls.push(call);
    });
    return true;
  } catch {
    return false;
  }
}

function snippetToPayload(snippet: string, options: Omit<ParsedTaggedSnippet, "text">): Record<string, unknown> | null {
  const jsonPayload = parseJsonishObject(snippet);
  if (jsonPayload) {
    if (typeof jsonPayload.name === "string" || typeof jsonPayload.tool === "string") return jsonPayload;
    // Pass through {"type":"function","function":{...}} wrappers to toolCallFromRaw
    if (isRecord(jsonPayload.function) && typeof (jsonPayload.function as Record<string, unknown>).name === "string") {
      return jsonPayload;
    }
    return options.allowAnonymousJsonPayload ? { name: "mari_db", arguments: jsonPayload } : null;
  }
  const callMatch = snippet.trim().match(/^(?:call\s*:\s*)?([A-Za-z_][\w.-]*)\s*(\{[\s\S]*\})\s*$/);
  if (!callMatch) {
    if (!options.allowCommandFallback) return null;
    const command = normalizeMariCommand(snippet);
    return command ? { name: "mari_db", arguments: { command } } : null;
  }
  const name = callMatch[1];
  const argsText = callMatch[2];
  if (!name || !argsText) return null;
  return {
    name,
    arguments: parseJsonishObject(argsText) ?? {},
  };
}

function normalizeMariCommand(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const command = raw.replace(/^\$+\s*/, "");
  if (command.length > 800 || /[\r\n]/.test(command) || /[;&|`$<>]/.test(command)) return null;
  if (/^mari(?:\s|$)/i.test(command)) return command;
  if (/^[A-Za-z][\w-]*(?:\s+[A-Za-z0-9_.:-]+)*$/.test(command)) return `mari ${command}`;
  return null;
}

function toolCallFromRaw(
  raw: unknown,
  index: number,
  knownTools: Set<string>,
  hasBashTool: boolean,
): LLMToolCall | null {
  if (!isRecord(raw)) return null;
  // Handle {"type":"function","function":{"name":"...","arguments":"..."}} OpenAI-style wrapper
  const fnWrap = isRecord(raw.function) ? (raw.function as Record<string, unknown>) : null;
  const nameValue = raw.name ?? raw.tool ?? fnWrap?.name;
  if (typeof nameValue !== "string") return null;
  const name = nameValue.trim();
  // "parameters" is used by many models (e.g. Llama 3.1, Gemma) instead of "arguments"
  const args = normalizeArguments(
    raw.arguments ??
      raw.args ??
      raw.input ??
      raw.parameters ??
      fnWrap?.arguments ??
      fnWrap?.args ??
      fnWrap?.parameters ??
      {},
  );
  const looseName = (value: string) => value.toLowerCase().replace(/[\s.-]+/g, "_");
  const known = knownTools.has(name) ? name : [...knownTools].find((tool) => looseName(tool) === looseName(name));
  if (known) {
    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : toolCallId(index),
      type: "function",
      function: { name: known, arguments: JSON.stringify(args) },
    };
  }

  const normalizedName = name.toLowerCase().replace(/[-.]/g, "_");
  if (!hasBashTool || !["mari", "mari_cli", "mari_command", "mari_db"].includes(normalizedName)) return null;
  const command = normalizeMariCommand(
    args.command ?? args.cmd ?? args.query ?? args.input ?? args.text ?? raw.command,
  );
  return command
    ? {
        id: toolCallId(index),
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command }) },
      }
    : null;
}

export function parseTextualToolCalls(
  content: string | null | undefined,
  tools: LLMToolDefinition[] = [],
): LLMToolCall[] {
  if (!content || tools.length === 0) return [];

  const knownTools = new Set(tools.map((tool) => tool.function.name));
  const hasBashTool = knownTools.has("bash");
  const calls: LLMToolCall[] = [];

  // Try the whole content as a single JSON object
  const wholePayload = parseJsonishObjectWithGemmaDelimiters(content);
  if (wholePayload) {
    rawToolCalls(wholePayload).forEach((raw, index) => {
      const call = toolCallFromRaw(raw, index, knownTools, hasBashTool);
      if (call) calls.push(call);
    });
  }
  if (calls.length > 0) return calls;

  parseMarkupCalls(content).forEach((raw) => {
    const call = toolCallFromRaw(raw, calls.length, knownTools, hasBashTool);
    if (call) calls.push(call);
  });
  if (calls.length > 0) return calls;

  // Try the whole content as a top-level JSON array of tool calls
  const trimmed = content.trim();
  if (trimmed.startsWith("[")) {
    appendArrayToolCalls(trimmed, calls, knownTools, hasBashTool);
    if (calls.length > 0) return calls;
  }

  parseTaggedSnippets(content).forEach((snippet) => {
    const snippetText = normalizeSnippetText(snippet.text);
    if (appendArrayToolCalls(snippetText, calls, knownTools, hasBashTool)) return;

    const options = {
      allowCommandFallback: snippet.allowCommandFallback,
      allowAnonymousJsonPayload: snippet.allowAnonymousJsonPayload,
    };
    let payload = snippetToPayload(snippetText, options);
    if (!payload && snippet.recoveryText) {
      const recovered = extractBalancedJson(snippet.recoveryText);
      if (recovered) {
        const recoveredText = normalizeSnippetText(recovered);
        if (parseJsonishObject(recoveredText) || recoveredText.trim().startsWith("[")) {
          if (appendArrayToolCalls(recoveredText, calls, knownTools, hasBashTool)) return;
          payload = snippetToPayload(recoveredText, options);
        }
      }
    }
    const call = toolCallFromRaw(payload, calls.length, knownTools, hasBashTool);
    if (call) calls.push(call);
  });
  return calls;
}

/**
 * The content without the text parseTextualToolCalls read as calls: tagged snippets are cut out; a fence only when
 * no tag matched and that fence itself parses into a call (a ```ts example stays). A call read from the whole
 * content (bare JSON, array, `name {...}`) leaves nothing.
 */
export function stripTextualToolCalls(content: string, tools: LLMToolDefinition[]): string {
  const [fence] = TAGGED_PATTERNS.filter(({ re }) => re.source.startsWith("(```"));
  let text = MARKUP_STRIP_RES.reduce((rest, re) => rest.replace(re, ""), content);
  for (const { re } of TAGGED_PATTERNS) if (re !== fence!.re) text = text.replace(re, "");
  if (text === content) {
    text = content.replace(fence!.re, (whole, _open, inner: string) =>
      parseTextualToolCalls(inner, tools).length > 0 ? "" : whole,
    );
  }
  return text === content ? "" : text.trim();
}
