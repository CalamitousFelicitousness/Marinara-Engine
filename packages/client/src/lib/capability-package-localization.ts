import type { CapabilityPackageManifest } from "@marinara-engine/shared";

function localeCandidates(locale: string | undefined) {
  const normalized = locale?.trim().replace(/_/g, "-").toLowerCase();
  if (!normalized) return [];
  const language = normalized.split("-")[0];
  return language && language !== normalized ? [normalized, language] : [normalized];
}

export function resolveCapabilityPackageDisplay(manifest: CapabilityPackageManifest, locale: string | undefined) {
  const entries = manifest.localizations ?? {};
  const localized = localeCandidates(locale)
    .map(
      (candidate) =>
        entries[candidate] ?? entries[Object.keys(entries).find((key) => key.toLowerCase() === candidate) ?? ""],
    )
    .find(Boolean);
  const canonicalTab = manifest.contributions?.homeBrowserTab;

  return {
    name: localized?.name ?? manifest.name,
    description: localized?.description ?? manifest.description,
    homeBrowserTab: canonicalTab
      ? {
          ...canonicalTab,
          label: localized?.homeBrowserTab?.label ?? canonicalTab.label,
          ariaLabel: localized?.homeBrowserTab?.ariaLabel ?? canonicalTab.ariaLabel,
        }
      : undefined,
  };
}
