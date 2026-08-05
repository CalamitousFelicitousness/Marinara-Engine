import type { FastifyInstance } from "fastify";
import { logger } from "../../lib/logger.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import { createNoodleStorage } from "../storage/noodle.storage.js";
import { generateAndApplyNoodlerFanActivity } from "./noodle-noodler-fan-activity.service.js";

const FAN_ACTIVITY_NEXT_RUN_KEY = "noodler.fan-activity.next-run-at";
const FAN_ACTIVITY_INITIAL_DELAY_MS = 45_000;
const FAN_ACTIVITY_POLL_MS = 60_000;
const FAN_ACTIVITY_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startNoodlerFanActivityScheduler(app: FastifyInstance) {
  const noodle = createNoodleStorage(app.db);
  const appSettings = createAppSettingsStorage(app.db);
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delay: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void poll(), Math.max(1_000, delay));
    timer.unref?.();
  };

  const poll = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const settings = await noodle.getSettings();
      if (!settings.enableNoodler || !settings.fanActivityEnabled) {
        schedule(FAN_ACTIVITY_POLL_MS);
        return;
      }
      const now = Date.now();
      const stored = await appSettings.get(FAN_ACTIVITY_NEXT_RUN_KEY);
      const nextRunAt = stored ? Date.parse(stored) : Number.NaN;
      if (Number.isFinite(nextRunAt) && nextRunAt > now) {
        schedule(Math.min(FAN_ACTIVITY_POLL_MS, nextRunAt - now));
        return;
      }
      await appSettings.set(FAN_ACTIVITY_NEXT_RUN_KEY, new Date(now + FAN_ACTIVITY_INTERVAL_MS).toISOString());
      const result = await generateAndApplyNoodlerFanActivity({ db: app.db });
      logger.info(
        "[noodler-fan] Automatic audience activity completed with status %s and %d interactions",
        result.status,
        result.created,
      );
      schedule(FAN_ACTIVITY_POLL_MS);
    } catch (error) {
      logger.warn(error, "[noodler-fan] Automatic audience activity failed");
      schedule(FAN_ACTIVITY_POLL_MS);
    } finally {
      running = false;
    }
  };

  schedule(FAN_ACTIVITY_INITIAL_DELAY_MS);
  app.addHook("onClose", async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  });
  logger.info("[noodler-fan] Automatic audience activity scheduler started");
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
