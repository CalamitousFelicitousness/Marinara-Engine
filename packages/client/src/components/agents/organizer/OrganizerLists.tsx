import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { compareCapabilityPackageVersions } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useCapabilityPackageReleaseNotes } from "../../../hooks/use-capability-packages";
import { cn } from "../../../lib/utils";
import { AgentReleaseNoteList } from "../AgentReleaseNoteList";
import {
  formatBytes,
  hasUpdate,
  sectionHintKey,
  sectionLabelKey,
  typeLabelKey,
  typeOf,
  type OrganizerEntry,
  type OrganizerSectionId,
} from "./organizer-model";
import { AgentRow, IconStack, PRIMARY_ACTION, useOrganizer } from "./OrganizerParts";

function PageHeader({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-xl font-bold text-[var(--foreground)]">{title}</h2>
        {hint && <p className="text-sm text-[var(--muted-foreground)]">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-sm text-[var(--muted-foreground)]">{children}</p>;
}

export function SectionPage({ section, entries }: { section: OrganizerSectionId; entries: readonly OrganizerEntry[] }) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <div>
      <PageHeader title={localizeUi(sectionLabelKey(section))} hint={localizeUi(sectionHintKey(section))}>
        <span className="text-xs text-[var(--muted-foreground)]">
          {localizeUi("ui.agents.organizer.agentCount", { count: entries.length })}
        </span>
      </PageHeader>
      {entries.length === 0 ? (
        <EmptyLine>{localizeUi("ui.agents.organizer.emptySection")}</EmptyLine>
      ) : (
        <ul className="grid gap-x-6 md:grid-cols-2">
          {entries.map((entry) => (
            <AgentRow key={entry.manifest.id} entry={entry} withMenu />
          ))}
        </ul>
      )}
    </div>
  );
}

export function InstalledPage({ entries }: { entries: readonly OrganizerEntry[] }) {
  const { installedById } = useOrganizer();
  const { t: localizeUi } = useUiTranslation();
  const rows = entries.filter((entry) => installedById.has(entry.manifest.id));
  return (
    <div>
      <PageHeader
        title={localizeUi("ui.agents.organizer.installedTitle")}
        hint={localizeUi("ui.agents.organizer.agentCount", { count: rows.length })}
      />
      {rows.length === 0 ? (
        <EmptyLine>{localizeUi("ui.agents.organizer.emptyInstalled")}</EmptyLine>
      ) : (
        <ul>
          {rows.map((entry) => {
            const installed = installedById.get(entry.manifest.id)!;
            const update = hasUpdate(entry, installed);
            return (
              <AgentRow
                key={entry.manifest.id}
                entry={entry}
                withMenu
                side={formatBytes(entry.artifact.bytes)}
                meta={
                  <>
                    {localizeUi(typeLabelKey(typeOf(entry)))} · {installed.version}
                    {update && (
                      <span className="font-semibold text-[var(--marinara-chat-chrome-accent,var(--primary))]">
                        {" "}
                        → {entry.manifest.version}
                      </span>
                    )}
                  </>
                }
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Notes for the versions newer than the installed one; fetched only once opened. */
function UpdateNotes({ entry, installedVersion }: { entry: OrganizerEntry; installedVersion: string }) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const { data } = useCapabilityPackageReleaseNotes(entry.manifest.id, open);
  const notes = (data ?? []).filter((note) => compareCapabilityPackageVersions(note.version, installedVersion) > 0);
  return (
    <div className="pb-3 pl-[3.75rem]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-md text-xs font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        {open ? <ChevronDown size="0.8rem" aria-hidden="true" /> : <ChevronRight size="0.8rem" aria-hidden="true" />}
        {localizeUi("ui.agents.agentupdatedialog.whatChanged")}
      </button>
      {open &&
        (notes.length > 0 ? (
          <div className="mt-2">
            <AgentReleaseNoteList entries={notes} clamp={notes.length > 1} />
          </div>
        ) : (
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">{localizeUi("ui.agents.organizer.noNotes")}</p>
        ))}
    </div>
  );
}

export function UpdatesPage({ entries, onUpdateAll }: { entries: readonly OrganizerEntry[]; onUpdateAll: () => void }) {
  const { installedById, pending } = useOrganizer();
  const { t: localizeUi } = useUiTranslation();
  const rows = entries.filter((entry) => hasUpdate(entry, installedById.get(entry.manifest.id)));
  return (
    <div>
      <PageHeader
        title={localizeUi("ui.agents.organizer.updatesTitle")}
        hint={rows.length > 0 ? localizeUi("ui.agents.organizer.updatesReady", { count: rows.length }) : undefined}
      >
        {rows.length > 1 && (
          <button
            type="button"
            className={cn(PRIMARY_ACTION, "h-9 gap-2 px-4 text-sm font-semibold")}
            disabled={pending}
            onClick={onUpdateAll}
          >
            <IconStack entries={rows} />
            {localizeUi("ui.agents.organizer.updateAll")}
          </button>
        )}
      </PageHeader>
      {rows.length === 0 ? (
        <EmptyLine>{localizeUi("ui.agents.organizer.emptyUpdates")}</EmptyLine>
      ) : (
        <ul>
          {rows.map((entry) => {
            const installedVersion = installedById.get(entry.manifest.id)!.version;
            return (
              <AgentRow
                key={entry.manifest.id}
                entry={entry}
                meta={`${localizeUi("ui.agents.organizer.versionChange", { from: installedVersion, to: entry.manifest.version })}${
                  entry.manifest.restartRequired
                    ? ` · ${localizeUi("ui.agents.agentupdatedialog.restartRequired")}`
                    : ""
                }`}
              >
                <UpdateNotes entry={entry} installedVersion={installedVersion} />
              </AgentRow>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function SearchResults({ query, entries }: { query: string; entries: readonly OrganizerEntry[] }) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <div>
      <PageHeader
        title={localizeUi("ui.agents.organizer.resultsFor", { query })}
        hint={localizeUi("ui.agents.organizer.agentCount", { count: entries.length })}
      />
      {entries.length === 0 ? (
        <EmptyLine>{localizeUi("ui.agents.agentcatalogview.noMatchingAgents")}</EmptyLine>
      ) : (
        <ul className="grid gap-x-6 md:grid-cols-2">
          {entries.map((entry) => (
            <AgentRow key={entry.manifest.id} entry={entry} withMenu />
          ))}
        </ul>
      )}
    </div>
  );
}
