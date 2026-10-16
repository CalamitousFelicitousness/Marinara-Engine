import assert from "node:assert/strict";
import { sanitizeProfileTableRows } from "../../packages/server/src/routes/backup.routes.js";

// A profile export keeps the Narrative Director's Secret Plot settings (#7657) but never an agent's credentials.
const secretValues = ["sk-secret-plot-key", "sk-agent-key", "spotify-access-token"];
const settings = {
  secretPlotEnabled: true,
  secretPlotRunInterval: 5,
  secretPlotPromptTemplate: "Plan a slow-burn arc driven by the characters.",
  secretPlotApiKey: secretValues[0],
  apiKey: secretValues[1],
  spotify: { spotifyAccessToken: secretValues[2] },
};

// Stored rows hold settings as JSON text; an already-parsed object must be handled the same way.
for (const storedSettings of [JSON.stringify(settings), settings]) {
  const [exported] = sanitizeProfileTableRows("agent_configs", [
    { id: "narrative-director-fixture", type: "director", settings: storedSettings },
  ]);
  assert.ok(exported, "the agent row is exported");
  const exportedSettings = (
    typeof exported.settings === "string" ? JSON.parse(exported.settings) : exported.settings
  ) as Record<string, any>;

  assert.equal(exportedSettings.secretPlotEnabled, true);
  assert.equal(exportedSettings.secretPlotRunInterval, 5);
  assert.equal(exportedSettings.secretPlotPromptTemplate, settings.secretPlotPromptTemplate);
  assert.equal(exportedSettings.secretPlotApiKey, null);
  assert.equal(exportedSettings.apiKey, null);
  assert.equal(exportedSettings.spotify?.spotifyAccessToken, null);
  for (const secret of secretValues) {
    assert.ok(!JSON.stringify(exported).includes(secret), `the export must not contain ${secret}`);
  }
}

console.info("Profile export keeps the Secret Plot settings and blanks agent credentials.");
