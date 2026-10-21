// A new chat opens its setup wizard in the same step that applies the starred settings profile. The
// wizard reads its starting choices once, so it waits while chatPresetApplyFilters matches a pending
// apply; otherwise finishing setup wrote the blank chat's commands (Generated Videos off) back over the
// profile's. This pins that the wait starts as soon as the apply does, ends only after the applied
// chat is cached, and ignores applies to other chats.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  CHAT_PRESET_APPLY_MUTATION_KEY,
  chatPresetApplyFilters,
} from "../../packages/client/src/lib/chat-preset-apply";

const require = createRequire(new URL("../../packages/client/package.json", import.meta.url));
const { QueryClient } = require("@tanstack/react-query") as typeof import("@tanstack/react-query");

const queryClient = new QueryClient();
// The key the wizard reads its starting choices from (must mirror chatKeys.detail in use-chats.ts).
const chatDetailKey = ["chats", "detail", "new"] as const;
let finishApply: (() => void) | undefined;
const cachedChat = () => queryClient.getQueryData<{ metadata: Record<string, unknown> }>(chatDetailKey);
const apply = queryClient
  .getMutationCache()
  .build(queryClient, {
    mutationKey: CHAT_PRESET_APPLY_MUTATION_KEY,
    mutationFn: () => new Promise<void>((resolve) => (finishApply = resolve)),
    onSuccess: () => {
      queryClient.setQueryData(chatDetailKey, { metadata: { conversationCommandToggles: { video: true } } });
    },
  })
  .execute({ presetId: "profile", chatId: "new" });

// The wizard's first render comes after the caller started the apply, in the same step.
assert.equal(queryClient.isMutating(chatPresetApplyFilters("new")), 1, "the wizard waits from the first render");
assert.equal(queryClient.isMutating(chatPresetApplyFilters("other")), 0, "another chat's wizard does not wait");

let sawWaitEndBeforeCache = false;
const unsubscribe = queryClient.getMutationCache().subscribe(() => {
  if (queryClient.isMutating(chatPresetApplyFilters("new")) === 0 && !cachedChat()) sawWaitEndBeforeCache = true;
});
while (!finishApply) await new Promise((resolve) => setTimeout(resolve, 0));
finishApply!();
await apply;
unsubscribe();

assert.equal(queryClient.isMutating(chatPresetApplyFilters("new")), 0, "the wizard opens once the profile is applied");
assert.equal(sawWaitEndBeforeCache, false, "the wait never ends before the applied chat is cached");
assert.deepEqual(cachedChat()?.metadata.conversationCommandToggles, { video: true });

console.log("The setup wizard waits for a new chat's profile and then starts from its settings.");
