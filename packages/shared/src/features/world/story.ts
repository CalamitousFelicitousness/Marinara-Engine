// ──────────────────────────────────────────────
// A world's story script (worldgen W10): the flags, standing directions, events and cutscenes a creator
// writes for a world, played by the Engine. No code: data the Engine checks against the world it names
// and walks, as it does a kit. What the story did is folded from the replies, as the world's ledger is,
// so a swipe or regeneration takes back what its reply tripped.
// ──────────────────────────────────────────────
import { z } from "zod";
import { promptSafeText } from "../../schemas/ruleset.schema.js";
import type { GameWorld } from "./game-world.js";
import { WORLD_DEED_KINDS, type WorldDeed } from "./ledger.js";
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
          issues.push(`${where}: this kit has "${WORLD_DEED_KINDS[deed.deed]}" changes off, so ${deed.deed} never happens.`);
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
      entries.push({ ...(event ? { event } : {}), set, show });
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
