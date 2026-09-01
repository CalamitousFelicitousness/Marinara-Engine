export interface SupportDiagnostics {
  version: string;
  build: string;
  commit: string | null;
  serverOs: string;
  serverMemory?: {
    heapUsedMiB: number;
    heapLimitMiB: number;
    rssMiB: number;
  };
  clientOs: string;
  browser: string;
  gpu: string;
  connectionName: string | null;
  connectionProvider: string | null;
  model: string | null;
  /** Launcher-reported Android wake-lock outcome; null when not reported. */
  wakeLock?: string | null;
  /**
   * True when the health request timed out (frozen host). Server-side lines
   * then read as unreachable instead of affirmative "not reported"/"none
   * detected" text that would contradict the very signal the copy carries.
   */
  serverUnreachable?: boolean;
  /** Most recent host suspension the server's freeze detector observed. */
  lastFreeze?: { detectedAt: string; gapMs: number; suspendedMs: number } | null;
}

export function resolveClientOs(userAgent: string, platform: string, maxTouchPoints = 0): string {
  const windows = userAgent.match(/Windows NT ([\d.]+)/u);
  if (windows) return `Windows ${windows[1]}`;
  const android = userAgent.match(/Android ([\d.]+)/u);
  if (android) return `Android ${android[1]}`;
  const ios = userAgent.match(/(?:iPhone OS|CPU OS) ([\d_]+)/u);
  if (ios) return `iOS ${ios[1]!.replaceAll("_", ".")}`;
  if (/Macintosh/u.test(userAgent) && maxTouchPoints > 1) {
    const webkitVersion = userAgent.match(/AppleWebKit\/([\d.]+)/u)?.[1];
    return webkitVersion ? `iPadOS (WebKit ${webkitVersion})` : "iPadOS";
  }
  const mac = userAgent.match(/Mac OS X ([\d_]+)/u);
  if (mac) return `macOS ${mac[1]!.replaceAll("_", ".")}`;
  if (/Linux/u.test(userAgent)) return "Linux";
  return platform.trim() || "Unavailable";
}

export function detectBrowserGpu(): string {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!context) return "Unavailable";
    const debugInfo = context.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
    const renderer = debugInfo
      ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : context.getParameter(context.RENDERER);
    return typeof renderer === "string" && renderer.trim() ? renderer.trim() : "Unavailable";
  } catch {
    return "Unavailable";
  }
}

function available(value: string | null | undefined): string {
  return value?.trim() || "Unavailable";
}

export const SERVER_UNREACHABLE_DIAGNOSTIC = "Unreachable (request timed out)";

export function formatSupportDiagnostics(diagnostics: SupportDiagnostics): string {
  const memory = diagnostics.serverMemory;
  const freeze = diagnostics.lastFreeze;
  const unreachable = diagnostics.serverUnreachable === true;
  return [
    "Marinara Engine diagnostics",
    `Version: ${available(diagnostics.version)}`,
    `Build: ${available(diagnostics.build)}`,
    `Commit: ${available(diagnostics.commit)}`,
    `Server OS: ${unreachable ? diagnostics.serverOs?.trim() || SERVER_UNREACHABLE_DIAGNOSTIC : available(diagnostics.serverOs)}`,
    `Server memory: ${memory ? `heap ${memory.heapUsedMiB} / ${memory.heapLimitMiB} MiB; RSS ${memory.rssMiB} MiB` : unreachable ? SERVER_UNREACHABLE_DIAGNOSTIC : "Unavailable"}`,
    `Background wake lock: ${diagnostics.wakeLock ?? (unreachable ? SERVER_UNREACHABLE_DIAGNOSTIC : "not reported")}`,
    `Last detected freeze: ${freeze ? `~${Math.round(freeze.suspendedMs / 1000)}s suspension, thawed at ${freeze.detectedAt}` : unreachable ? SERVER_UNREACHABLE_DIAGNOSTIC : "none detected"}`,
    `Client OS: ${available(diagnostics.clientOs)}`,
    `Browser / app shell: ${available(diagnostics.browser)}`,
    `GPU: ${available(diagnostics.gpu)}`,
    `Active connection: ${available(diagnostics.connectionName)}`,
    `Connection provider: ${available(diagnostics.connectionProvider)}`,
    `LLM model: ${available(diagnostics.model)}`,
  ].join("\n");
}
