import { Fragment } from "react";
import { Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../../stores/ui.store";
import { useAccessStatus, visiblePasswordlessPeers } from "../../diagnostics/use-access-warning-banner";
import { SettingsSection } from "./SettingControls";

/** Settings > Advanced > Access: owner-only summary of who gets in without a password. Others see one line. */
export function AccessStatusSettings({ anchorId }: { anchorId: string }) {
  const { t } = useTranslation();
  const { data, isError } = useAccessStatus();
  if (isError) {
    return (
      <SettingsSection title={t("settings.accessStatus.title")} icon={<Shield size="0.875rem" />} anchorId={anchorId}>
        <p className="text-xs text-[var(--muted-foreground)]">{t("settings.accessStatus.ownerOnly")}</p>
      </SettingsSection>
    );
  }
  if (!data) return null;

  const peers = visiblePasswordlessPeers(data.passwordlessPeers);
  const open = peers.length > 0;
  const setOrNot = (value: boolean) => t(value ? "settings.accessStatus.set" : "settings.accessStatus.notSet");
  const rows = [
    [
      "listen",
      data.loopbackOnly
        ? t("settings.accessStatus.listen.loopback")
        : t("settings.accessStatus.listen.network", { host: data.host }),
    ],
    ["login", setOrNot(data.basicAuth)],
    ["adminSecret", setOrNot(data.adminSecret)],
    ["allowlist", setOrNot(data.allowlist)],
    [
      "connection",
      t(data.viaProxy ? "settings.accessStatus.connection.proxy" : "settings.accessStatus.connection.direct"),
    ],
  ];

  return (
    <SettingsSection
      title={t("settings.accessStatus.title")}
      description={t("settings.accessStatus.description")}
      icon={open ? <ShieldAlert size="0.875rem" /> : <ShieldCheck size="0.875rem" />}
      anchorId={anchorId}
    >
      <div className="flex flex-col gap-3 text-xs">
        {open ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="font-semibold text-[var(--foreground)]">{t("settings.accessStatus.peersIntro")}</p>
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-[var(--foreground)]">
              {peers.map((peer) => (
                <li key={peer}>{t(`settings.accessStatus.peer.${peer}`)}</li>
              ))}
            </ul>
            {peers.includes("docker") && (
              <p className="mt-2 text-[var(--muted-foreground)]">{t("settings.accessStatus.dockerHint")}</p>
            )}
            <p className="mt-2 text-[var(--muted-foreground)]">{t("settings.accessStatus.nextStep")}</p>
            <button
              type="button"
              onClick={() => useUIStore.getState().openModal("docs-viewer", { initialDoc: "REMOTE_ACCESS.md" })}
              className="inline-flex min-h-11 items-center text-left font-semibold text-[var(--foreground)] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            >
              {t("settings.accessStatus.guide")}
            </button>
          </div>
        ) : (
          <p className="text-[var(--muted-foreground)]">{t("settings.accessStatus.closed")}</p>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          {rows.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="text-[var(--muted-foreground)]">{t(`settings.accessStatus.row.${key}`)}</dt>
              <dd className="min-w-0 break-words text-[var(--foreground)]">{value}</dd>
            </Fragment>
          ))}
        </dl>
        <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {t("settings.accessStatus.unknown")}
        </p>
      </div>
    </SettingsSection>
  );
}
