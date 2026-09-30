// The player's Use button on one of a ruleset's items, outside a fight. What the item does to its
// user lands on their sheet with the Engine's dice, the item is spent, and both are written together:
// the bag in the chat's metadata and the sheet on the game-state row the player sees, inside the
// chat's metadata queue and one transaction, so a use either changes both or changes neither.
import {
  defaultRulesetSheetBuild,
  normalizeCharacterLookupName,
  rulesetCombatRoller,
  rulesetItemUseLine,
  useRulesetItemOutsideFight,
  type GameInventoryItemUser,
  type GameInventoryStack,
  type RulesetItemBook,
  type RulesetItemUseOutcome,
  type RulesetItemUseRefusal,
  type RulesetItemUseSaid,
  type RulesetLiveStates,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { resolveVisibleGameStateAnchor } from "../../routes/generate/generate-route-utils.js";
import { createChatsStorage, withChatMetadataPatchQueue } from "../storage/chats.storage.js";
import { createGameStateStorage, parseStoredRulesetLive } from "../storage/game-state.storage.js";
import { rollDieSecurely } from "./dice-rng.js";
import { applyGameInventoryChangeHeld, loadGameInventoryItemBook } from "./game-inventory.service.js";
import { loadGameRulesetSheetContext, type GameRulesetSheetContext } from "./ruleset-sheet-turn.service.js";

export type GameItemUseResult =
  | {
      ok: true;
      inventory: GameInventoryStack[];
      rulesetLive: RulesetLiveStates;
      said: RulesetItemUseSaid;
      /** What happened, in one line for the Game Master. */
      line: string;
      playerStats?: unknown;
    }
  | { ok: false; status: 404 | 409; error: string; reason?: RulesetItemUseRefusal | "no-ruleset" | "no-state" };

/** Uses the item on one stack for whoever carries it: the party member the stack names, or the player.
 *  `live` is every character's live state, and the one who used it comes back changed. */
function useForCarrier(
  context: GameRulesetSheetContext,
  itemOf: RulesetItemBook["itemOf"],
  stacks: readonly GameInventoryStack[],
  stackId: string,
  live: RulesetLiveStates,
  roll: (sides: number) => number,
): { outcome: RulesetItemUseOutcome; live: RulesetLiveStates } {
  const holder = stacks.find((each) => each.id === stackId)?.holder;
  const named = (name: string) =>
    context.cards.find((each) => normalizeCharacterLookupName(each.name) === normalizeCharacterLookupName(name));
  // The player's own bag is the player's sheet: the card named for who the chat plays as, or the first
  // card when none is, as the inventory and checks read it.
  const card = holder
    ? named(holder)
    : ((context.playerName ? named(context.playerName) : undefined) ?? context.cards[0]);
  const name = holder ?? card?.name ?? context.playerName ?? "The player";
  const key = normalizeCharacterLookupName(name);
  const outcome = useRulesetItemOutsideFight({
    definition: context.definition,
    itemOf,
    stacks,
    stackId,
    user: { name, build: card?.build ?? defaultRulesetSheetBuild(context.definition), live: live[key] },
    roll,
  });
  if (!outcome.ok) return { outcome, live };
  const next: RulesetLiveStates = { ...live };
  // A character back at their defaults drops out of the store, as the in-game sheet leaves them.
  if (Object.keys(outcome.live).length > 0) next[key] = outcome.live;
  else delete next[key];
  return { outcome, live: next };
}

/**
 * What the Game Master's `[inventory: action="use"]` uses items with, on a working copy of the party's
 * live sheets that starts from `baseLive`. Dice come from `seed`, so a reply's answers are worked out
 * twice (before and after it is saved) with the same rolls.
 */
export function gameInventoryItemUser(
  context: GameRulesetSheetContext,
  itemOf: RulesetItemBook["itemOf"],
  baseLive: RulesetLiveStates,
  seed: number,
): { useItem: GameInventoryItemUser; live: () => RulesetLiveStates; used: () => boolean } {
  let live = baseLive;
  let used = false;
  const roll = rulesetCombatRoller(seed, 0);
  return {
    useItem: (stacks, stackId) => {
      const done = useForCarrier(context, itemOf, stacks, stackId, live, roll);
      if (!done.outcome.ok) return { ok: false, reason: done.outcome.reason };
      live = done.live;
      used = true;
      return {
        ok: true,
        stacks: done.outcome.stacks,
        journal: done.outcome.journal,
        line: rulesetItemUseLine(done.outcome.said),
      };
    },
    live: () => live,
    used: () => used,
  };
}

/** A use refused inside the transaction, so nothing it touched is written. */
class ItemUseRefused extends Error {
  constructor(readonly reason: RulesetItemUseRefusal | "no-state") {
    super(reason);
  }
}

export async function useGameRulesetItem(
  db: DB,
  chatId: string,
  stackId: string,
  roll: (sides: number) => number = rollDieSecurely,
): Promise<GameItemUseResult> {
  // Read before the chat's queue is held, as every other inventory change reads them.
  const context = await loadGameRulesetSheetContext(db, chatId);
  const book = context ? await loadGameInventoryItemBook(db, { chatId }, "player") : undefined;
  if (!context || !book)
    return { ok: false, status: 409, error: "This game has no ruleset items", reason: "no-ruleset" };
  let outcome: Extract<ReturnType<typeof useRulesetItemOutsideFight>, { ok: true }> | null = null;
  let rulesetLive: RulesetLiveStates = {};
  let committed: Awaited<ReturnType<typeof applyGameInventoryChangeHeld<null>>> = null;
  try {
    await withChatMetadataPatchQueue(chatId, () =>
      db.transaction(async () => {
        const states = createGameStateStorage(db);
        const visibleAnchor = resolveVisibleGameStateAnchor(await createChatsStorage(db).listMessages(chatId));
        const row = await states.getForGeneration(chatId, { preferLatestVisible: true, visibleAnchor });
        if (!row) throw new ItemUseRefused("no-state");
        const stored: RulesetLiveStates = parseStoredRulesetLive(row.rulesetLive) ?? {};
        let next: RulesetLiveStates = stored;
        committed = await applyGameInventoryChangeHeld(db, chatId, (stacks) => {
          const done = useForCarrier(context, book.itemOf, stacks, stackId, stored, roll);
          if (!done.outcome.ok) throw new ItemUseRefused(done.outcome.reason);
          outcome = done.outcome;
          next = done.live;
          return { stacks: done.outcome.stacks, journal: done.outcome.journal, value: null };
        });
        if (!committed || !outcome) throw new ItemUseRefused("no-stack");
        const written =
          (visibleAnchor
            ? await states.updateByMessage(visibleAnchor.messageId, visibleAnchor.swipeIndex, chatId, {
                rulesetLive: next,
              })
            : null) ?? (await states.updateLatest(chatId, { rulesetLive: next }));
        if (!written) throw new ItemUseRefused("no-state");
        rulesetLive = parseStoredRulesetLive(written.rulesetLive) ?? {};
      }),
    );
  } catch (error) {
    if (!(error instanceof ItemUseRefused)) throw error;
    if (error.reason === "no-stack") return { ok: false, status: 404, error: "No such stack", reason: "no-stack" };
    return { ok: false, status: 409, error: `The item could not be used (${error.reason})`, reason: error.reason };
  }
  const used = outcome as Extract<ReturnType<typeof useRulesetItemOutsideFight>, { ok: true }> | null;
  const done = committed as Awaited<ReturnType<typeof applyGameInventoryChangeHeld<null>>>;
  if (!used || !done) return { ok: false, status: 404, error: "Chat not found", reason: "no-stack" };
  return {
    ok: true,
    inventory: done.stacks,
    rulesetLive,
    said: used.said,
    line: rulesetItemUseLine(used.said),
    ...(done.playerStats ? { playerStats: done.playerStats } : {}),
  };
}
