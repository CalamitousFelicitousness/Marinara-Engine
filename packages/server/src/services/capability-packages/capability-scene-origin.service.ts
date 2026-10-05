// ──────────────────────────────────────────────
// Capability scene-origin registry — gives the `scenes` permission its mechanism.
//
// A scene usually branches from a Conversation. A package may register one provider so its own threads
// (a direct-message thread, for example) can be a scene origin too: the provider supplies the planning
// context, holds the lock while the scene runs and receives the outcome. Contract: `SceneOriginProvider`.
// ──────────────────────────────────────────────
import type { SceneOriginEnd, SceneOriginProvider, ScenePackageOrigin } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";

const providersByPackage = new Map<string, SceneOriginProvider>();

/** Register (or replace) a package's scene-origin provider. Returns a releaser for deactivation. */
export function registerCapabilitySceneOrigin(packageId: string, provider: SceneOriginProvider): () => void {
  if (
    !provider ||
    typeof provider.getContext !== "function" ||
    (provider.claim !== undefined && typeof provider.claim !== "function") ||
    (provider.release !== undefined && typeof provider.release !== "function")
  ) {
    throw new Error("Capability scene-origin provider is invalid");
  }
  providersByPackage.set(packageId, provider);
  return () => {
    if (providersByPackage.get(packageId) === provider) providersByPackage.delete(packageId);
  };
}

/** The active provider for a package, or null when the package is not installed, enabled and registered. */
export function getCapabilitySceneOrigin(packageId: string): SceneOriginProvider | null {
  return providersByPackage.get(packageId) ?? null;
}

/** Accept `{ packageId, originId }` from a request body or chat metadata; anything else is no origin. */
export function parseScenePackageOrigin(value: unknown): ScenePackageOrigin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { packageId, originId } = value as Record<string, unknown>;
  if (typeof packageId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packageId) || packageId.length > 80)
    return null;
  if (typeof originId !== "string" || !originId.trim() || originId.length > 200) return null;
  return { packageId, originId };
}

/**
 * Tell a package origin how its scene ended. The scene's own state is already settled, so a provider
 * that is gone or fails is logged and skipped: the package reconciles when it next reads its lock.
 */
export async function releaseScenePackageOrigin(origin: ScenePackageOrigin, end: SceneOriginEnd): Promise<void> {
  const provider = getCapabilitySceneOrigin(origin.packageId);
  // A package that only starts scenes asked for no outcome.
  if (provider && !provider.release) return;
  if (!provider) {
    logger.warn({ ...origin, sceneChatId: end.sceneChatId }, "[scene] Package origin is not active; release skipped");
    return;
  }
  try {
    await provider.release!(origin.originId, end);
  } catch (error) {
    logger.warn({ err: error, ...origin, sceneChatId: end.sceneChatId }, "[scene] Package origin release failed");
  }
}
