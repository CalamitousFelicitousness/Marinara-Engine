import { getAdminSecret, getPort, getServerProtocol } from "../config/runtime-config.js";
import { pidDefinitelyExited, StorageWriterLeaseError } from "../db/file-backed-store.js";
import { logger } from "./logger.js";

const HOLDER_EXIT_TIMEOUT_MS = 20_000;

/** Stops the live copy holding the storage lease; resolves true once it has exited. */
export async function takeOverRunningCopy(error: unknown): Promise<boolean> {
  if (!(error instanceof StorageWriterLeaseError) || error.holderPid === undefined) return false;
  // Only a launcher-supervised start is started again after the holder exits.
  if (process.env.MARINARA_RESTART_SUPERVISOR !== String(process.ppid)) return false;

  const pid = error.holderPid;
  // ponytail: loopback on this .env's port only; a copy on another port, host binding or self-signed TLS keeps the lease error.
  const url = `${getServerProtocol()}://127.0.0.1:${getPort()}/api/admin/shutdown`;
  const adminSecret = getAdminSecret();
  logger.warn("[startup] Marinara Engine is already running as PID %d; asking it to shut down", pid);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(adminSecret ? { "X-Admin-Secret": adminSecret } : {}) },
      body: JSON.stringify({ confirm: true, pid }),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 202) {
      logger.error("[startup] PID %d refused to shut down (HTTP %d): %s", pid, response.status, await response.text());
      return false;
    }
  } catch (err) {
    logger.error(err, "[startup] Could not ask PID %d to shut down at %s", pid, url);
    return false;
  }

  const deadline = Date.now() + HOLDER_EXIT_TIMEOUT_MS;
  while (!pidDefinitelyExited(pid)) {
    if (Date.now() > deadline) {
      logger.error("[startup] PID %d did not exit within %d s", pid, HOLDER_EXIT_TIMEOUT_MS / 1000);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  logger.warn("[startup] PID %d shut down; starting in its place", pid);
  return true;
}
