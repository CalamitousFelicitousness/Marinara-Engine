// ──────────────────────────────────────────────
// Shared Logger — Pino singleton
// ──────────────────────────────────────────────
// Every module in the server package should import `logger` from here
// instead of using `console.log/warn/error` directly. This ensures
// LOG_LEVEL actually controls what gets printed.
//
// Fastify builds its own separate pino instance from a {level, stream}
// object (see app.ts) rather than importing this singleton, so
// req.log / reply.log do NOT track runtime LOG_LEVEL changes applied here
// by the env-watcher hot-reload.
// ──────────────────────────────────────────────
import pino from "pino";
import prettyStream from "pino-pretty";
import { getLogLevel, getNodeEnv } from "../config/runtime-config.js";

/**
 * Log destination, shared with the Fastify logger in app.ts.
 *
 * Left to itself pino writes to file descriptor 1, which on Windows reaches the
 * console through WriteFile and is decoded with the console's OEM code page, so
 * a character like U+0144 surfaces as two box-drawing glyphs. process.stdout is
 * a TTY stream and writes through WriteConsoleW, which carries Unicode whatever
 * the active code page is, and still emits plain UTF-8 once redirected to a file
 * or a pipe. Both modes need it: the dev transport and the production default
 * are each fd-based.
 */
export function createLogDestination() {
  if (getNodeEnv() === "production") return process.stdout;
  return prettyStream({ colorize: true, destination: process.stdout });
}

export const logger = pino({ level: getLogLevel() }, createLogDestination());

export function logDebugOverride(overrideEnabled: boolean, message: string, ...args: any[]) {
  if (overrideEnabled && !logger.isLevelEnabled("debug")) {
    // Default LOG_LEVEL is warn, so explicit UI debug mode must log at warn to be visible.
    logger.warn(message, ...args);
    return;
  }

  logger.debug(message, ...args);
}
