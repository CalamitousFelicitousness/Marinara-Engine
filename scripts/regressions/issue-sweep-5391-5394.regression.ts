import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatSummaryEntry } from "../../packages/shared/src/types/chat.js";
import { getChatSummaryMessageIdsToUnhideAfterDelete } from "../../packages/shared/src/utils/chat-summary-entries.js";
import {
  customAgentUsesLorebookBackfill,
  getCustomLorebookBackfillChunk,
  getCustomLorebookBackfillSettings,
} from "../../packages/server/src/routes/generate/lorebook-keeper-utils.js";
import { parseCharacterCommands } from "../../packages/server/src/services/conversation/character-commands.js";
import { ensureLorebookFolderPaths } from "../../packages/server/src/services/generation/professor-mari-command-runtime.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const professorMariFolderCommand = parseCharacterCommands(
  '<update_lorebook>{"name":"Arcadia","folders":["Characters/Luna/Background"],"entries":[{"name":"Luna history","path":"Characters/Luna/Background","content":"Born beneath the silver moon."}]}</update_lorebook>',
).commands[0];
assert.equal(professorMariFolderCommand?.type, "update_lorebook");
if (professorMariFolderCommand?.type === "update_lorebook") {
  assert.deepEqual(professorMariFolderCommand.folders, ["Characters/Luna/Background"]);
  assert.equal(professorMariFolderCommand.entries?.[0]?.path, "Characters/Luna/Background");
}

const createdFolders: Array<{ id: string; name: string; parentFolderId: string | null }> = [];
const folderResult = await ensureLorebookFolderPaths(
  {
    async listFolders() {
      return createdFolders;
    },
    async createFolder(_lorebookId: string, input: { name: string; parentFolderId: string | null }) {
      const folder = { id: `folder-${createdFolders.length + 1}`, ...input };
      createdFolders.push(folder);
      return folder;
    },
  },
  "lorebook-1",
  ["Characters/Luna/Background", "Characters/Luna/Relationships"],
);
assert.equal(folderResult.createdCount, 4);
assert.equal(folderResult.folderIds.get("characters/luna/background"), "folder-3");

const messages = [
  { id: "user-1", role: "user", content: "First turn" },
  { id: "assistant-1", role: "assistant", content: "First reply" },
  { id: "user-2", role: "user", content: "Second turn" },
  { id: "assistant-2", role: "assistant", content: "Second reply" },
  { id: "user-3", role: "user", content: "Newest turn" },
];
assert.deepEqual(getCustomLorebookBackfillSettings({ lorebookBackfillEnabled: true }), {
  enabled: true,
  chunkSize: 25,
});
assert.equal(
  customAgentUsesLorebookBackfill({
    phase: "post_processing",
    isCustomAgent: true,
    settings: {
      resultType: "lorebook_update",
      lorebookBackfillEnabled: true,
      customCapabilities: { edit_lorebooks: true },
      customAgentPermissionsExplicit: true,
    },
  }),
  true,
);
assert.deepEqual(
  getCustomLorebookBackfillChunk(messages, 0, null, 1)?.messages.map((message) => message.id),
  ["user-1", "assistant-1"],
);
assert.deepEqual(
  getCustomLorebookBackfillChunk(messages, 0, "assistant-1", 1)?.messages.map((message) => message.id),
  ["user-2", "assistant-2"],
);
assert.equal(
  getCustomLorebookBackfillChunk(messages, 0, null, 3)?.target.id,
  "assistant-1",
  "Backfill chunk size counts chat messages rather than assistant replies",
);

const summaryEntries = [
  { id: "source-a", enabled: true, hiddenMessageIds: ["message-a", "message-shared"] },
  { id: "source-b", enabled: true, hiddenMessageIds: ["message-b"] },
  { id: "retained", enabled: true, hiddenMessageIds: ["message-shared", "message-retained"] },
] as ChatSummaryEntry[];
assert.deepEqual(
  getChatSummaryMessageIdsToUnhideAfterDelete(summaryEntries, new Set(["source-a", "source-b"])).sort(),
  ["message-a", "message-b"],
);

const summaryPopoverSource = readFileSync(
  join(REPOSITORY_ROOT, "packages/client/src/components/chat/SummaryPopover.tsx"),
  "utf8",
);
assert.match(summaryPopoverSource, /deleteSummaryEntry\.mutateAsync\(\{ chatId, entryIds \}\)/u);
assert.match(summaryPopoverSource, /new Set\(displayEntries\.map\(\(entry\) => entry\.id\)\)/u);

console.info("Issue sweep #5391/#5394 regression checks passed");
