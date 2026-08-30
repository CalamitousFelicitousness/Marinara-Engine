// Reads how much of a NanoGPT plan is left.
//
// A subscription changes what a price means rather than what it is: a covered
// model bills nothing per token until its allowance runs out, and with overage
// off the request after that is refused rather than charged. So a per-million
// figure shown beside a covered model is a number the caller never pays.
//
// GET /api/v1/subscription/usage answers with the plan's billing identifiers
// alongside the counters. Only the counters are read, because the rest reaches
// a browser for no reason.

import type { ProviderQuota, ProviderSubscription } from "@marinara-engine/shared";
import { safeFetch } from "../../utils/security.js";
import { isProviderLocalUrlsEnabled } from "../../config/runtime-config.js";

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return !!value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** One allowance, or undefined where the plan meters nothing by that measure. */
function readQuota(value: unknown): ProviderQuota | undefined {
  const row = readRecord(value);
  if (!row) return undefined;
  const used = readNumber(row.used);
  const remaining = readNumber(row.remaining);
  if (used === null || remaining === null) return undefined;
  return {
    used,
    remaining,
    percentUsed: readNumber(row.percentUsed) ?? 0,
    resetAt: readNumber(row.resetAt),
  };
}

export function parseNanoGptSubscription(payload: unknown): ProviderSubscription | null {
  const row = readRecord(payload);
  if (!row) return null;
  const routing = readRecord(row.routing);
  const period = readRecord(row.period);
  const weekly = readQuota(row.weeklyInputTokens);
  const daily = readQuota(row.dailyInputTokens);
  const images = readQuota(row.dailyImages);
  return {
    active: row.active === true,
    allowOverage: row.allowOverage === true,
    recommendedMode: typeof routing?.recommendedMode === "string" ? routing.recommendedMode : null,
    periodEnd: typeof period?.currentPeriodEnd === "string" ? period.currentPeriodEnd : null,
    ...(weekly ? { weeklyInputTokens: weekly } : {}),
    ...(daily ? { dailyInputTokens: daily } : {}),
    ...(images ? { dailyImages: images } : {}),
  };
}

export async function fetchNanoGptSubscription(baseUrl: string, apiKey: string): Promise<ProviderSubscription | null> {
  const res = await safeFetch(`${baseUrl.replace(/\/+$/, "")}/subscription/usage`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
    policy: {
      allowLocal: isProviderLocalUrlsEnabled(),
      allowLoopback: true,
      allowMdns: true,
      allowedProtocols: ["https:", "http:"],
      flagName: "PROVIDER_LOCAL_URLS_ENABLED",
    },
    maxResponseBytes: 256 * 1024,
    decodeCompressedResponse: true,
  });
  if (!res.ok) throw new Error(`Subscription request failed (${res.status})`);
  return parseNanoGptSubscription(await res.json());
}
