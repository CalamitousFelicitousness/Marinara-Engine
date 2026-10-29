import { ArrowLeft, ArrowUpRight, Check, ChevronRight, ExternalLink } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";
import { AgentVersionHistory } from "../AgentVersionHistory";
import {
  formatBytes,
  hasUpdate,
  MODE_BADGES,
  packageModes,
  sectionLabelKey,
  sectionOf,
  taglineOf,
  typeLabelKey,
  typeOf,
  type OrganizerEntry,
} from "./organizer-model";
import {
  AgentAction,
  AgentIcon,
  AgentRow,
  MenuButton,
  SECONDARY_ACTION,
  StoreBanner,
  useOrganizer,
} from "./OrganizerParts";

const HOW_TO_STEPS = [1, 2, 3] as const;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.6875rem] text-[var(--muted-foreground)]">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold text-[var(--foreground)]">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-[var(--border)] pt-5">
      <h3 className="mb-3 text-base font-semibold text-[var(--foreground)]">{title}</h3>
      {children}
    </section>
  );
}

export function AgentPage({
  entry,
  entries,
  customSource,
}: {
  entry: OrganizerEntry;
  entries: readonly OrganizerEntry[];
  customSource: boolean;
}) {
  const { installedById, go, open } = useOrganizer();
  const { t: localizeUi } = useUiTranslation();
  const { manifest } = entry;
  const installed = installedById.get(manifest.id);
  const update = hasUpdate(entry, installed);
  const section = sectionOf(entry);
  const type = typeOf(entry);
  const modes = packageModes(manifest.id);
  const previews = entry.store?.previewUrls ?? [];
  const more = entries.filter((item) => item.manifest.id !== manifest.id && sectionOf(item) === section).slice(0, 4);

  const installedPermissions = installed?.manifest.permissions;
  const permissionGroups = [
    ...(installed
      ? [{ kind: "installed" as const, version: installed.version, permissions: installed.manifest.permissions }]
      : []),
    ...(!installedPermissions ||
    installedPermissions.length !== manifest.permissions.length ||
    manifest.permissions.some((permission) => !installedPermissions.includes(permission))
      ? [{ kind: "available" as const, version: manifest.version, permissions: manifest.permissions }]
      : []),
  ];

  return (
    <article className="mx-auto max-w-4xl">
      <nav className="mb-3 flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
        <button
          type="button"
          onClick={() => go({ kind: "home" })}
          className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:text-[var(--foreground)]"
        >
          <ArrowLeft size="0.8rem" aria-hidden="true" />
          {localizeUi("ui.agents.organizer.title")}
        </button>
        <ChevronRight size="0.7rem" aria-hidden="true" />
        <button
          type="button"
          onClick={() => go({ kind: "section", id: section })}
          className="truncate rounded-md px-1 py-0.5 hover:text-[var(--foreground)]"
        >
          {localizeUi(sectionLabelKey(section))}
        </button>
      </nav>

      <StoreBanner
        entry={entry}
        priority
        sizes="(min-width: 1024px) 56rem, 100vw"
        className="aspect-[8/3] rounded-2xl border border-[var(--border)]"
      />

      <header className="relative -mt-8 flex flex-wrap items-end gap-4 px-2 sm:-mt-10 sm:px-4">
        <AgentIcon
          entry={entry}
          className="h-20 w-20 rounded-2xl ring-4 ring-[var(--marinara-editor-bg,var(--background))] sm:h-24 sm:w-24"
        />
        <div className="min-w-0 flex-1 pb-1">
          <p className="text-xs font-semibold text-[var(--muted-foreground)]">
            {localizeUi(sectionLabelKey(section))} · {localizeUi(typeLabelKey(type))}
          </p>
          <h2 className="truncate text-2xl font-bold text-[var(--foreground)]">{manifest.name}</h2>
          <p className="text-sm text-[var(--muted-foreground)]">{taglineOf(entry)}</p>
        </div>
        <div className="flex items-center gap-2 pb-1">
          <AgentAction entry={entry} size="lg" />
          {update && type === "app" && (
            <button
              type="button"
              className={cn(SECONDARY_ACTION, "h-10 gap-1 px-4 text-sm font-semibold")}
              onClick={() => open(entry)}
            >
              <ArrowUpRight size="0.9rem" aria-hidden="true" />
              {localizeUi("ui.agents.organizer.open")}
            </button>
          )}
          <MenuButton entry={entry} className="h-10 w-10" />
        </div>
      </header>

      <dl className="mt-6 grid grid-cols-2 gap-4 rounded-2xl border border-[var(--border)] px-4 py-3 sm:grid-cols-5">
        <Fact label={localizeUi("ui.agents.organizer.facts.type")}>{localizeUi(typeLabelKey(type))}</Fact>
        <Fact label={localizeUi("ui.agents.organizer.facts.worksIn")}>
          {modes.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {modes.map((mode) => (
                <span
                  key={mode}
                  className={cn(
                    "rounded-md border px-1.5 py-0.5 text-[0.625rem] font-semibold",
                    MODE_BADGES[mode].className,
                  )}
                >
                  {localizeUi(MODE_BADGES[mode].labelKey)}
                </span>
              ))}
            </span>
          ) : (
            localizeUi("ui.agents.organizer.facts.anyMode")
          )}
        </Fact>
        <Fact label={localizeUi("ui.agents.organizer.facts.version")}>
          {installed && update
            ? localizeUi("ui.agents.organizer.versionChange", { from: installed.version, to: manifest.version })
            : (installed?.version ?? manifest.version)}
        </Fact>
        <Fact label={localizeUi("ui.agents.organizer.facts.size")}>{formatBytes(entry.artifact.bytes)}</Fact>
        <Fact label={localizeUi("ui.agents.organizer.facts.source")}>
          {localizeUi(customSource ? "ui.agents.organizer.facts.custom" : "ui.agents.organizer.facts.official")}
        </Fact>
      </dl>

      <div className="mt-6 space-y-6">
        {previews.length > 0 && (
          <Section title={localizeUi("ui.agents.organizer.preview")}>
            <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
              {previews.map((url, index) => (
                <img
                  key={url}
                  src={url}
                  alt={localizeUi("ui.agents.organizer.previewAlt", { name: manifest.name, index: index + 1 })}
                  width={640}
                  height={400}
                  loading="lazy"
                  decoding="async"
                  className="h-56 w-auto shrink-0 snap-start rounded-xl border border-[var(--border)] bg-[var(--card)] object-cover sm:h-72"
                />
              ))}
            </div>
          </Section>
        )}

        {(type === "app" || type === "game" || type === "agent") && (
          <Section title={localizeUi("ui.agents.organizer.howTo")}>
            <ol className="grid gap-3 sm:grid-cols-3">
              {HOW_TO_STEPS.map((step) => (
                <li key={step} className="flex gap-3 rounded-xl border border-[var(--border)] p-3 text-sm">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--marinara-chat-chrome-highlight-bg,var(--accent))] text-xs font-bold text-[var(--foreground)]">
                    {step}
                  </span>
                  <span className="text-[var(--foreground)]">
                    {localizeUi(`ui.agents.organizer.steps.${type}.step${step}`)}
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        )}

        <Section title={localizeUi("ui.agents.organizer.about")}>
          <p className="max-w-[70ch] text-sm leading-6 text-[var(--muted-foreground)]">{manifest.description}</p>
          {entry.documentationUrl && (
            <a
              href={entry.documentationUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-[var(--marinara-chat-chrome-accent,var(--primary))] hover:underline"
            >
              <ExternalLink size="0.85rem" aria-hidden="true" />
              {localizeUi("ui.agents.agentcatalogview.readHowThisAgentWorks")}
            </a>
          )}
        </Section>

        <AgentVersionHistory packageId={manifest.id} />

        <Section title={localizeUi("ui.agents.agentcatalogview.permissions")}>
          {(manifest.entrypoints.server || manifest.entrypoints.client) && (
            <p className="mb-2 rounded-lg border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-3 py-2 text-xs leading-relaxed text-[var(--foreground)]">
              {localizeUi("ui.agents.agentcatalogview.trustedCodeAccessNotice")}
            </p>
          )}
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.agents.agentcatalogview.permissionScopeNotice")}
          </p>
          {permissionGroups.map((group) => (
            <div key={group.kind} className="mt-3">
              <h4 className="text-xs font-medium">
                {localizeUi(
                  group.kind === "installed"
                    ? "ui.agents.agentcatalogview.installedPermissions"
                    : "ui.agents.agentcatalogview.availablePermissions",
                  { version: group.version },
                )}
              </h4>
              {group.permissions.length > 0 ? (
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {group.permissions.map((permission) => (
                    <li key={permission} className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
                      <Check
                        size="0.85rem"
                        className="text-[var(--marinara-chat-chrome-highlight-text)]"
                        aria-hidden="true"
                      />
                      {permission.replaceAll("-", " ")}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                  {localizeUi("ui.agents.agentcatalogview.noPermissions")}
                </p>
              )}
            </div>
          ))}
        </Section>

        {more.length > 0 && (
          <Section title={localizeUi("ui.agents.organizer.moreIn", { section: localizeUi(sectionLabelKey(section)) })}>
            <ul className="grid gap-x-6 md:grid-cols-2">
              {more.map((item) => (
                <AgentRow key={item.manifest.id} entry={item} />
              ))}
            </ul>
          </Section>
        )}
      </div>
    </article>
  );
}
