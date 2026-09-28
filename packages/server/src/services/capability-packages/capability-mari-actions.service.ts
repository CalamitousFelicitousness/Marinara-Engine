import { getCapabilityService, listCapabilityServiceKeys } from "./capability-service-registry.service.js";

const SERVICE_PREFIX = "mari-actions:";
const PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_INPUT_CHARS = 64_000;

/** One action a package lets Professor Mari run. `summary` and `inputs` are what Mari reads. */
export interface CapabilityMariAction {
  name: string;
  summary?: string;
  inputs?: Record<string, string>;
}

export type CapabilityMariActionOutcome = { ok: true; value: unknown } | { ok: false; status?: number; error: string };

/**
 * Registered as `mari-actions:<package-id>` by a package holding the `mari-actions` permission.
 * `run` receives untrusted model input and must validate it against its own schema.
 */
export interface CapabilityMariActionsService {
  list(): readonly CapabilityMariAction[] | Promise<readonly CapabilityMariAction[]>;
  run(name: string, input: Record<string, unknown>): Promise<CapabilityMariActionOutcome>;
}

/** The key encodes the owner, so no package can offer Mari actions in another package's name. */
export function assertCapabilityMariActionsServiceRegistration(
  packageId: string,
  permissions: readonly string[],
  key: string,
): void {
  if (!key.startsWith(SERVICE_PREFIX)) return;
  if (!permissions.includes("mari-actions")) {
    throw new Error(`Capability package ${packageId} must declare the "mari-actions" permission`);
  }
  if (key !== `${SERVICE_PREFIX}${packageId}`) {
    throw new Error(`Capability package ${packageId} cannot register Mari actions for another package`);
  }
}

function serviceFor(packageId: string): CapabilityMariActionsService | null {
  const service = getCapabilityService<CapabilityMariActionsService>(`${SERVICE_PREFIX}${packageId}`);
  return service && typeof service.list === "function" && typeof service.run === "function" ? service : null;
}

async function actionsOf(service: CapabilityMariActionsService): Promise<CapabilityMariAction[]> {
  const listed = await service.list();
  return Array.isArray(listed)
    ? listed.filter(
        (action): action is CapabilityMariAction =>
          !!action && typeof action.name === "string" && ACTION_NAME_PATTERN.test(action.name),
      )
    : [];
}

/** Every active package that offers Mari actions, with the actions it offers. */
export async function listCapabilityMariActions(): Promise<Array<{ package: string; actions: CapabilityMariAction[] }>> {
  const result: Array<{ package: string; actions: CapabilityMariAction[] }> = [];
  for (const key of listCapabilityServiceKeys(SERVICE_PREFIX)) {
    const packageId = key.slice(SERVICE_PREFIX.length);
    const service = serviceFor(packageId);
    if (!service) continue;
    try {
      result.push({
        package: packageId,
        actions: (await actionsOf(service)).map(({ name, summary, inputs }) => ({ name, summary, inputs })),
      });
    } catch {
      // One broken package must not hide the others.
    }
  }
  return result;
}

/** Runs one action of one package. Throws a message Mari can act on for anything it asked wrongly. */
export async function runCapabilityMariAction(packageId: string, action: string, input: unknown): Promise<unknown> {
  if (!PACKAGE_ID_PATTERN.test(packageId)) throw new Error(`"${packageId}" is not a package id`);
  const service = serviceFor(packageId);
  if (!service) {
    throw new Error(
      `Package "${packageId}" offers no Mari actions. Call package_service without a package to list the ones that do.`,
    );
  }
  if (!(await actionsOf(service)).some((entry) => entry.name === action)) {
    throw new Error(
      `Package "${packageId}" has no Mari action "${action}". Call package_service with only package="${packageId}" to list its actions.`,
    );
  }
  const payload = input ?? {};
  if (typeof payload !== "object" || Array.isArray(payload)) throw new Error("input must be a JSON object");
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_INPUT_CHARS) throw new Error(`input is larger than ${MAX_INPUT_CHARS} characters`);
  // A JSON round trip hands the package plain data only: no prototypes, functions or shared references.
  const outcome = await service.run(action, JSON.parse(serialized) as Record<string, unknown>);
  if (!outcome || typeof outcome !== "object" || typeof outcome.ok !== "boolean") {
    throw new Error(`Package "${packageId}" returned an invalid answer for "${action}"`);
  }
  if (!outcome.ok) throw new Error(`${packageId} ${action} failed: ${outcome.error || "no reason given"}`);
  return outcome.value;
}
