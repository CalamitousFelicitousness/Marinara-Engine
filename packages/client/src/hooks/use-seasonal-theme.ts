// ──────────────────────────────────────────────
// Hook: the seasonal theme worn now, and its greeting
// ──────────────────────────────────────────────
import { useCallback, useEffect, useState } from "react";
import {
  readSeasonalPreview,
  resolveSeasonalTheme,
  withSeasonalYear,
  type SeasonalYears,
} from "../lib/seasonal-themes";
import { useUIStore } from "../stores/ui.store";

const MINUTE_MS = 60_000;

/** The current minute as a number, so an unchanged minute re-renders nothing. */
function startOfMinute() {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
}

/** Ticks once a minute, so dated windows open and close on time even while the app stays open. */
export function useMinuteClock(): Date {
  const [minute, setMinute] = useState(startOfMinute);
  useEffect(() => {
    const timer = window.setInterval(() => setMinute(startOfMinute()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return new Date(minute);
}

export function useSeasonalTheme() {
  const disabled = useUIStore((state) => state.seasonalThemesDisabled);
  const storedGreeted = useUIStore((state) => state.seasonalGreetingYears);
  const storedOff = useUIStore((state) => state.seasonalThemeOffYears);
  // The preview keeps its greeting and "Turn it off" in memory, so trying it never saves anything.
  const [preview] = useState(() => readSeasonalPreview(window.location.search));
  const [previewGreeted, setPreviewGreeted] = useState<SeasonalYears>({});
  const [previewOff, setPreviewOff] = useState<SeasonalYears>({});
  const date = useMinuteClock();
  const year = date.getFullYear();
  const { themeId, showGreeting } = resolveSeasonalTheme({
    date,
    disabled,
    preview,
    greeted: preview ? previewGreeted : storedGreeted,
    turnedOff: preview ? previewOff : storedOff,
  });

  const markGreeted = useCallback(() => {
    if (!themeId) return;
    if (preview) setPreviewGreeted((years) => withSeasonalYear(years, themeId, year));
    else useUIStore.getState().markSeasonalGreetingShown(themeId, year);
  }, [preview, themeId, year]);

  const turnOff = useCallback(() => {
    if (!themeId) return;
    if (preview) setPreviewOff((years) => withSeasonalYear(years, themeId, year));
    else useUIStore.getState().turnOffSeasonalTheme(themeId, year);
  }, [preview, themeId, year]);

  return { themeId, showGreeting, markGreeted, turnOff };
}
