// ──────────────────────────────────────────────
// Single mount point for app-wide banners: shows only the most severe one
// ──────────────────────────────────────────────
import { useState, type ReactNode } from "react";
import { useCsrfOriginBanner } from "../diagnostics/use-csrf-origin-banner";
import { AppBanner, type AppBannerCandidate } from "../ui/AppBanner";

const DISMISS_KEY_PREFIX = "marinara:app-banner-dismissed:";

// Critical banners come back next session; warnings stay dismissed.
const dismissStorage = (candidate: AppBannerCandidate) =>
  candidate.severity === "critical" ? window.sessionStorage : window.localStorage;

function wasDismissed(candidate: AppBannerCandidate) {
  try {
    return dismissStorage(candidate).getItem(DISMISS_KEY_PREFIX + candidate.id) === "1";
  } catch {
    return false;
  }
}

function pickAppBanner(candidates: (AppBannerCandidate | null)[], dismissed: (c: AppBannerCandidate) => boolean) {
  return (
    candidates
      .filter((c): c is AppBannerCandidate => c !== null && !dismissed(c))
      // Array.prototype.sort is stable, so equal severities keep their candidate order.
      .sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"))[0] ?? null
  );
}

/** Wraps the app shell; while a banner shows, the shell is laid out below it instead of under it. */
export function AppBannerHost({ children }: { children: ReactNode }) {
  const candidates = [useCsrfOriginBanner()];
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  const banner = pickAppBanner(candidates, (c) => dismissedIds.includes(c.id) || wasDismissed(c));

  const dismiss = (candidate: AppBannerCandidate) => {
    setDismissedIds((ids) => [...ids, candidate.id]);
    try {
      dismissStorage(candidate).setItem(DISMISS_KEY_PREFIX + candidate.id, "1");
    } catch {
      /* storage unavailable — the in-memory dismissal still hides it */
    }
  };

  // `contents` keeps the shell's layout untouched while no banner shows. With a banner,
  // contain-layout makes the shell's `fixed inset-0` (and its fixed panels) resolve against
  // the area below the banner; max-h-full caps the chat surface's visual-viewport height there.
  return (
    <div className={banner ? "fixed inset-0 flex flex-col" : "contents"}>
      {banner && <AppBanner key={banner.id} {...banner} onDismiss={() => dismiss(banner)} />}
      <div className={banner ? "relative min-h-0 flex-1 contain-layout [&_.mari-app]:max-h-full" : "contents"}>
        {children}
      </div>
    </div>
  );
}
