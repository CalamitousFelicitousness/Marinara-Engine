// ──────────────────────────────────────────────
// TTS Failure Notices
// ──────────────────────────────────────────────
// The reason a synthesis failed, on the surface the user is looking at. Without
// this a stopped local engine is indistinguishable from a stopped feature: the
// button flips back and the detail reaches only the console and the settings
// card.
//
// Fired once per sequence, not per retry. The engine imports this lazily and
// only in a browser, so the regression suite never loads sonner.

import { toast } from "sonner";
import { i18n } from "../localization/i18n";
import { TTSSynthesisError, type TTSFailureKind } from "./tts-synthesis-policy";

/** Where the user actually fixes a timeout. The card lives in Connections, not Settings. */
const ADVANCED_SETTINGS_PATH = "Connections, Text to Speech, Advanced synthesis";

function localize(key: string, fallback: string, values?: Record<string, string>): string {
  const translated = i18n.t(key, { defaultValue: fallback, ...values });
  return typeof translated === "string" && translated.trim() ? translated : fallback;
}

function describe(kind: TTSFailureKind, detail: string): { title: string; description?: string } {
  switch (kind) {
    case "timeout":
      return {
        title: localize("ui.tts.notice.timeoutTitle", "The speech engine ran out of time"),
        description: localize(
          "ui.tts.notice.timeoutBody",
          "Raise the request timeout in {{path}}. Local engines on CPU often need several minutes per chunk.",
          { path: ADVANCED_SETTINGS_PATH },
        ),
      };
    case "unreachable":
      return {
        title: localize("ui.tts.notice.unreachableTitle", "Could not reach the speech engine"),
        description: localize(
          "ui.tts.notice.unreachableBody",
          "Check that it is running and that the base URL is right.",
        ),
      };
    default:
      return {
        title: localize("ui.tts.notice.providerTitle", "The speech engine rejected the request"),
        description: detail || undefined,
      };
  }
}

export function notifyTTSFailure(error: unknown): void {
  const kind: TTSFailureKind = error instanceof TTSSynthesisError ? error.kind : "provider";
  if (kind === "aborted") return;
  const detail = error instanceof Error ? error.message : "";
  const { title, description } = describe(kind, detail);
  toast.error(title, { description });
}

/**
 * Autoplay stopped trying. Raised once when the breaker trips, so a dead engine
 * cannot turn every generated message into minutes of silent loading.
 */
export function notifyTTSAutoplayPaused(): void {
  toast.warning(localize("ui.tts.notice.autoplayPausedTitle", "Voice autoplay paused"), {
    description: localize(
      "ui.tts.notice.autoplayPausedBody",
      "The speech engine failed several times in a row. Press the speak button on a message to try again.",
    ),
  });
}
