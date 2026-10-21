// ──────────────────────────────────────────────
// Diagnostic: CSRF origin trust banner
// ──────────────────────────────────────────────
// Probes /api/csrf/origin-status on mount. If the current origin would be
// rejected by the CSRF hook for unsafe mutations, returns a critical banner
// so the user knows BEFORE they try to save and watch the change vanish.
//
// Stays out of the way for the 99% case — when the origin is auto-trusted
// (loopback / LAN / Tailscale-IP / Docker-IP / configured), the
// hook returns null.
import { createElement as h, Fragment, useEffect, useState } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { copyToClipboard } from "../../lib/utils";
import type { AppBannerCandidate } from "../ui/AppBanner";

type OriginStatus = {
  trusted: boolean;
  origin: string | null;
  source: "origin" | "referer" | "host" | "none";
  code: "CSRF_ORIGIN_NOT_TRUSTED" | "CSRF_REFERER_NOT_TRUSTED" | "CSRF_NO_ORIGIN" | null;
  hint: string | null;
};

function extractEnvLine(hint: string): string | null {
  // Hint format: "Add 'http://...' to CSRF_TRUSTED_ORIGINS in your .env — comma-separated if you
  // already have entries, e.g. CSRF_TRUSTED_ORIGINS=http://existing.example,http://.... No restart needed (takes
  // effect within ~2s)."
  // [^\s]+ spans dots — required for IP literals like 71.175.221.189 — and the trailing period in
  // the hint sentence is stripped afterwards. \b anchors to "CSRF_TRUSTED_ORIGINS=" so the bare mention earlier in the
  // hint ("...to CSRF_TRUSTED_ORIGINS in your .env...") doesn't match.
  const match = hint.match(/\bCSRF_TRUSTED_ORIGINS=[^\s]+/);
  return match ? match[0].replace(/\.$/, "") : null;
}

const codeClass = "rounded bg-[var(--foreground)]/10 px-1 font-mono text-[0.8em]";

export function useCsrfOriginBanner(): AppBannerCandidate | null {
  const { t: localizeUi } = useUiTranslation();
  const [status, setStatus] = useState<OriginStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<OriginStatus>("/csrf/origin-status")
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        // Probe failure is non-fatal — the toast on actual rejection still fires.
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || status.trusted) return null;

  const envLine = status.hint ? extractEnvLine(status.hint) : null;
  const offender = status.origin ?? window.location.origin;
  const code = (text: string) => h("code", { className: codeClass }, text);

  const copyEnv = async () => {
    if (envLine && (await copyToClipboard(envLine))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    }
  };

  return {
    id: "csrf-origin",
    severity: "critical",
    title: localizeUi("ui.diagnostics.csrforiginwarningbanner.savesWillSilentlyFailThisOriginIsNotTrusted"),
    body: h(
      "span",
      null,
      localizeUi("ui.diagnostics.csrforiginwarningbanner.marinaraSCsrfProtectionRejectsUnsafeApiRequestsFrom"),
      " ",
      code(offender),
      localizeUi("ui.diagnostics.csrforiginwarningbanner.addThisLineToYour"),
      " ",
      code(".env"),
      " ",
      localizeUi("ui.diagnostics.csrforiginwarningbanner.noRestartNeededTakesEffectWithin2s"),
    ),
    actions:
      envLine &&
      h(
        Fragment,
        null,
        h("code", { className: `${codeClass} min-w-0 flex-1 basis-48 break-all py-1 select-all` }, envLine),
        h(
          "button",
          {
            type: "button",
            onClick: copyEnv,
            className:
              "min-h-11 shrink-0 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-semibold text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]",
          },
          copied
            ? localizeUi("ui.diagnostics.csrforiginwarningbanner.copied")
            : localizeUi("lorebook.editor.batch.copy"),
        ),
      ),
    details: h(
      "span",
      null,
      localizeUi("ui.diagnostics.csrforiginwarningbanner.autoTrustedWithoutAddingHereLoopback"),
      code("127.0.0.1"),
      ", ",
      code("localhost"),
      localizeUi("ui.diagnostics.csrforiginwarningbanner.lanIps"),
      code("192.168.x.x"),
      ", ",
      code("10.x.x.x"),
      localizeUi("ui.diagnostics.csrforiginwarningbanner.tailscaleCgnat"),
      code("100.64.0.0/10"),
      localizeUi("ui.diagnostics.csrforiginwarningbanner.dockerBridge"),
      code("172.16.0.0/12"),
      localizeUi("ui.diagnostics.csrforiginwarningbanner.publicIpsAndDnsNamesNeedToBeListed"),
    ),
  };
}
