import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  isMistralAdjustableReasoningModel,
  resolveProviderReasoningEffort,
} from "../../packages/shared/src/constants/model-lists.js";
import { createLLMProvider } from "../../packages/server/src/services/llm/provider-registry.js";
import type { ChatMessage, ChatOptions } from "../../packages/server/src/services/llm/base-provider.js";

// #7164: Mistral Large 4 through the "mistral" provider. A local stub answers the way Mistral's Chat Completions API
// does (https://docs.mistral.ai/capabilities/reasoning): with reasoning_effort "high" the content is a list of a
// ThinkChunk and a TextChunk, streamed as chunk lists until the answer turns into plain string deltas. No live call.
const THINKING = "Checking the scene.";
const ANSWER = "The experiment is ready.";
const usage = { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 };
const thinkChunk = (text: string) => ({ type: "thinking", thinking: [{ type: "text", text }] });

const bodies: Array<Record<string, unknown>> = [];
const server = createServer(async (request, response) => {
  let input = "";
  for await (const chunk of request) input += chunk;
  const body = JSON.parse(input) as Record<string, unknown>;
  bodies.push(body);
  const reasons = body.reasoning_effort === "high";
  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: reasons ? [thinkChunk(THINKING), { type: "text", text: ANSWER }] : ANSWER,
            },
            finish_reason: "stop",
          },
        ],
        usage,
      }),
    );
    return;
  }
  const deltas = reasons
    ? [
        { role: "assistant", content: [thinkChunk("Checking ")] },
        { content: [thinkChunk("the scene")] },
        { content: [thinkChunk("."), { type: "text", text: "The " }] },
        { content: "experiment is ready." },
      ]
    : [{ role: "assistant", content: "The experiment " }, { content: "is ready." }];
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const delta of deltas) response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
  // Mistral reports usage on its last chunk without stream_options.
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const mistral = createLLMProvider("mistral", baseUrl, "fixture");
  const lastBody = () => {
    const body = bodies.at(-1);
    assert.ok(body, "the stub received a request");
    return body;
  };
  const user: ChatMessage[] = [{ role: "user", content: "Continue." }];

  // Which models take reasoning_effort, and what Marinara's levels become.
  for (const model of [
    "mistral-large-4-0",
    "mistral-large-4",
    "mistral-medium-3-5",
    "mistral-medium-3.5",
    "mistral-small-latest",
  ]) {
    assert.equal(isMistralAdjustableReasoningModel(model), true, `${model} takes reasoning_effort`);
  }
  for (const model of [
    "magistral-medium-latest",
    "mistral-large-latest",
    "mistral-large-2411",
    "mistral-large-40",
    "mistral-small-2506",
    "mistralai/mistral-large-4",
  ]) {
    assert.equal(isMistralAdjustableReasoningModel(model), false, `${model} keeps its own reasoning behaviour`);
  }
  for (const level of ["low", "medium", "high", "xhigh", "maximum"] as const) {
    assert.equal(
      resolveProviderReasoningEffort({ provider: "mistral", model: "mistral-large-4-0", reasoningEffort: level }),
      "high",
      `${level} becomes Mistral's only level`,
    );
  }
  assert.equal(
    resolveProviderReasoningEffort({ provider: "mistral", model: "mistral-large-4-0", reasoningEffort: "none" }),
    null,
  );
  assert.equal(
    resolveProviderReasoningEffort({
      provider: "openrouter",
      model: "mistralai/mistral-large-4",
      reasoningEffort: "low",
    }),
    "low",
    "other providers serving Mistral models are unchanged",
  );

  // Request fields: only what Mistral accepts, with reasoning_effort mapped onto "high" | "none".
  const requestOptions: ChatOptions = {
    model: "mistral-large-4-0",
    stream: true,
    maxTokens: 500,
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    minP: 0.1,
    frequencyPenalty: 0.2,
    presencePenalty: 0.3,
    stop: ["END"],
    serviceTier: "flex",
    verbosity: "low",
    reasoningEffort: "xhigh",
    enabledParameters: { topK: true, reasoningEffort: true, verbosity: true },
  };
  for await (const _chunk of mistral.chat(user, requestOptions)) {
    // drain
  }
  const sent = lastBody();
  assert.equal(sent.reasoning_effort, "high");
  assert.equal(sent.max_tokens, 500);
  assert.equal(sent.temperature, 0.7);
  assert.equal(sent.top_p, 0.9);
  assert.equal(sent.frequency_penalty, 0.2);
  assert.equal(sent.presence_penalty, 0.3);
  assert.deepEqual(sent.stop, ["END"]);
  for (const field of [
    "stream_options",
    "seed",
    "max_completion_tokens",
    "logit_bias",
    "user",
    "top_k",
    "min_p",
    "service_tier",
    "verbosity",
    "prompt_mode",
    "reasoning",
  ]) {
    assert.equal(field in sent, false, `Mistral never receives ${field}`);
  }

  const sentEffort = async (model: string, reasoningEffort: ChatOptions["reasoningEffort"]) => {
    await mistral.chatComplete(user, { model, stream: false, reasoningEffort });
    return lastBody().reasoning_effort;
  };
  assert.equal(await sentEffort("mistral-large-4-0", "low"), "high");
  assert.equal(await sentEffort("mistral-large-4-0", "none"), "none", "Off and JSON agents turn reasoning off");
  assert.equal(await sentEffort("mistral-large-4-0", undefined), undefined, "no level leaves Mistral's default");
  assert.equal(await sentEffort("magistral-medium-latest", "high"), undefined);
  assert.equal(await sentEffort("magistral-medium-latest", "none"), undefined);
  assert.equal(await sentEffort("mistral-large-latest", "high"), undefined);
  assert.equal(await sentEffort("unknown-mistral", "none"), undefined);

  // A prompt_mode set in Custom Parameters is never sent together with reasoning_effort.
  await mistral.chatComplete(user, {
    model: "mistral-large-4-0",
    stream: false,
    reasoningEffort: "high",
    customParameters: { prompt_mode: "reasoning" },
  });
  assert.equal(lastBody().prompt_mode, "reasoning");
  assert.equal("reasoning_effort" in lastBody(), false);

  // ThinkChunk/TextChunk replies: the thinking reaches onThinking and only the text becomes the reply, through both
  // entry points, streamed and not. Without reasoning the content is a plain string.
  for (const reasoningEffort of ["high", "none"] as const) {
    const expectedThinking = reasoningEffort === "high" ? THINKING : "";
    for (const stream of [true, false]) {
      let thinking = "";
      let streamed = "";
      const options: ChatOptions = {
        model: "mistral-large-4-0",
        stream,
        reasoningEffort,
        onThinking: (chunk) => {
          thinking += chunk;
        },
      };
      const complete = await mistral.chatComplete(user, {
        ...options,
        onToken: stream
          ? (chunk) => {
              streamed += chunk;
            }
          : undefined,
      });
      const label = `chatComplete effort=${reasoningEffort} stream=${stream}`;
      assert.equal(complete.content, ANSWER, label);
      assert.equal(complete.finishReason, "stop", label);
      assert.equal(complete.usage?.totalTokens, 50, `${label} reads usage`);
      assert.equal(complete.providerMetadata, undefined, `${label} keeps nothing to replay`);
      if (stream) assert.equal(streamed, ANSWER, label);
      assert.equal(thinking, expectedThinking, label);

      thinking = "";
      let text = "";
      const generator = mistral.chat(user, options);
      let step = await generator.next();
      while (!step.done) {
        assert.equal(typeof step.value, "string");
        text += step.value;
        step = await generator.next();
      }
      assert.equal(text, ANSWER, `chat effort=${reasoningEffort} stream=${stream}`);
      assert.ok(!text.includes("[object Object]"));
      assert.equal(thinking, expectedThinking, `chat effort=${reasoningEffort} stream=${stream}`);
      assert.equal(step.value && step.value.totalTokens, 50, `chat effort=${reasoningEffort} stream=${stream} usage`);
    }
  }

  // A final assistant message (Assistant Prefill) is sent as a Mistral prefix, without reasoning fields that another
  // provider saved; a system message right after an assistant turn goes as a user message.
  const history: ChatMessage[] = [
    { role: "system", content: "You are the narrator." },
    { role: "user", content: "Hello." },
    { role: "assistant", content: "Hi.", providerMetadata: { reasoning_content: "Earlier thinking." } },
    { role: "system", content: "[Author's note]" },
    { role: "system", content: "[Lore]" },
    { role: "user", content: "Continue.", images: ["data:image/png;base64,iVBORw0KGgo="] },
    { role: "assistant", content: "Sure,", providerMetadata: { reasoning_content: "pre-think", partial: true } },
  ];
  await mistral.chatComplete(history, { model: "mistral-large-4-0", stream: false });
  assert.deepEqual(lastBody().messages, [
    { role: "system", content: "You are the narrator." },
    { role: "user", content: "Hello." },
    { role: "assistant", content: "Hi." },
    { role: "user", content: "[Author's note]" },
    { role: "system", content: "[Lore]" },
    {
      role: "user",
      content: [
        { type: "text", text: "Continue." },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    },
    { role: "assistant", content: "Sure,", prefix: true },
  ]);

  // Tool calls replay unchanged, and a final tool result is not a prefix.
  const toolHistory: ChatMessage[] = [
    { role: "user", content: "Roll." },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "abcDEF123", type: "function", function: { name: "roll", arguments: "{}" } }],
    },
    { role: "tool", content: "4", tool_call_id: "abcDEF123" },
  ];
  await mistral.chatComplete(toolHistory, { model: "mistral-large-4-0", stream: false });
  assert.deepEqual((lastBody().messages as unknown[]).slice(1), [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "abcDEF123", type: "function", function: { name: "roll", arguments: "{}" } }],
    },
    { role: "tool", content: "4", tool_call_id: "abcDEF123" },
  ]);

  // Other providers keep their request shape for the same model name and history.
  const custom = createLLMProvider("custom", baseUrl, "fixture");
  for await (const _chunk of custom.chat(history, {
    model: "mistral-large-4-0",
    stream: true,
    reasoningEffort: "high",
  })) {
    // drain
  }
  const customBody = lastBody();
  assert.deepEqual(customBody.stream_options, { include_usage: true });
  assert.equal("reasoning_effort" in customBody, false);
  const customMessages = customBody.messages as Array<Record<string, unknown>>;
  assert.equal(customMessages[3]?.role, "system");
  assert.deepEqual(customMessages.at(-1), {
    role: "assistant",
    content: "Sure,",
    reasoning_content: "pre-think",
    partial: true,
  });

  console.info("Mistral Large 4 requests, reasoning levels and ThinkChunk replies passed.");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
