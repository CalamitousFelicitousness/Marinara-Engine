import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  orderBranches,
  pickBranchSnippet,
  previewSpeakerName,
  visibleBranchMessages,
} from "../../packages/client/src/lib/chat-branch-preview.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const branches = [
  { id: "old", updatedAt: "2026-09-01T00:00:00Z", lastMessageAt: "2026-09-01T00:00:00Z" },
  { id: "active", updatedAt: "2026-09-02T00:00:00Z", lastMessageAt: "2026-09-02T00:00:00Z" },
  { id: "recent", updatedAt: "2026-09-03T00:00:00Z", lastMessageAt: "2026-09-03T00:00:00Z" },
];
assert.deepEqual(
  orderBranches(branches, "active").map((branch) => branch.id),
  ["active", "recent", "old"],
  "the active branch leads, the rest follow by activity",
);
assert.deepEqual(
  branches.map((branch) => branch.id),
  ["old", "active", "recent"],
  "ordering leaves the cached rows untouched",
);

const message = (
  id: string,
  role: string,
  content: string,
  extra: unknown = {},
  characterId: string | null = null,
) => ({
  id,
  role,
  content,
  extra,
  characterId,
});
const tail = [
  message("u1", "user", "Can I get closer?", JSON.stringify({ personaSnapshot: { name: "Rin" } })),
  message("a1", "assistant", "The mandibles click.", {}, "amy"),
  message("h1", "assistant", "stored for context", { hiddenFromUser: true }, "amy"),
  message("e1", "assistant", "   ", {}, "amy"),
];
assert.deepEqual(
  visibleBranchMessages(tail).map((row) => row.id),
  ["u1", "a1"],
  "hidden and blank rows never reach the preview",
);

const snippet = pickBranchSnippet(tail);
assert.ok(snippet, "a tail with visible messages yields a snippet");
assert.ok(visibleBranchMessages(tail).includes(snippet!), "the snippet is one of the visible tail messages");
assert.equal(pickBranchSnippet([]), null);
assert.equal(pickBranchSnippet([tail[2]!, tail[3]!]), null, "an all-hidden tail has no snippet");

const names = new Map([["amy", "Amy"]]);
assert.equal(previewSpeakerName(tail[0]!, names), "Rin", "user rows use the persona snapshot, even as a JSON string");
assert.equal(previewSpeakerName(tail[1]!, names), "Amy");
assert.equal(previewSpeakerName(message("u2", "user", "hi"), names), null, "no snapshot falls back to a role label");
assert.equal(previewSpeakerName(message("a2", "assistant", "hi", {}, "gone"), names), null);

const selectorSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/chat/ChatBranchesPanel.tsx"),
  "utf8",
);
const modalRendererSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/layout/ModalRenderer.tsx"),
  "utf8",
);
assert.match(selectorSource, /openModal\("chat-branch-browser"/u, "the branches drawer opens the browser");
assert.match(selectorSource, /<ChatBranchTail /u, "drawer rows show the branch tail");
assert.match(modalRendererSource, /case "chat-branch-browser":/u, "the browser is registered with ModalRenderer");

console.log("chat-branch-preview regression passed.");
