import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRulesetDefinition } from "../../packages/shared/src/index.js";
import { buildGmFormatReminder, buildGmSystemPrompt } from "../../packages/server/src/services/game/gm-prompts.js";
import { OpenAIProvider } from "../../packages/server/src/services/llm/providers/openai.provider.js";
import type { ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";
import {
  parseRollDiceToolResult,
  resolveGameDiceRequests,
} from "../../packages/server/src/services/game/dice.service.js";

// A full playtest with a real Game Master (four SRD characters, no persona) found that rolls never
// said who rolled, that the GM played "you" as one party member, that it narrated a sneak and a
// search as successes with no check, and that a fall and a burn never reached anyone's HP.

type ReminderContext = Parameters<typeof buildGmFormatReminder>[0];
type SystemContext = Parameters<typeof buildGmSystemPrompt>[0];
const party = ["Isolde", "Hessa", "Brannoc", "Pip"];

// ── Who rolled: a [dice:] request names its roller, and the record and the card keep it ──
{
  const fresh = resolveGameDiceRequests('Hessa lays a hand on him. [dice: 1d1+4 who="Hessa"] The wound closes.');
  assert.equal(fresh.rolled, 1);
  assert.deepEqual(fresh.diceRolls, [{ notation: "1d1+4", rolls: [1], modifier: 4, total: 5, label: "Hessa" }]);
  assert.match(fresh.content, /\[dice: 1d1\+4 = 5 \(1 \+ 4\) who="Hessa"\]/, "the record names the roller");
  const reread = resolveGameDiceRequests(fresh.content);
  assert.equal(reread.rolled, 0, "a named record is not a new request");
  assert.deepEqual(reread.unresolved, [], "a named record is not a diagnostic failure");
  // A name cannot close the tag or break the record.
  const hostile = resolveGameDiceRequests('[dice: 1d1 who="Pip]"]');
  assert.equal(hostile.rolled, 0, "an unreadable name leaves the request alone");
  const quoted = resolveGameDiceRequests('[dice: 1d1 who="Pip [the bold]"]');
  assert.equal(quoted.rolled, 0, "the tag ends at the first ], so a bracket inside a name is never read as one");
  const plain = resolveGameDiceRequests("[dice: 1d1]");
  assert.equal(plain.diceRolls[0]?.label, undefined, "a roll that names nobody claims nobody");
  assert.doesNotMatch(plain.content, /who=/);
}

// A tool roll's reason is the card's label.
{
  const rolled = parseRollDiceToolResult(
    JSON.stringify({ notation: "1d8+4", rolls: [5], modifier: 4, total: 9, reason: "Hessa: Cure Wounds" }),
  );
  assert.equal(rolled?.label, "Hessa: Cure Wounds");
  // A continued turn reads its saved rolls back through the same reader: the label survives.
  assert.equal(parseRollDiceToolResult(JSON.stringify(rolled))?.label, "Hessa: Cure Wounds");
  const unnamed = parseRollDiceToolResult(JSON.stringify({ notation: "1d6", rolls: [2], modifier: 0, total: 2 }));
  assert.equal(unnamed?.label, undefined);
}

// ── No persona: the player directs the party, so "you" is never one member ──
{
  const base = {
    hasSceneModel: false,
    turnNumber: 3,
    gameActiveState: "exploration" as const,
    partyNames: party,
    playerName: "User",
  };
  const directed = buildGmFormatReminder({ ...base, playerIsParty: true } as ReminderContext);
  assert.match(directed, /The player has no character of their own: they direct the whole party \(Isolde, Hessa/);
  assert.match(directed, /"You" means the party together, never one member/);
  assert.doesNotMatch(directed, /NEVER quote or speak for the player character \(User\)/);
  assert.doesNotMatch(directed, /\[User\]/, "no example puts words in a player character who does not exist");

  const withPersona = buildGmFormatReminder(base as ReminderContext);
  assert.match(withPersona, /NEVER quote or speak for the player character \(User\)/, "a persona game is unchanged");
  assert.doesNotMatch(withPersona, /no character of their own/);

  const system = (playerIsParty: boolean) =>
    buildGmSystemPrompt({
      gameActiveState: "exploration",
      storyArc: null,
      plotTwists: null,
      map: null,
      npcs: [],
      sessionSummaries: [],
      sessionNumber: 1,
      partyNames: party,
      playerName: "User",
      playerIsParty,
      gmCharacterCard: null,
      difficulty: "normal",
      genre: "fantasy",
      setting: "original",
      tone: "balanced",
      rating: "sfw",
    } as SystemContext);
  assert.match(system(true), /Player: no character of their own\. The player directs the party members below/);
  assert.match(system(false), /Player: User/);

  // A ruleset game checks the player when a check names nobody; with no player that is a blank sheet.
  const gravewatch = parseRulesetDefinition(
    JSON.parse(
      readFileSync(fileURLToPath(new URL("../../docs/examples/rulesets/gravewatch.json", import.meta.url)), "utf8"),
    ),
  );
  assert.ok(gravewatch.ok);
  const rules = buildGmFormatReminder({
    ...base,
    playerIsParty: true,
    ruleset: gravewatch.definition,
    rulesetSheetBlocks: ["Isolde\nHealth 7/7"],
  } as ReminderContext);
  assert.match(rules, /Always add who="Character Name" naming the party member who rolls/);
  assert.doesNotMatch(rules, /without it the player is checked/);
  const rulesWithPersona = buildGmFormatReminder({ ...base, ruleset: gravewatch.definition } as ReminderContext);
  assert.match(rulesWithPersona, /without it the player is checked/);

  // ── Narrated harm reaches the sheet, and no uncertain attempt goes unchecked ──
  assert.match(
    rules,
    /Narration alone changes no sheet\. Every harm, healing or spent resource you narrate needs its command/,
  );
  assert.match(rules, /a fall, a burn or a poison included/);
  for (const reminder of [rules, withPersona]) {
    assert.match(reminder, /Never skip a check the action calls for\./);
    assert.match(reminder, /Name who rolls with who="Name"/);
  }
}

// ── Claude behind an OpenAI-compatible endpoint: unsigned reasoning never goes back ──
// The playtest's 400 came on the tool round after a roll_dice call: the assistant tool-call turn was replayed
// with its thinking as plain reasoning_content and no signature, which the endpoint's Anthropic translation
// refused. Only reasoning carrying its signature is replayed for a Claude model.
{
  const format = (model: string, providerMetadata: Record<string, unknown>) =>
    (
      new OpenAIProvider(
        "https://proxy.example/v1",
        "synthetic",
        undefined,
        undefined,
        undefined,
        "custom",
      ) as unknown as {
        formatMessages(messages: ChatMessage[], model?: string): Array<Record<string, unknown>>;
      }
    ).formatMessages(
      [
        { role: "user", content: "Hessa casts Cure Wounds." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "roll_dice", arguments: "{}" } }],
          providerMetadata,
        },
        { role: "tool", content: "{}", tool_call_id: "call_1" },
      ],
      model,
    )[1]!;
  const toolTurn = format("claude-opus-5-5", { reasoning_content: "I should roll 1d8+4." });
  assert.equal(toolTurn.reasoning_content, undefined, "unsigned Claude thinking is not replayed");
  assert.ok(Array.isArray(toolTurn.tool_calls), "the tool call itself still goes back");
  const signed = { type: "reasoning.text", text: "I should roll.", signature: "sig" };
  assert.deepEqual(
    format("claude-opus-5-5", { reasoning_details: [signed, { type: "reasoning.text", text: "unsigned" }] })
      .reasoning_details,
    [signed],
    "signed Claude thinking still goes back, and only that",
  );
  assert.equal(
    format("deepseek-v4", { reasoning_content: "plan" }).reasoning_content,
    "plan",
    "other models keep replaying their reasoning",
  );
}

console.log(
  "Game Master turns name their rollers, treat a persona-less party as the player, and keep harm on the sheet.",
);
