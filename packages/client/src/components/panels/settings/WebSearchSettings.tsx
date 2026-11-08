import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical, Save } from "lucide-react";
import { toast } from "sonner";
import {
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
  type WebSearchSettings as Values,
  type WebSearchTestResult,
} from "@marinara-engine/shared";
import { getPrivilegedActionErrorMessage } from "../../../lib/api-client";
import {
  useSaveWebSearchSettings,
  useTestWebSearch,
  useWebSearchSettings,
} from "../../../hooks/use-web-search-settings";
import { SETTINGS_BUTTON_CLASS, SETTINGS_PRIMARY_BUTTON_CLASS } from "./SettingControls";

const FIELD_CLASS =
  "w-full rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-[var(--border)] focus:ring-[var(--ring)] disabled:opacity-50";

/** The address field's text becomes null when empty, which the server accepts only for providers that do not need it. */
function toValues(provider: WebSearchProvider, url: string): Values {
  return { provider, searxngUrl: url.trim() || null };
}

export function WebSearchSettings() {
  const { t } = useTranslation();
  const providerId = useId();
  const { data, isError } = useWebSearchSettings();
  const [draft, setDraft] = useState<{ provider: WebSearchProvider; url: string } | null>(null);
  const [testResult, setTestResult] = useState<WebSearchTestResult | null>(null);
  const saveSettings = useSaveWebSearchSettings();
  const runTest = useTestWebSearch();
  const save = {
    isPending: saveSettings.isPending,
    mutate: (values: Values) =>
      saveSettings.mutate(values, {
        onSuccess: () => {
          setDraft(null);
          toast.success(t("settings.webSearch.saved"));
        },
        onError: (error) => toast.error(getPrivilegedActionErrorMessage(error, t("settings.webSearch.saveFailed"))),
      }),
  };
  const test = {
    isPending: runTest.isPending,
    mutate: (values: Values) => {
      setTestResult(null);
      runTest.mutate(values, {
        onSuccess: setTestResult,
        onError: (error) => toast.error(getPrivilegedActionErrorMessage(error, t("settings.webSearch.testFailed"))),
      });
    },
  };
  if (!data)
    return (
      <p className="text-xs text-[var(--muted-foreground)]">
        {t(isError ? "settings.webSearch.loadFailed" : "settings.webSearch.loading")}
      </p>
    );
  const current = draft ?? { provider: data.provider, url: data.searxngUrl ?? "" };
  const edit = (change: Partial<typeof current>) => {
    setDraft({ ...current, ...change });
    setTestResult(null);
  };
  const busy = save.isPending || test.isPending;
  const missingUrl = current.provider === "searxng" && !current.url.trim();
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{t("settings.webSearch.description")}</p>
      <div className="flex items-center justify-between gap-3 text-xs">
        <label htmlFor={providerId}>{t("settings.webSearch.provider")}</label>
        <select
          id={providerId}
          value={current.provider}
          disabled={busy}
          onChange={(event) => edit({ provider: event.target.value as WebSearchProvider })}
          className="rounded-lg bg-[var(--secondary)] px-3 py-2 ring-1 ring-[var(--border)] disabled:opacity-50"
        >
          {WEB_SEARCH_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {t(`settings.webSearch.providers.${provider}`)}
            </option>
          ))}
        </select>
      </div>
      {current.provider === "searxng" && (
        <>
          <label className="block space-y-1.5 text-xs">
            <span>{t("settings.webSearch.searxngUrl")}</span>
            <input
              type="url"
              value={current.url}
              placeholder={t("settings.webSearch.placeholder")}
              disabled={busy}
              onChange={(event) => edit({ url: event.target.value })}
              className={FIELD_CLASS}
            />
          </label>
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
            {t("settings.webSearch.searxngHint")}
          </p>
        </>
      )}
      {testResult && (
        <p
          role="status"
          className={`text-xs leading-relaxed ${testResult.ok ? "text-[var(--muted-foreground)]" : "text-[var(--destructive)]"}`}
        >
          {testResult.ok
            ? t("settings.webSearch.testPassed", { count: testResult.count })
            : t("settings.webSearch.testError", { error: testResult.error })}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || missingUrl}
          onClick={() => test.mutate(toValues(current.provider, current.url))}
          className={SETTINGS_BUTTON_CLASS}
        >
          <FlaskConical size="0.8125rem" />
          {t("settings.webSearch.test")}
        </button>
        <button
          type="button"
          disabled={!draft || busy || missingUrl}
          onClick={() => save.mutate(toValues(current.provider, current.url))}
          className={`${SETTINGS_PRIMARY_BUTTON_CLASS} min-w-0 flex-1`}
        >
          <Save size="0.8125rem" />
          {t("settings.webSearch.save")}
        </button>
      </div>
    </div>
  );
}
