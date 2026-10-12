// Markets (#6917, #6934): the place a scene is in, the market day there, and the market a Game
// Master's buys and sales are answered at.
import {
  answeredGamePlaces,
  defaultRulesetSheetBuild,
  evaluateRulesetSheetLive,
  gameInventoryNameKey,
  gameMarketDayStart,
  lastGamePlace,
  readResolvedInventoryTags,
  rulesetMarketStockKey,
  normalizeCharacterLookupName,
  resolveRulesetValueRef,
  rulesetMarketPlace,
  rulesetMarketQuoter,
  rulesetSheetItems,
  type GameInventoryMarket,
  type GameInventoryStack,
  type GamePlace,
  type RulesetItemBook,
  type RulesetLiveStates,
  type RulesetMarketDay,
  type WorldKitItems,
  type WorldLedgerCarry,
  worldLedgerCarry,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { parseExtra } from "../generation/prompt-attachments.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import type { ResolvedGameRuleset } from "./ruleset-registry.service.js";
import { gameRulesetLayerOptions, readMetadata } from "./game-inventory.service.js";
import { loadGameRulesetSheetContext } from "./ruleset-sheet-turn.service.js";

/** The Game Master's own replies before the telling a regeneration replaces, oldest first. */
export interface GameRepliesBefore {
  /** Since the latest conversation start, as the Game Master's own context is scoped: what the place,
   *  and the history asked for, are read from. */
  scoped: string[];
  /** All of them: what the world's ledger is read from (worldgen W4), since a conversation start
   *  scopes what the model reads, not what the story did to the world. */
  all: string[];
  /** What earlier sessions carried in (W10-0), read first in `all` as one reply; null in a first session. */
  carried: WorldLedgerCarry | null;
  /** The player's message the reply answers: the last one before it (worldgen W10, a fight's recap). */
  player: string | null;
}

/** A Game Master's own reply: an assistant message that is not a party's turn (a tag a party's model
 *  echoes never counts for the world), as a tag a player types never does. */
export function isGameMasterReply(message: { role: string; content: unknown }): message is {
  role: string;
  content: string;
} {
  return (
    message.role === "assistant" &&
    typeof message.content === "string" &&
    !message.content.trimStart().startsWith("[party-turn]")
  );
}

export async function gameRepliesBefore(db: DB, chatId: string, replacing?: string | null): Promise<GameRepliesBefore> {
  const chats = createChatsStorage(db);
  const [messages, chat] = await Promise.all([chats.listMessages(chatId), chats.getById(chatId)]);
  const end = replacing ? messages.findIndex((message) => message.id === replacing) : -1;
  const before = end >= 0 ? messages.slice(0, end) : messages;
  // Each session is its own chat: what the earlier ones did to the world comes first, as one reply.
  const carried = worldLedgerCarry(readMetadata(chat?.metadata).gameLedgerCarry);
  const all: string[] = carried?.tags ? [carried.tags] : [];
  let scopedFrom = all.length;
  let player: string | null = null;
  for (const message of before) {
    if (parseExtra(message.extra).isConversationStart === true) scopedFrom = all.length;
    if (message.role === "user" && typeof message.content === "string") player = message.content;
    if (isGameMasterReply(message)) {
      all.push(message.content);
      // Answered: a later reply answers only what the player writes after it.
      if (message.content.trim()) player = null;
    }
  }
  return { scoped: all.slice(scopedFrom), all, carried, player };
}

/**
 * The Game Master's own replies before a reply, as the player sees them (each its active swipe), from
 * the latest conversation start on, as the Game Master's own context is scoped; a regeneration reads
 * only what came before the telling it replaces. A tag a player types is never read.
 */
async function gameMasterReplies(db: DB, chatId: string, replacing?: string | null): Promise<string[]> {
  return (await gameRepliesBefore(db, chatId, replacing)).scoped;
}

/** The place the chat's scene is in before a reply: the last place tag the Engine answered in the Game
 *  Master's replies (`gameMasterReplies`). Null when none was said. */
export async function gamePlaceBefore(db: DB, chatId: string, replacing?: string | null): Promise<GamePlace | null> {
  return lastGamePlace(await gameMasterReplies(db, chatId, replacing));
}

/**
 * The place a reply happens at and its market day (#6934): from the Game Master's replies before it
 * (`gameMasterReplies`), then the reply's own answered place tags, if given. The day is named by the
 * chat, the place tag that began it and that place, so the same day always rolls the same shelf; what
 * it saw are the buys and sales the Engine answered after that tag, before the reply (the reply's own
 * are counted as it is read). A sale's worth is read back off its price in the book's coins.
 */
export async function gameMarketDayFor(
  db: DB,
  chatId: string,
  replacing: string | null | undefined,
  reply: string | undefined,
  book: Pick<RulesetItemBook, "coinNamed" | "coins">,
): Promise<{ place: GamePlace | null; day: RulesetMarketDay }> {
  const texts = await gameMasterReplies(db, chatId, replacing);
  const marks = answeredGamePlaces(reply === undefined ? texts : [...texts, reply]);
  const start = gameMarketDayStart(marks);
  const bought = new Map<string, number>();
  const stockBought = new Map<string, number>();
  const paidOut = new Map<string, number>();
  if (start) {
    texts.forEach((text, index) => {
      if (index < start.mark.text) return;
      const since = index === start.mark.text ? text.slice(start.mark.end) : text;
      for (const tag of readResolvedInventoryTags(since)) {
        if (!tag.ok) continue;
        if (tag.action === "buy") {
          const key = tag.stock ? rulesetMarketStockKey(tag.seller ?? "", tag.item) : gameInventoryNameKey(tag.item);
          const counts = tag.stock ? stockBought : bought;
          counts.set(key, (counts.get(key) ?? 0) + tag.count);
        }
        if (tag.action === "sell" && tag.price) {
          const said = /^(\d+)\s+(.+)$/.exec(tag.price.trim());
          const coin = said ? book.coinNamed?.(said[2]!) : undefined;
          const family = coin ? book.coins.find((each) => each.item === coin.coin.item)?.coin?.family : undefined;
          if (said && coin && family) {
            paidOut.set(family, (paidOut.get(family) ?? 0) + Number(said[1]) * coin.coin.value);
          }
        }
      }
    });
  }
  const begun = start?.mark.place;
  return {
    place: marks.at(-1)?.place ?? null,
    day: {
      key: start ? `${chatId}|${start.ordinal}|${begun?.name ?? ""}|${begun?.size ?? ""}` : "",
      bought,
      stockBought,
      paidOut,
    },
  };
}

/**
 * A maker of the market a Game Master's buys and sales are answered at, for a game whose ruleset
 * declares one (a fresh market for each reading of a reply, since a market counts what the reply buys
 * and sells): the place in
 * force, the ruleset's prices and sellers, and each buyer's sheet for a seller's `only`, read as an
 * item's check is (the player's card for no name or the player's own, a member's own card by name, and
 * a blank sheet for someone with none), with what they carry at that tag and `live`, the turn's own live state (the
 * one its items are used with, never a replaced telling's). Undefined for a ruleset without a market.
 */
export async function loadGameMarket(
  db: DB,
  chatId: string,
  resolved: ResolvedGameRuleset | null | undefined,
  book: RulesetItemBook,
  place: GamePlace | null,
  live: RulesetLiveStates | null | undefined,
  day?: RulesetMarketDay,
): Promise<(() => GameInventoryMarket) | undefined> {
  if (resolved?.status !== "ok" || !resolved.definition.items?.market) return undefined;
  const { definition } = resolved;
  const market = resolved.definition.items.market;
  const context = await loadGameRulesetSheetContext(db, chatId, resolved);
  const same = (a: string, b: string) => normalizeCharacterLookupName(a) === normalizeCharacterLookupName(b);
  const cards = context?.cards ?? [];
  const player =
    (context?.playerName ? cards.find((card) => same(card.name, context.playerName!)) : undefined) ?? cards[0];
  const meets = (
    only: { value: Parameters<typeof resolveRulesetValueRef>[2]; atLeast: number },
    who: string | undefined,
    stacks: readonly GameInventoryStack[],
  ) => {
    const own = who ? cards.find((card) => same(card.name, who)) : undefined;
    const isPlayer = who ? (own ? own === player : !!context?.playerName && same(who, context.playerName)) : true;
    const card = own ?? (isPlayer ? player : undefined);
    const name = card?.name ?? who ?? "";
    const build = card?.build ?? defaultRulesetSheetBuild(definition);
    const held = rulesetSheetItems({ itemOf: book.itemOf }, stacks, isPlayer ? undefined : name);
    const evaluated = evaluateRulesetSheetLive(definition, build, live?.[normalizeCharacterLookupName(name)], held);
    return resolveRulesetValueRef(definition, build, only.value, evaluated) >= only.atLeast;
  };
  const at = place?.size ? (rulesetMarketPlace(market, place.size) ?? null) : null;
  const layerOptions = gameRulesetLayerOptions(resolved);
  return () => rulesetMarketQuoter(definition, book, at, meets, layerOptions, day);
}

/**
 * The market of a game with no ruleset, from its setting kit's money and shop (worldgen W6b): the same
 * quoter at the place in force, with no seller to ask anything of the buyer. Undefined when the kit
 * has no market.
 */
export function loadGameKitMarket(
  kitItems: WorldKitItems,
  book: RulesetItemBook,
  place: GamePlace | null,
): GameInventoryMarket | undefined {
  const market = kitItems.definition.items?.market;
  if (!market) return undefined;
  const at = place?.size ? (rulesetMarketPlace(market, place.size) ?? null) : null;
  return rulesetMarketQuoter(kitItems.definition, book, at, () => true);
}
