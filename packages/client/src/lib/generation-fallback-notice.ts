import { toast } from "sonner";
import { translate } from "../localization/i18n";

export const GENERATION_FALLBACK_HEADER = "X-Marinara-Fallback-Used";

type GenerationFallbackNotice = {
  category?: unknown;
  connectionName?: unknown;
  connectionId?: unknown;
  model?: unknown;
  failed?: unknown;
};

type FailedConnection = {
  connectionId?: unknown;
  connectionName?: unknown;
  model?: unknown;
  reason?: unknown;
  status?: unknown;
};

function readNoticeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNotice<T>(raw: unknown): T | null {
  return raw && typeof raw === "object" ? (raw as T) : null;
}

/** "Name (model)", the name alone, or the model alone when the connection has no name. */
function connectionLabel(connection: string | null, model: unknown): string | null {
  const modelText = readNoticeText(model);
  if (!connection) return modelText;
  return modelText ? `${connection} (${modelText})` : connection;
}

function fallbackLabel(notice: GenerationFallbackNotice): string {
  const connection =
    readNoticeText(notice.connectionName) ??
    readNoticeText(notice.connectionId) ??
    translate("generation.fallback.unnamed");
  return connectionLabel(connection, notice.model) ?? connection;
}

function categoryLabel(category: unknown): string {
  switch (category) {
    case "agents":
      return translate("generation.fallback.category.agents");
    case "illustrator":
      return translate("generation.fallback.category.illustrator");
    case "video":
      return translate("generation.fallback.category.video");
    default:
      return translate("generation.fallback.category.main");
  }
}

function reasonLabel(reason: unknown, status: unknown): string {
  switch (reason) {
    case "rate_limit":
      return translate("generation.fallback.reason.rateLimit");
    case "auth":
      return translate("generation.fallback.reason.auth");
    case "not_found":
      return translate("generation.fallback.reason.notFound");
    case "timeout":
      return translate("generation.fallback.reason.timeout");
    case "network":
      return translate("generation.fallback.reason.network");
    case "server":
      return translate("generation.fallback.reason.server");
    case "empty":
      return translate("generation.fallback.reason.empty");
    default:
      return typeof status === "number"
        ? translate("generation.fallback.reason.errorStatus", { status })
        : translate("generation.fallback.reason.error");
  }
}

/**
 * Names the connection that failed and the fallback that answered (#7697), or null when the
 * notice does not say which connection failed.
 */
export function describeGenerationFallback(raw: unknown): string | null {
  const notice = readNotice<GenerationFallbackNotice>(raw);
  const failed = readNotice<FailedConnection>(notice?.failed);
  if (!notice || !failed) return null;
  const failedLabel =
    connectionLabel(readNoticeText(failed.connectionName), failed.model) ?? readNoticeText(failed.connectionId);
  if (!failedLabel) return null;
  return translate("generation.fallback.failedOver", {
    failed: failedLabel,
    reason: reasonLabel(failed.reason, failed.status),
    fallback: fallbackLabel(notice),
  });
}

export function showGenerationFallbackToast(raw: unknown): void {
  const notice = readNotice<GenerationFallbackNotice>(raw) ?? {};
  toast.info(
    translate("generation.fallback.switched", {
      category: categoryLabel(notice.category),
      connection: fallbackLabel(notice),
    }),
    {
      description: describeGenerationFallback(notice) ?? translate("generation.fallback.description"),
      duration: 10_000,
    },
  );
}

export function showGenerationFallbackHeader(response: Response): void {
  const encoded = response.headers.get(GENERATION_FALLBACK_HEADER);
  if (!encoded) return;
  try {
    showGenerationFallbackToast(JSON.parse(decodeURIComponent(encoded)));
  } catch {
    showGenerationFallbackToast({});
  }
}
