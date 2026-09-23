import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Braces, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation as useUiTranslation } from "react-i18next";
import { MAX_CHAT_VARIABLE_VALUE_LENGTH, validateChatVariableName } from "@marinara-engine/shared";
import { ChatSettingsSection } from "../ChatSettingsSection";
import { chatKeys, useUpdateChatMetadata } from "../../../hooks/use-chats";
import { useUIStore } from "../../../stores/ui.store";
import { cn } from "../../../lib/utils";

interface ChatVariablesSectionProps {
  sectionId: string;
  order: number;
  chatId: string;
  /** The chat's saved macro variables, including any a prompt or lorebook set. */
  variables: Record<string, string>;
}

interface VariableRow {
  /** Stable key so a rename does not remount the row and drop focus. */
  key: string;
  name: string;
  value: string;
  /** The name this row is saved under, or null while it is still a draft. */
  savedName: string | null;
}

// Passed through interpolation rather than written into the locale string:
// i18next would read a literal {{char1}} in the copy as a placeholder.
const EXAMPLE_TAG = "{{char1}}";

let rowKeySeed = 0;
const nextRowKey = () => `chat-variable-${(rowKeySeed += 1)}`;

function toRows(variables: Record<string, string>): VariableRow[] {
  return Object.entries(variables)
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => ({ key: nextRowKey(), name, value, savedName: name }));
}

export function ChatVariablesSection({ sectionId, order, chatId, variables }: ChatVariablesSectionProps) {
  const { t: localizeUi } = useUiTranslation();
  const qc = useQueryClient();
  // Serialized: a row's name and value can be committed back to back, and both
  // land in the same metadata key.
  const updateMeta = useUpdateChatMetadata({ serialize: true });
  const expanded = useUIStore((s) => s.chatSettingsExpandedSections[sectionId]);

  const [rows, setRows] = useState<VariableRow[]>(() => toRows(variables));
  const [pendingWrites, setPendingWrites] = useState(0);

  // A patch carries only the names it changes, so the cached map is partial
  // until the server answers. Re-seed from props only while nothing is in
  // flight — that is also when a {{setvar}} from a generation shows up.
  // The signature, not the object, is the dependency: an unrelated metadata
  // write hands us an equal map with a new identity, and re-seeding then would
  // discard a row the user is still typing.
  const savedSignature = useMemo(() => JSON.stringify(variables), [variables]);
  useEffect(() => {
    if (pendingWrites > 0) return;
    const saved = JSON.parse(savedSignature) as Record<string, string>;
    setRows((current) => [...toRows(saved), ...current.filter((row) => row.savedName === null)]);
  }, [savedSignature, pendingWrites]);

  // Nothing invalidates the chat after a generation persists a {{setvar}} —
  // that write deliberately leaves updatedAt alone. Refetch when the user
  // opens the section so the list is not stale.
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (expanded && !wasExpanded.current) void qc.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
    wasExpanded.current = Boolean(expanded);
  }, [expanded, chatId, qc]);

  const save = useCallback(
    (patch: Record<string, string | null>) => {
      setPendingWrites((count) => count + 1);
      void updateMeta
        .mutateAsync({ id: chatId, macroVariables: patch })
        .catch(() => undefined)
        .finally(() => setPendingWrites((count) => count - 1));
    },
    [chatId, updateMeta],
  );

  const nameIssue = useCallback(
    (row: VariableRow) =>
      validateChatVariableName(
        row.name,
        rows.filter((other) => other.key !== row.key).map((other) => other.name.trim()),
      ),
    [rows],
  );

  const updateRow = (key: string, patch: Partial<VariableRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const commitRow = (key: string) => {
    const row = rows.find((entry) => entry.key === key);
    if (!row) return;
    const name = row.name.trim();
    if (nameIssue(row)) return;
    if (row.savedName === name && variables[name] === row.value) return;
    // A rename is one patch: drop the old name and write the new one together,
    // so a failure cannot leave both or neither.
    const patch: Record<string, string | null> = { [name]: row.value };
    if (row.savedName && row.savedName !== name) patch[row.savedName] = null;
    updateRow(key, { name, savedName: name });
    save(patch);
  };

  const removeRow = (key: string) => {
    const row = rows.find((entry) => entry.key === key);
    setRows((current) => current.filter((entry) => entry.key !== key));
    if (row?.savedName) save({ [row.savedName]: null });
  };

  const issueMessage = (issue: ReturnType<typeof validateChatVariableName>) => {
    if (issue === "reserved") return localizeUi("ui.chatSettings.chatvariablessection.thatNameBelongsToABuiltInMacro");
    if (issue === "duplicate")
      return localizeUi("ui.chatSettings.chatvariablessection.thatNameIsAlreadyUsedInThisChat");
    if (issue === "format")
      return localizeUi("ui.chatSettings.chatvariablessection.useLettersNumbersAndUnderscoresStartingWithA");
    return null;
  };

  return (
    <ChatSettingsSection
      id={sectionId}
      style={{ order }}
      label={localizeUi("ui.chatSettings.chatvariablessection.chatVariables")}
      icon={<Braces size="0.875rem" />}
      count={rows.filter((row) => row.savedName !== null).length}
      help={localizeUi("ui.chatSettings.chatvariablessection.typeTheNameInDoubleBracesInAnyMessageThe", {
        example: EXAMPLE_TAG,
      })}
    >
      <div className="space-y-2">
        {rows.length === 0 ? (
          <p className="px-1 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.chatSettings.chatvariablessection.noVariablesYetAddOneNamedChar1WithTheValue", {
              example: EXAMPLE_TAG,
            })}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {rows.map((row) => {
              const issue = nameIssue(row);
              const message = issueMessage(issue);
              return (
                <div key={row.key} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <input
                      value={row.name}
                      onChange={(e) => updateRow(row.key, { name: e.target.value })}
                      onBlur={() => commitRow(row.key)}
                      onKeyDown={(e) => e.key === "Enter" && commitRow(row.key)}
                      aria-label={localizeUi("ui.chatSettings.chatvariablessection.variableName")}
                      aria-invalid={issue !== null}
                      placeholder={localizeUi("ui.chatSettings.chatvariablessection.name")}
                      className={cn(
                        "mari-chrome-field min-w-0 basis-1/3 !rounded-md px-3 py-2 text-xs",
                        issue && "ring-1 ring-[var(--destructive)]",
                      )}
                    />
                    <input
                      value={row.value}
                      maxLength={MAX_CHAT_VARIABLE_VALUE_LENGTH}
                      onChange={(e) => updateRow(row.key, { value: e.target.value })}
                      onBlur={() => commitRow(row.key)}
                      onKeyDown={(e) => e.key === "Enter" && commitRow(row.key)}
                      aria-label={localizeUi("ui.chatSettings.chatvariablessection.variableValue")}
                      placeholder={localizeUi("ui.chatSettings.chatvariablessection.value")}
                      className="mari-chrome-field min-w-0 flex-1 !rounded-md px-3 py-2 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(row.key)}
                      title={localizeUi("ui.chatSettings.chatvariablessection.removeVariable")}
                      aria-label={localizeUi("ui.chatSettings.chatvariablessection.removeVariable")}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)]/15 hover:text-[var(--destructive)]"
                    >
                      <Trash2 size="0.6875rem" />
                    </button>
                  </div>
                  {message && <p className="px-1 text-[0.625rem] text-[var(--destructive)]">{message}</p>}
                </div>
              );
            })}
          </div>
        )}
        <button
          type="button"
          onClick={() =>
            setRows((current) => [...current, { key: nextRowKey(), name: "", value: "", savedName: null }])
          }
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)] transition-colors hover:border-[var(--primary)]/40 hover:text-[var(--primary)]"
        >
          <Plus size="0.75rem" /> {localizeUi("ui.chatSettings.chatvariablessection.addVariable")}
        </button>
        <p className="px-1 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {localizeUi("ui.chatSettings.chatvariablessection.aPromptSectionOrLorebookEntryThatSetsA")}
        </p>
      </div>
    </ChatSettingsSection>
  );
}
