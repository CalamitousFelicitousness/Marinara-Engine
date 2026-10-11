import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  __setSdkForTesting,
  ClaudeSubscriptionProvider,
} from "../../packages/server/src/services/llm/providers/claude-subscription.provider.js";
import { register } from "../../packages/server/src/assets/claude-code-plugin/hooks/register.mjs";

// The provider presets the session title (no hidden naming request) and loads the chat-context mod.
let sdkOptions: Record<string, unknown> = {};
__setSdkForTesting({
  query: ((args: { options: Record<string, unknown> }) => {
    sdkOptions = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "Reply", usage: {} };
    })();
  }) as never,
});
try {
  await new ClaudeSubscriptionProvider("", "").chatComplete([{ role: "user", content: "Hello" }], {
    model: "claude-opus-5",
  });
} finally {
  __setSdkForTesting(null);
}
assert.equal(sdkOptions.title, "Title", "a preset title skips the CLI's hidden session-naming request");
const plugins = sdkOptions.plugins as Array<{ type: string; path: string }>;
assert.equal(plugins.length, 1);
assert.equal(plugins[0]!.type, "local");

// The plugin directory is complete where the provider points, so it ships with the build.
const pluginDir = plugins[0]!.path;
assert.ok(existsSync(join(pluginDir, ".claude-plugin", "plugin.json")), "plugin manifest");
const hooks = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")) as { modules: string[] };
assert.deepEqual(hooks.modules, ["./register.mjs"]);
assert.ok(existsSync(join(pluginDir, "hooks", "register.mjs")), "hooks module");

// The mod drops every attachment Claude Code adds, without handing it on.
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
register((event: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(event, handler));
assert.deepEqual([...handlers.keys()], ["prompt.attachment"]);
const next = () => assert.fail("an attachment must not reach Claude Code's default handler");
for (const type of ["session_context", "context_sections", "environment", "model", "date", "total_tokens_reminder"]) {
  assert.deepEqual(await handlers.get("prompt.attachment")!({}, { type }, next), { text: null }, type);
}

console.log("Claude subscription chat-context regression passed");
