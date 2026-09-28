// Professor Mari's package_service tool: packages that declare `mari-actions` register
// `mari-actions:<package-id>`, and Mari can list those actions and run one with JSON input.
import assert from "node:assert/strict";
import { capabilityPackageManifestSchema } from "../../packages/shared/src/schemas/capability-package.schema.js";
import {
  assertCapabilityMariActionsServiceRegistration,
  listCapabilityMariActions,
  runCapabilityMariAction,
  type CapabilityMariActionsService,
} from "../../packages/server/src/services/capability-packages/capability-mari-actions.service.js";
import {
  registerCapabilityService,
  resetCapabilityServices,
} from "../../packages/server/src/services/capability-packages/capability-service-registry.service.js";
import {
  auditWorkspaceCompletionClaim,
  isMutatingWorkspaceCommand,
  parseAssistantWorkspaceAction,
  ProfessorMariWorkspaceService,
  resolveWorkspaceMutationVerification,
  workspaceCommandProtocolPrompt,
} from "../../packages/server/src/services/professor-mari/workspace-agent.service.js";

// ── The manifest permission needs capability API 1.50 ───────────────────────
const manifest = (minor: number) => ({
  schemaVersion: 2,
  capabilityApi: { major: 1, minor },
  builtAgainst: { engineVersion: "2.4.6", engineCommit: "a".repeat(40) },
  id: "slurp2",
  name: "Slurp",
  version: "1.0.0",
  engine: { min: "2.3.0", maxExclusive: "3.0.0" },
  kind: ["agent"],
  entrypoints: { server: "server.mjs" },
  files: [{ path: "server.mjs", sha256: "0".repeat(64), bytes: 1 }],
  permissions: ["mari-actions"],
  restartRequired: true,
});
assert.doesNotThrow(() => capabilityPackageManifestSchema.parse(manifest(50)));
assert.throws(() => capabilityPackageManifestSchema.parse(manifest(49)), /mari-actions.{0,2} permission requires/);

// ── Registration: permission required, and only under the package's own id ──
assert.doesNotThrow(() => assertCapabilityMariActionsServiceRegistration("slurp2", [], "slurp2:actions"));
assert.doesNotThrow(() =>
  assertCapabilityMariActionsServiceRegistration("slurp2", ["mari-actions"], "mari-actions:slurp2"),
);
assert.throws(
  () => assertCapabilityMariActionsServiceRegistration("slurp2", [], "mari-actions:slurp2"),
  /must declare the "mari-actions" permission/,
);
assert.throws(
  () => assertCapabilityMariActionsServiceRegistration("evil", ["mari-actions"], "mari-actions:slurp2"),
  /cannot register Mari actions for another package/,
);

// ── Listing and running ─────────────────────────────────────────────────────
resetCapabilityServices();
const received: unknown[] = [];
const slurp: CapabilityMariActionsService = {
  list: () => [
    { name: "add-idea", summary: "Give a Creator an idea.", inputs: { accountId: "The Creator.", text: "The idea." } },
    { name: "draw-picture", summary: "Draw a picture." },
    { name: "bad name with spaces" },
  ],
  run: async (name, input) => {
    received.push(input);
    if (name === "draw-picture") return { ok: true, value: { image: `data:image/png;base64,${"A".repeat(5000)}` } };
    if (input.text === "too many") return { ok: false, status: 409, error: "That is plenty of ideas for now." };
    return { ok: true, value: { steering: { nudges: [input.text] } } };
  },
};
registerCapabilityService("mari-actions:slurp2", slurp);
registerCapabilityService("mari-actions:broken", {
  list: () => {
    throw new Error("boom");
  },
  run: async () => ({ ok: true, value: null }),
});
registerCapabilityService("mari-actions:not-a-service", { hello: true });
registerCapabilityService("slurp2:actions", slurp);

const listed = await listCapabilityMariActions();
assert.deepEqual(
  listed.map((entry) => [entry.package, entry.actions.map((action) => action.name)]),
  [["slurp2", ["add-idea", "draw-picture"]]],
  "only well-formed mari-actions services are listed; a throwing list hides only its own package",
);

const input = { accountId: "creator-1", text: "A rainy-day cafe post" };
assert.deepEqual(await runCapabilityMariAction("slurp2", "add-idea", input), {
  steering: { nudges: ["A rainy-day cafe post"] },
});
assert.deepEqual(received.at(-1), input);
assert.notEqual(received.at(-1), input, "the package receives a plain-data copy, not the caller's object");
await assert.rejects(runCapabilityMariAction("slurp2", "add-idea", { text: "too many" }), /plenty of ideas/);
await assert.rejects(runCapabilityMariAction("slurp2", "delete-everything", {}), /has no Mari action/);
await assert.rejects(runCapabilityMariAction("slurp2", "bad name with spaces", {}), /has no Mari action/);
await assert.rejects(runCapabilityMariAction("other", "add-idea", {}), /offers no Mari actions/);
await assert.rejects(runCapabilityMariAction("../slurp2", "add-idea", {}), /is not a package id/);
await assert.rejects(runCapabilityMariAction("slurp2", "add-idea", ["x"]), /must be a JSON object/);
await assert.rejects(
  runCapabilityMariAction("slurp2", "add-idea", { text: "x".repeat(70_000) }),
  /larger than 64000 characters/,
);
const callsBefore = received.length;
await assert.rejects(runCapabilityMariAction("slurp2", "add-idea", "nope"), /must be a JSON object/);
assert.equal(received.length, callsBefore, "rejected input never reaches the package");

// ── Mari: protocol, permissions classification, JSON and XML fallback ───────
assert.match(workspaceCommandProtocolPrompt(), /package_service/);
const listCall = { id: "1", name: "package_service" as const, arguments: {} };
const runCall = { id: "2", name: "package_service" as const, arguments: { package: "slurp2", action: "add-idea" } };
assert.equal(isMutatingWorkspaceCommand(listCall), false, "listing is read-only");
assert.equal(isMutatingWorkspaceCommand(runCall), true, "running counts as a change for Plan and Manual mode");

const jsonFrame = parseAssistantWorkspaceAction(
  JSON.stringify({
    say: "",
    commands: [{ name: "package_service", arguments: { package: "slurp2", action: "add-idea", input } }],
    stop: false,
  }),
);
assert.equal(jsonFrame.commands[0]?.name, "package_service");
assert.deepEqual(jsonFrame.commands[0]?.arguments, { package: "slurp2", action: "add-idea", input });
const xmlFrame = parseAssistantWorkspaceAction(
  '<package_service>{"package":"slurp2","action":"add-idea","input":{"accountId":"creator-1","text":"x"}}</package_service>',
);
assert.equal(xmlFrame.commands[0]?.name, "package_service");
assert.equal(xmlFrame.commands[0]?.arguments.action, "add-idea");

// A package run cannot be read back by the Engine: success is its own evidence, failure never is.
const runResult = (success: boolean) => ({
  id: "r",
  name: "package_service" as const,
  input: { package: "slurp2", action: "add-idea" },
  output: success ? "slurp2 add-idea succeeded." : "slurp2 add-idea failed: nope",
  success,
});
assert.equal(resolveWorkspaceMutationVerification([runResult(true)]), "verified");
const doneClaim = { commands: [], stop: true, visibleText: "Done, I added the idea." };
assert.equal(auditWorkspaceCompletionClaim(doneClaim, [runResult(true)]).issue, null);
assert.notEqual(auditWorkspaceCompletionClaim(doneClaim, [runResult(false)]).issue, null);

// ── Mari: running the tool end to end ───────────────────────────────────────
const service = new ProfessorMariWorkspaceService({} as never);
const runner = service as unknown as {
  executeWorkspaceCommand(
    command: { id: string; name: "package_service"; arguments: Record<string, unknown> },
    signal: AbortSignal,
    trace: unknown[],
    onEvent: () => void,
  ): Promise<{ output: string; success: boolean }>;
};
const run = (args: Record<string, unknown>) =>
  runner.executeWorkspaceCommand(
    { id: "cmd", name: "package_service", arguments: args },
    new AbortController().signal,
    [],
    () => undefined,
  );

const listResult = await run({});
assert.equal(listResult.success, true);
assert.match(listResult.output, /"package": "slurp2"/);
assert.match(listResult.output, /Give a Creator an idea/);
assert.match((await run({ package: "nothing" })).output, /offers no Mari actions/);

const ideaResult = await run({ package: "slurp2", action: "add-idea", input: JSON.stringify(input) });
assert.equal(ideaResult.success, true, "a JSON-string input from a text-protocol model is accepted");
assert.match(ideaResult.output, /^slurp2 add-idea succeeded\./);
assert.deepEqual(received.at(-1), input);

const pictureResult = await run({ package: "slurp2", action: "draw-picture" });
assert.equal(pictureResult.success, true);
assert.doesNotMatch(pictureResult.output, /AAAAAAAAAA/, "a data URL never reaches Mari's context");
assert.match(pictureResult.output, /<data URL, \d+ characters, omitted>/);

const badInput = await run({ package: "slurp2", action: "add-idea", input: [1, 2] });
assert.equal(badInput.success, false);
assert.match(badInput.output, /package_service input must be a JSON object/);
const missingPackage = await run({ action: "add-idea" });
assert.equal(missingPackage.success, false);
assert.match(missingPackage.output, /requires a non-empty package string/);
const failed = await run({ package: "slurp2", action: "add-idea", input: { text: "too many" } });
assert.equal(failed.success, false);
assert.match(failed.output, /slurp2 add-idea failed: That is plenty of ideas/);

resetCapabilityServices();
console.log("mari-package-service regression passed");
