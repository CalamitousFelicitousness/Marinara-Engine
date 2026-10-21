import assert from "node:assert/strict";
import { extractLeadingThinkingBlocks } from "../../packages/shared/src/utils/thinking-tags.js";
import { buildGmFormatReminder } from "../../packages/server/src/services/game/gm-prompts.js";

// Game Mode showed the GM's planning as narration. The format reminder told every model to
// "Think step by step" with nowhere to put it, so a model without a native thinking channel
// (or with it switched off) wrote the plan into the reply, where the Engine has no way to tell
// it from the scene. These checks pin that the reminder sends written planning into a leading
// <think> block, which the game turn already lifts into the message's thinking.

type ReminderContext = Parameters<typeof buildGmFormatReminder>[0];

for (const language of [undefined, "English", "Deutsch", "Français", "日本語"]) {
  const reminder = buildGmFormatReminder({ hasSceneModel: false, turnNumber: 1, language } as ReminderContext);
  const label = language ?? "no language";

  assert.doesNotMatch(
    reminder,
    /think step by step/i,
    `${label}: the reminder must not ask for open step-by-step reasoning`,
  );
  assert.match(
    reminder,
    /put all of it inside one <think>\.\.\.<\/think> block at the very start of the reply/,
    `${label}: written planning must be routed into a leading <think> block`,
  );
  assert.match(
    reminder,
    /output only the VN scene text: no notes, analysis, headings or plan/,
    `${label}: the reply after the block must be the scene alone`,
  );
}

const german = buildGmFormatReminder({ hasSceneModel: false, turnNumber: 1, language: "Deutsch" } as ReminderContext);
assert.match(
  german,
  /Write the scene text directly in German as a native speaker would\./,
  "the language line must apply to the scene text, not the planning",
);

// A reply that follows the reminder loses its plan to the thinking slot, whatever language it plans in.
const reply = [
  "<think>",
  "Ort: Hafen von Brem, Abend. Der Spieler hat gerade das Schiff verlassen.",
  "Nächster Schritt: Die Schmugglerin spricht ihn an.",
  "</think>",
  "",
  "Nebel kriecht über die Kaimauer, und die Laternen flackern im Wind.",
  "",
  '[Mira] [main] [smirk]: "Du siehst aus wie jemand, der eine Überfahrt sucht."',
].join("\n");
const extraction = extractLeadingThinkingBlocks(reply);
assert.equal(extraction.stripped, true);
assert.match(extraction.thinking, /Nächster Schritt/);
assert.ok(
  extraction.content.startsWith("Nebel kriecht über die Kaimauer"),
  "the scene must start right after the thinking block",
);
assert.doesNotMatch(extraction.content, /Ort:|Nächster Schritt/, "no planning may reach the narration");

console.log("game-gm-thinking-leak regression passed");
