// ──────────────────────────────────────────────
// A world's story script (worldgen W10): the flags, standing directions, events and cutscenes a creator
// writes for a world, played by the Engine. No code: data the Engine checks against the world it names
// and walks, as it does a kit. What the story did is folded from the replies, as the world's ledger is,
// so a swipe or regeneration takes back what its reply tripped.
// ──────────────────────────────────────────────
import { z } from "zod";
import { promptSafeText } from "../../schemas/ruleset.schema.js";
import type { GameWorld } from "./game-world.js";
import { WORLD_DEED_KINDS, type WorldDeed, type WorldLedgerEntry } from "./ledger.js";
import { worldPlaceNamed } from "./edits.js";
import { worldCast, type WorldPerson } from "./people.js";

export const STORY_VERSION = 1;
export const STORY_MAX = Object.freeze({
  flags: 64,
  directions: 64,
  events: 128,
  cutscenes: 64,
  actions: 32,
  conditions: 8,
  pages: 40,
  beats: 20,
});
/** The expressions a cutscene's speaker can wear: the Game Master's own list. */
export const STORY_EXPRESSIONS = Object.freeze([
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "scared",
  "disgusted",
  "thinking",
  "laughing",
  "crying",
  "blushing",
  "smirk",
  "embarrassed",
  "determined",
  "confused",
  "sleepy",
] as const);
/** A cutscene page spoken by the game's player. */
export const STORY_PLAYER = "player";
/** What a fight can end in, as the combat recap says it. */
export const STORY_FIGHT_OUTCOMES = Object.freeze(["victory", "defeat", "flee"] as const);

const id = z.string().regex(/^[a-z0-9_-]{1,40}$/, "An id is 1 to 40 lowercase letters, digits, _ or -");
/** A name written into a tag (a group, a background): one line, no brackets or quotes. */
const tagWord = (max: number) =>
  promptSafeText(max).refine((value) => !value.includes('"'), "Text cannot contain double quotes");
const value = z.union([z.boolean(), z.number().finite()]);
const conditions = z
  .array(z.object({ flag: id, is: z.enum(["=", "!=", ">", ">=", "<", "<="]), value }).strict())
  .max(STORY_MAX.conditions)
  .optional();

const trigger = z.discriminatedUnion("on", [
  z.object({ on: z.literal("start") }).strict(),
  z.object({ on: z.literal("arrive"), place: z.string().min(1).max(120) }).strict(),
  z.object({ on: z.literal("meet"), person: z.string().min(1).max(140) }).strict(),
  z.object({ on: z.literal("day"), day: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ on: z.literal("turn"), turn: z.number().int().min(1).max(1_000_000) }).strict(),
  z.object({ on: z.literal("fight"), outcome: z.enum(STORY_FIGHT_OUTCOMES) }).strict(),
  z
    .object({
      on: z.literal("deed"),
      deed: z.enum(Object.keys(WORLD_DEED_KINDS) as [WorldDeed, ...WorldDeed[]]).optional(),
      place: z.string().min(1).max(120).optional(),
    })
    .strict(),
  z.object({ on: z.literal("flags") }).strict(),
  z.object({ on: z.literal("gm") }).strict(),
]);

const worldDeed = z
  .object({
    deed: z.enum(Object.keys(WORLD_DEED_KINDS) as [WorldDeed, ...WorldDeed[]]),
    place: z.string().min(1).max(120).optional(),
    group: tagWord(80).optional(),
    with: tagWord(80).optional(),
    who: tagWord(80).optional(),
  })
  .strict();

const action = z.union([
  z.object({ set: id, value }).strict(),
  z.object({ add: id, amount: z.number().finite() }).strict(),
  z.object({ tell: promptSafeText(600) }).strict(),
  z.object({ cutscene: id }).strict(),
  z.object({ show: id }).strict(),
  z.object({ world: worldDeed }).strict(),
]);

const page = z
  .object({
    /** A person of the world by id, or `player` (the game's player, named at play); none for narration.
     *  A world's story is played with any party, so its party members are not speakers. */
    speaker: z.string().min(1).max(140).optional(),
    expression: z.enum(STORY_EXPRESSIONS).optional(),
    text: promptSafeText(600),
  })
  .strict();

export const storyScriptSchema = z
  .object({
    storyVersion: z.literal(STORY_VERSION),
    flags: z
      .array(
        z
          .object({
            id,
            kind: z.enum(["bool", "number"]),
            initial: value,
            /** The Game Master may set it with a story tag. */
            gm: z.literal(true).optional(),
            note: promptSafeText(200).optional(),
            /** A quest objective in the journal: open until the flag is true (or at its goal). */
            quest: z
              .object({
                title: promptSafeText(80),
                text: promptSafeText(300),
                goal: z.number().int().min(1).max(1_000_000).optional(),
                /** Kept out of the journal until an event shows it. */
                hidden: z.literal(true).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(STORY_MAX.flags)
      .default([]),
    directions: z
      .array(z.object({ id, text: promptSafeText(600), if: conditions }).strict())
      .max(STORY_MAX.directions)
      .default([]),
    events: z
      .array(
        z
          .object({
            id,
            when: trigger,
            if: conditions,
            repeat: z.literal(true).optional(),
            /** The Game Master may trip it with a story tag. */
            gm: z.literal(true).optional(),
            note: promptSafeText(200).optional(),
            do: z.array(action).min(1).max(STORY_MAX.actions),
          })
          .strict(),
      )
      .max(STORY_MAX.events)
      .default([]),
    cutscenes: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              id,
              kind: z.literal("pages"),
              /** A background as a Game Master's [bg:] names one: installed, or generated. */
              background: z
                .string()
                .max(120)
                .regex(/^backgrounds:[a-z0-9:_-]+$/i, "A background is a backgrounds: tag")
                .optional(),
              pages: z.array(page).min(1).max(STORY_MAX.pages),
            })
            .strict(),
          z
            .object({
              id,
              kind: z.literal("beats"),
              beats: z.array(promptSafeText(600)).min(1).max(STORY_MAX.beats),
            })
            .strict(),
        ]),
      )
      .max(STORY_MAX.cutscenes)
      .default([]),
  })
  .strict();
export type StoryScript = z.infer<typeof storyScriptSchema>;
export type StoryScriptInput = z.input<typeof storyScriptSchema>;
export type StoryEvent = StoryScript["events"][number];
export type StoryFlag = StoryScript["flags"][number];
export type StoryAction = StoryEvent["do"][number];
export type StoryCutscene = StoryScript["cutscenes"][number];

/** A person of the world by their id (`<place id>-<n>`, or `-e<n>` for one added by hand). */
export function storyPerson(game: GameWorld, personId: string): WorldPerson | undefined {
  const match = /^(.+)-e?\d+$/.exec(personId);
  return match ? worldCast(game, match[1]!).find((person) => person.id === personId) : undefined;
}

const NEEDS_GROUP: readonly WorldDeed[] = [
  "help",
  "hinder",
  "befriend",
  "set_against",
  "ally",
  "betray",
  "take",
  "destroy",
  "crown",
];
const NEEDS_PLACE: readonly WorldDeed[] = ["improve", "damage", "take", "fall"];

/**
 * A story script, checked against the world it is for: every flag, cutscene, place, person and group
 * it names is there, its values fit their flags, and only what it declares the Game Master's is.
 * Strict, as a kit is: a script that does not fit is refused whole, with the reasons.
 */
export function checkStoryScript(
  game: GameWorld,
  input: unknown,
): { ok: true; story: StoryScript } | { ok: false; issues: string[] } {
  const parsed = storyScriptSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "story"}: ${issue.message}`),
    };
  }
  const story = parsed.data;
  const issues: string[] = [];
  const unique = (list: Array<{ id: string }>, what: string) => {
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item.id)) issues.push(`Two ${what} are called "${item.id}".`);
      seen.add(item.id);
    }
  };
  unique(story.flags, "flags");
  unique(story.directions, "directions");
  unique(story.events, "events");
  unique(story.cutscenes, "cutscenes");

  const flags = new Map(story.flags.map((flag) => [flag.id, flag]));
  const cutscenes = new Set(story.cutscenes.map((cutscene) => cutscene.id));
  const places = new Set(game.world.places.map((place) => place.id));
  const groups = new Set(game.brief.groups.map((group) => group.name.toLowerCase()));
  const fits = (flag: StoryFlag, given: boolean | number) =>
    flag.kind === "bool" ? typeof given === "boolean" : typeof given === "number";
  const flagOf = (flagId: string, where: string) => {
    const flag = flags.get(flagId);
    if (!flag) issues.push(`${where}: no flag "${flagId}".`);
    return flag;
  };
  const checkConditions = (list: StoryEvent["if"], where: string) => {
    for (const condition of list ?? []) {
      const flag = flagOf(condition.flag, where);
      if (!flag) continue;
      if (!fits(flag, condition.value)) issues.push(`${where}: "${flag.id}" is a ${flag.kind} flag.`);
      if (flag.kind === "bool" && condition.is !== "=" && condition.is !== "!=") {
        issues.push(`${where}: a yes-or-no flag is only = or !=.`);
      }
    }
  };
  const placeOk = (placeId: string, where: string) => {
    if (!places.has(placeId)) issues.push(`${where}: no place "${placeId}" in this world.`);
  };
  const personOk = (personId: string, where: string) => {
    const person = storyPerson(game, personId);
    if (!person) issues.push(`${where}: no person "${personId}" in this world.`);
    else if (!person.named) issues.push(`${where}: "${personId}" has no name the story can know them by.`);
  };
  const groupOk = (name: string | undefined, where: string) => {
    if (name !== undefined && !groups.has(name.toLowerCase())) issues.push(`${where}: no group "${name}".`);
  };

  for (const flag of story.flags) {
    const where = `Flag "${flag.id}"`;
    if (!fits(flag, flag.initial)) issues.push(`${where}: its first value is not a ${flag.kind}.`);
    if (flag.quest?.goal !== undefined && flag.kind !== "number") issues.push(`${where}: only a number has a goal.`);
  }
  for (const direction of story.directions) checkConditions(direction.if, `Direction "${direction.id}"`);
  for (const event of story.events) {
    const where = `Event "${event.id}"`;
    checkConditions(event.if, where);
    const when = event.when;
    if (when.on === "gm" && !event.gm) issues.push(`${where}: only the Game Master trips it, so it must be its.`);
    if (when.on === "arrive") placeOk(when.place, where);
    if (when.on === "meet") personOk(when.person, where);
    if (when.on === "deed" && when.place) placeOk(when.place, where);
    for (const action of event.do) {
      if ("set" in action) {
        const flag = flagOf(action.set, where);
        if (flag && !fits(flag, action.value)) issues.push(`${where}: "${flag.id}" is a ${flag.kind} flag.`);
      } else if ("add" in action) {
        const flag = flagOf(action.add, where);
        if (flag && flag.kind !== "number") issues.push(`${where}: only a number flag is added to.`);
      } else if ("show" in action) {
        const flag = flagOf(action.show, where);
        if (flag && !flag.quest) issues.push(`${where}: "${flag.id}" is not a quest objective to show.`);
      } else if ("cutscene" in action) {
        if (!cutscenes.has(action.cutscene)) issues.push(`${where}: no cutscene "${action.cutscene}".`);
      } else if ("world" in action) {
        const deed = action.world;
        if (NEEDS_GROUP.includes(deed.deed) && !deed.group) issues.push(`${where}: ${deed.deed} needs a group.`);
        if (NEEDS_PLACE.includes(deed.deed) && !deed.place) issues.push(`${where}: ${deed.deed} needs a place.`);
        if ((deed.deed === "befriend" || deed.deed === "set_against") && !deed.with) {
          issues.push(`${where}: ${deed.deed} needs the group it is with.`);
        }
        if (deed.deed === "crown" && !deed.who) issues.push(`${where}: crown needs who is crowned.`);
        if (deed.place) placeOk(deed.place, where);
        groupOk(deed.group, where);
        groupOk(deed.with, where);
        // As the world's ledger answers it: a kind of change the kit has off is always refused.
        if (!game.kit.change.kinds[WORLD_DEED_KINDS[deed.deed]].on) {
          issues.push(
            `${where}: this kit has "${WORLD_DEED_KINDS[deed.deed]}" changes off, so ${deed.deed} never happens.`,
          );
        }
        if (deed.with && deed.group && deed.with.toLowerCase() === deed.group.toLowerCase()) {
          issues.push(`${where}: ${deed.deed} needs two different groups.`);
        }
      }
    }
  }
  for (const cutscene of story.cutscenes) {
    if (cutscene.kind !== "pages") continue;
    for (const page of cutscene.pages) {
      if (page.speaker && page.speaker !== STORY_PLAYER) personOk(page.speaker, `Cutscene "${cutscene.id}"`);
    }
  }
  const unique20 = [...new Set(issues)].slice(0, 20);
  return unique20.length ? { ok: false, issues: unique20 } : { ok: true, story };
}

// ── What the story did: folded from the answered [story:] tags of the replies ──

/** One answered story tag: the event it tripped (none for a flag the Game Master set), what it set,
 *  and the objectives it showed. Recorded in the tag, so a script changed later never rewrites it. */
export interface StoryLedgerEntry {
  event?: string;
  /** Tripped by the Engine (on what it saw), not by the Game Master's own tag. */
  by?: "engine";
  set: Array<[string, boolean | number]>;
  show: string[];
}

const STORY_TAG = /\[story:([^\]]*)\]/gi;

function attributes(body: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of body.matchAll(/([a-z]+)\s*=\s*"([^"]*)"/gi)) values.set(match[1]!.toLowerCase(), match[2]!);
  return values;
}

/** A recorded value: `true`/`false` or a number. */
const readValue = (text: string): boolean | number | undefined =>
  text === "true"
    ? true
    : text === "false"
      ? false
      : text.trim() !== "" && Number.isFinite(Number(text))
        ? Number(text)
        : undefined;

/** Every story tag answered ok in these replies, oldest first. */
export function readStoryLedger(replies: readonly string[]): StoryLedgerEntry[] {
  const entries: StoryLedgerEntry[] = [];
  for (const reply of replies) {
    for (const match of reply.matchAll(STORY_TAG)) {
      const values = attributes(match[1] ?? "");
      if (values.get("result") !== "ok") continue;
      const set: Array<[string, boolean | number]> = [];
      for (const pair of (values.get("set") ?? "").split(";")) {
        const [flag, raw] = pair.split("=");
        const read = raw === undefined ? undefined : readValue(raw);
        if (flag && read !== undefined) set.push([flag.trim(), read]);
      }
      const show = (values.get("show") ?? "")
        .split(";")
        .map((each) => each.trim())
        .filter(Boolean);
      const event = values.get("event")?.trim();
      entries.push({
        ...(event ? { event } : {}),
        ...(values.get("by") === "engine" ? { by: "engine" } : {}),
        set,
        show,
      });
    }
  }
  return entries;
}

export interface StoryState {
  flags: Record<string, boolean | number>;
  /** How many times each event has tripped. */
  fired: Record<string, number>;
  /** The hidden objectives shown so far. */
  shown: string[];
}

/** The story as its ledger left it: each flag's value (a recorded value the script no longer fits is
 *  skipped), the events tripped and the objectives shown. */
export function storyState(story: StoryScript, ledger: readonly StoryLedgerEntry[]): StoryState {
  const kinds = new Map(story.flags.map((flag) => [flag.id, flag.kind]));
  const flags: StoryState["flags"] = Object.fromEntries(story.flags.map((flag) => [flag.id, flag.initial]));
  const fired: StoryState["fired"] = {};
  const shown = new Set<string>();
  for (const entry of ledger) {
    if (entry.event) fired[entry.event] = (fired[entry.event] ?? 0) + 1;
    for (const [flag, given] of entry.set) {
      const kind = kinds.get(flag);
      if (kind && (kind === "bool" ? typeof given === "boolean" : typeof given === "number")) flags[flag] = given;
    }
    for (const flag of entry.show) if (kinds.has(flag)) shown.add(flag);
  }
  return { flags, fired, shown: [...shown] };
}

/** A quest objective the story shows the player (worldgen W10): open until its flag is true, or its
 *  number reaches the goal. */
export interface StoryObjective {
  flag: string;
  title: string;
  text: string;
  done: boolean;
  /** A number objective with a goal: how far along it is. */
  progress?: { at: number; goal: number };
}

/** The objectives the player can see: every quest flag, but a hidden one only once the story shows it. */
export function storyObjectives(story: StoryScript, state: StoryState): StoryObjective[] {
  return story.flags.flatMap((flag) => {
    if (!flag.quest || (flag.quest.hidden && !state.shown.includes(flag.id))) return [];
    const value = state.flags[flag.id];
    const goal = flag.kind === "number" ? (flag.quest.goal ?? 1) : undefined;
    const at = Number(value) || 0;
    return [
      {
        flag: flag.id,
        title: flag.quest.title,
        text: flag.quest.text,
        done: goal === undefined ? value === true : at >= goal,
        ...(goal !== undefined && flag.quest.goal !== undefined ? { progress: { at: Math.min(at, goal), goal } } : {}),
      },
    ];
  });
}

/** Whether every condition holds for these flag values. */
export function storyConditionsHold(list: StoryEvent["if"], flags: StoryState["flags"]): boolean {
  return (list ?? []).every(({ flag, is, value: wanted }) => {
    const current = flags[flag];
    if (current === undefined) return false;
    switch (is) {
      case "=":
        return current === wanted;
      case "!=":
        return current !== wanted;
      case ">":
        return Number(current) > Number(wanted);
      case ">=":
        return Number(current) >= Number(wanted);
      case "<":
        return Number(current) < Number(wanted);
      case "<=":
        return Number(current) <= Number(wanted);
    }
  });
}

/** The story a game keeps (`gameStory`), checked against its world, or null: one that no longer fits
 *  its world is not played at all. */
export function gameStoryFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  game: GameWorld | null,
): StoryScript | null {
  if (!game || !metadata || metadata.gameStory == null) return null;
  const checked = checkStoryScript(game, metadata.gameStory);
  return checked.ok ? checked.story : null;
}

// ── Playing a story (worldgen W10b): one evaluation a turn, before the Game Master's reply ──

/** What a fight ended in, read off the combat recap the player's message carries. */
export function storyFightOutcome(playerMessage: string | null | undefined): StoryFightOutcome | null {
  if (!playerMessage || !/\[combat_result\]/i.test(playerMessage)) return null;
  const outcome = /^OUTCOME:\s*(VICTORY|DEFEAT|FLEE)\b/im.exec(playerMessage)?.[1]?.toLowerCase();
  return (STORY_FIGHT_OUTCOMES as readonly string[]).includes(outcome ?? "") ? (outcome as StoryFightOutcome) : null;
}
export type StoryFightOutcome = (typeof STORY_FIGHT_OUTCOMES)[number];

/** The world as a story turn reads it. */
export interface StoryTurnWorld {
  game: GameWorld;
  /** The Game Master's replies before this one in the whole game (earlier sessions carried in first). */
  replies: readonly string[];
  /** How many there were (a session's carry counts the replies it stands for). */
  repliesBefore: number;
  /** The latest of them in this session, whose Game Master story tags are delivered this turn. */
  latest: string | null;
  /** The world's ledger as this reply finds it, the walk and visit told this turn included (their place
   *  tags go before the reply), so an arrival they bring is in it. */
  ledger: readonly WorldLedgerEntry[];
  /** The world's day as this reply finds it. */
  day: number;
  /** What this turn's player message says a fight ended in. */
  fight: StoryFightOutcome | null;
  /** The player's name, for a page the player speaks. */
  playerName?: string;
}

export interface StoryTurn {
  /** The events this turn trips, in order. */
  tripped: string[];
  /** Put before the reply: the trips' answered tags, the scenes shown as written, the world deeds. */
  prepend: string;
  /** The scenes shown as written, as the player sees them: told to the Game Master to follow on. */
  shown: string[];
  /** What the story asks of the Game Master this turn. */
  tells: string[];
  /** Scenes for the Game Master to narrate this turn, each a list of beats. */
  beats: string[][];
  /** The story after this turn's trips: what the Game Master is told of its flags and directions. */
  state: StoryState;
}

const STORY_TRIPS_A_TURN = 32;
const recordValue = (value: boolean | number) => String(value);

/** The tag a trip is recorded in: what it set and showed, so the fold never replays the script. */
function storyRecord(
  entry: { event?: string; flag?: string; set: Array<[string, boolean | number]>; show: string[] },
  by?: "engine",
) {
  const parts = [
    ...(entry.event ? [`event="${entry.event}"`] : []),
    ...(entry.flag ? [`flag="${entry.flag}"`] : []),
    ...(entry.set.length
      ? [`set="${entry.set.map(([flag, value]) => `${flag}=${recordValue(value)}`).join(";")}"`]
      : []),
    ...(entry.show.length ? [`show="${entry.show.join(";")}"`] : []),
    ...(by ? [`by="${by}"`] : []),
    `result="ok"`,
  ];
  return `[story: ${parts.join(" ")}]`;
}

/** An event's flag changes and reveals against these flag values (applied to them). */
function applyActions(story: StoryScript, event: StoryEvent, flags: StoryState["flags"]) {
  const kinds = new Map(story.flags.map((flag) => [flag.id, flag.kind]));
  const set: Array<[string, boolean | number]> = [];
  const show: string[] = [];
  for (const action of event.do) {
    if ("set" in action) {
      flags[action.set] = action.value;
      set.push([action.set, action.value]);
    } else if ("add" in action && kinds.get(action.add) === "number") {
      const next = Number(flags[action.add] ?? 0) + action.amount;
      flags[action.add] = next;
      set.push([action.add, next]);
    } else if ("show" in action) {
      show.push(action.show);
    }
  }
  return { set, show };
}

/** A place, or a place inside it. */
function isInside(game: GameWorld, placeId: string | null, target: string): boolean {
  const byId = new Map(game.world.places.map((place) => [place.id, place]));
  for (let at = placeId ? byId.get(placeId) : undefined, hops = 0; at && hops < 64; hops++) {
    if (at.id === target) return true;
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return false;
}

/** How many times the story has seen the party come into a place: starting there, then each answered
 *  place tag that moves it in from elsewhere. Only what the replies record counts, so a swipe takes an
 *  arrival back with its reply. */
function arrivals(world: StoryTurnWorld, target: string): number {
  let wasInside = isInside(world.game, world.game.world.startId ?? null, target);
  let count = wasInside ? 1 : 0;
  const named = (name: string) => worldPlaceNamed(world.game.world.places, name)?.id ?? null;
  for (const entry of world.ledger) {
    if (entry.at === undefined) continue;
    const inside = isInside(world.game, named(entry.at), target);
    if (inside && !wasInside) count++;
    wasInside = inside;
  }
  return count;
}

/** How many of the Game Master's replies have named a person in full. */
function namings(world: StoryTurnWorld, personId: string): number {
  const person = storyPerson(world.game, personId);
  if (!person?.named) return 0;
  const escaped = person.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu");
  return world.replies.filter((reply) => matcher.test(reply)).length;
}

/** Deeds of a kind (and at a place), as the world's ledger recorded them. */
function deeds(world: StoryTurnWorld, deed: string | undefined, placeId: string | undefined): number {
  const place = placeId ? world.game.world.places.find((each) => each.id === placeId) : undefined;
  return world.ledger.filter(
    (entry) =>
      entry.deed !== undefined &&
      (!deed || entry.deed === deed) &&
      (!placeId || (place !== undefined && entry.place?.toLowerCase() === place.name.toLowerCase())),
  ).length;
}

/** A scene shown as written, in the narration's own grammar: narration lines as they are, a person's
 *  words as their line with their expression. Names are the world's, never the script's, and keep no
 *  brackets. */
function storyPages(
  game: GameWorld,
  cutscene: Extract<StoryCutscene, { kind: "pages" }>,
  playerName: string | undefined,
): string {
  const lines = cutscene.background ? [`[bg: ${cutscene.background}]`] : [];
  for (const page of cutscene.pages) {
    const speaker =
      page.speaker === STORY_PLAYER
        ? playerName?.trim()
        : page.speaker
          ? storyPerson(game, page.speaker)?.name
          : undefined;
    const name = speaker?.replace(/[[\]":]/g, "").trim();
    if (!name) {
      lines.push(page.text);
      continue;
    }
    lines.push(`[${name}] [main] [${page.expression ?? "neutral"}]: "${page.text.replace(/"/g, "'")}"`);
  }
  return lines.join("\n\n");
}

/** A world deed an event does, as a world tag for the world's ledger to answer like the Game Master's. */
function storyWorldTag(game: GameWorld, deed: Extract<StoryAction, { world: unknown }>["world"]): string {
  const place = deed.place ? game.world.places.find((each) => each.id === deed.place)?.name : undefined;
  const parts = [
    `deed="${deed.deed}"`,
    ...(deed.group ? [`group="${deed.group}"`] : []),
    ...(deed.with ? [`with="${deed.with}"`] : []),
    ...(place ? [`place="${place.replace(/["[\]]/g, "")}"`] : []),
    ...(deed.who ? [`who="${deed.who}"`] : []),
  ];
  return `[world: ${parts.join(" ")}]`;
}

/**
 * This turn of a story: what the Game Master tripped in the latest reply is delivered (its scenes and
 * what it asks), then the events the Engine sees happen trip, in the script's order, each once unless
 * it repeats, at most once a turn, 32 at most. Deterministic: a regeneration of the same reply finds the
 * same turn.
 */
export function storyTurn(story: StoryScript, world: StoryTurnWorld): StoryTurn {
  const ledger = readStoryLedger(world.replies);
  const state = storyState(story, ledger);
  const flags = { ...state.flags };
  const fired = { ...state.fired };
  const shownFlags = new Set(state.shown);
  const events = new Map(story.events.map((event) => [event.id, event]));
  const cutscenes = new Map(story.cutscenes.map((cutscene) => [cutscene.id, cutscene]));
  const prepend: string[] = [];
  const shown: string[] = [];
  const tells: string[] = [];
  const beats: string[][] = [];
  const tripped: string[] = [];

  const deliver = (event: StoryEvent, withDeeds: boolean) => {
    for (const action of event.do) {
      if ("tell" in action) tells.push(action.tell);
      else if ("cutscene" in action) {
        const cutscene = cutscenes.get(action.cutscene);
        if (cutscene?.kind === "pages") {
          const pages = storyPages(world.game, cutscene, world.playerName);
          prepend.push(pages);
          shown.push(pages);
        } else if (cutscene?.kind === "beats") beats.push([...cutscene.beats]);
      } else if ("world" in action && withDeeds) prepend.push(storyWorldTag(world.game, action.world));
    }
  };

  // What the Game Master tripped last reply: its scenes and asks arrive now (its deeds went with it).
  for (const entry of world.latest ? readStoryLedger([world.latest]) : []) {
    const event = entry.event ? events.get(entry.event) : undefined;
    if (event && entry.by !== "engine") deliver(event, false);
  }

  const turnNumber = world.repliesBefore + 1;
  const matches = (event: StoryEvent): boolean => {
    const times = fired[event.id] ?? 0;
    const when = event.when;
    switch (when.on) {
      case "start":
        return world.repliesBefore === 0 && times === 0;
      case "turn":
        return turnNumber >= when.turn && times === 0;
      case "day":
        return world.day >= when.day && times === 0;
      case "arrive":
        return arrivals(world, when.place) > (event.repeat ? times : 0) && (event.repeat || times === 0);
      case "meet":
        return namings(world, when.person) > (event.repeat ? times : 0) && (event.repeat || times === 0);
      case "deed":
        return deeds(world, when.deed, when.place) > (event.repeat ? times : 0) && (event.repeat || times === 0);
      case "fight":
        return world.fight === when.outcome && (event.repeat || times === 0);
      case "flags":
        return event.repeat || times === 0;
      case "gm":
        return false;
    }
  };

  const thisTurn = new Set<string>();
  for (let pass = 0; pass < STORY_TRIPS_A_TURN && tripped.length < STORY_TRIPS_A_TURN; pass++) {
    const next = story.events.find(
      (event) => !thisTurn.has(event.id) && storyConditionsHold(event.if, flags) && matches(event),
    );
    if (!next) break;
    thisTurn.add(next.id);
    tripped.push(next.id);
    fired[next.id] = (fired[next.id] ?? 0) + 1;
    const record = applyActions(story, next, flags);
    for (const flag of record.show) shownFlags.add(flag);
    prepend.push(storyRecord({ event: next.id, ...record }, "engine"));
    deliver(next, true);
  }

  return {
    tripped,
    prepend: prepend.length ? `${prepend.join("\n\n")}\n\n` : "",
    shown,
    tells,
    beats,
    state: { flags, fired, shown: [...shownFlags] },
  };
}

/**
 * The Game Master's own story tags in a reply, answered in place against the story as this turn left
 * it: an event the script made its own, its conditions met, not yet tripped unless it repeats; a flag
 * the script made its own, set or added to with a value of its kind. Anything else is refused with the
 * reason, as world tags are. A trip's world deeds go in right after its tag, for the world's ledger to
 * answer; its scenes and asks come at the start of the next reply.
 */
export function applyStoryTags(content: string, story: StoryScript, game: GameWorld, before: StoryState): string {
  const flags = { ...before.flags };
  const fired = { ...before.fired };
  const events = new Map(story.events.map((event) => [event.id, event]));
  const declared = new Map(story.flags.map((flag) => [flag.id, flag]));
  return content.replace(STORY_TAG, (_whole, body: string) => {
    const values = attributes(body);
    const eventId = values.get("event")?.trim();
    const flagId = values.get("flag")?.trim();
    const refuse = (reason: string) =>
      `[story: ${eventId ? `event="${eventId.replace(/["[\]]/g, "")}"` : `flag="${(flagId ?? "").replace(/["[\]]/g, "")}"`} result="refused" reason="${reason}"]`;
    if (eventId) {
      const event = events.get(eventId);
      if (!event) return refuse("unknown-event");
      if (!event.gm) return refuse("not-yours");
      if (!event.repeat && (fired[event.id] ?? 0) > 0) return refuse("done");
      if (!storyConditionsHold(event.if, flags)) return refuse("conditions");
      fired[event.id] = (fired[event.id] ?? 0) + 1;
      const record = applyActions(story, event, flags);
      const deeds = event.do.flatMap((action) => ("world" in action ? [storyWorldTag(game, action.world)] : []));
      return [storyRecord({ event: event.id, ...record }), ...deeds].join("");
    }
    if (flagId) {
      const flag = declared.get(flagId);
      if (!flag) return refuse("unknown-flag");
      if (!flag.gm) return refuse("not-yours");
      const raw = values.get("value");
      const add = values.get("add");
      let next: boolean | number | undefined;
      if (add !== undefined) {
        const amount = Number(add);
        next =
          flag.kind === "number" && add.trim() !== "" && Number.isFinite(amount)
            ? Number(flags[flag.id] ?? 0) + amount
            : undefined;
      } else if (raw !== undefined) {
        const read =
          flag.kind === "bool" ? (raw === "true" ? true : raw === "false" ? false : undefined) : readValue(raw);
        next = typeof read === (flag.kind === "bool" ? "boolean" : "number") ? read : undefined;
      }
      if (next === undefined) return refuse("unreadable");
      flags[flag.id] = next;
      return storyRecord({ flag: flag.id, set: [[flag.id, next]], show: [] });
    }
    return refuse("unreadable");
  });
}

/** The story as the Game Master is told it once, with the world: how to write its tags, and what of the
 *  script is its own. Nothing else of the script (its scenes and the Engine's events stay unknown until
 *  they happen). Empty when the script gives the Game Master nothing. */
export function storyScriptPromptText(story: StoryScript): string {
  const events = story.events.filter((event) => event.gm);
  const flags = story.flags.filter((flag) => flag.gm);
  if (!events.length && !flags.length) return "";
  return [
    "This world has a story script. When the story reaches one of these moments, mark it with a story tag; the Engine answers it in place, and refuses anything else.",
    ...(events.length
      ? [
          'Moments you may trip, with [story: event="<id>"]:',
          ...events.map((event) => `- ${event.id}${event.note ? `: ${event.note}` : ""}`),
        ]
      : []),
    ...(flags.length
      ? [
          'Story values you may set, with [story: flag="<id>" value="<value>"] (or add="<number>" for a number):',
          ...flags.map(
            (flag) =>
              `- ${flag.id} (${flag.kind === "bool" ? "true or false" : "a number"})${flag.note ? `: ${flag.note}` : ""}`,
          ),
        ]
      : []),
  ].join("\n");
}

/** What the story says to the Game Master this turn: its values (hidden from the player), the standing
 *  directions in force, what it asks now, the scene just shown, and any scene to narrate now. */
export function storyTurnPromptText(story: StoryScript, turn: StoryTurn): string {
  const lines: string[] = [];
  const values = story.flags.map((flag) => {
    const value = turn.state.flags[flag.id];
    return `${flag.id} = ${typeof value === "boolean" ? (value ? "yes" : "no") : value}`;
  });
  if (values.length) lines.push(`Story values (the player never sees these): ${values.join(", ")}.`);
  const directions = story.directions.filter((direction) => storyConditionsHold(direction.if, turn.state.flags));
  if (directions.length)
    lines.push("Keep to these while they hold:", ...directions.map((direction) => `- ${direction.text}`));
  if (turn.shown.length) {
    lines.push(
      "Just before your reply, the player was shown this scene as written. Carry on from it; do not repeat it:",
      ...turn.shown,
    );
  }
  for (const scene of turn.beats) {
    lines.push("Narrate this scene now, in your own words, beat by beat:", ...scene.map((beat) => `- ${beat}`));
  }
  if (turn.tells.length) lines.push("The story asks this of you now:", ...turn.tells.map((tell) => `- ${tell}`));
  return lines.join("\n");
}
