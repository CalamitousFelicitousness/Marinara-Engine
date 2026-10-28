import { ChevronRight } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RESULT_TYPE_ICONS, resourceResultType } from "../../../lib/command-icons";
import type { ReferenceGroupId, RankedReferenceItem } from "../../../lib/mari-composer-references";
import { MariRow } from "../mari-primitives";

export type MariReferencePickerProps = {
  /** The listbox id; the textarea points at the active option with `aria-activedescendant`. */
  id: string;
  rows: readonly RankedReferenceItem[];
  activeIndex: number;
  /** Showing one lorebook's entries instead of the groups. */
  drilled: boolean;
  onPick: (index: number) => void;
  onDrill: (index: number) => void;
};

export const referenceOptionId = (listboxId: string, index: number) => `${listboxId}-option-${index}`;

/**
 * The `@` picker above Professor Mari's composer: one column of grouped rows (characters, personas,
 * lorebooks, presets), narrow enough for a phone and her 24rem companion pane. The textarea keeps focus and
 * owns the keys (see `composerKeyAction`); the rows only draw the choice and take a tap or click.
 */
export function MariReferencePicker({ id, rows, activeIndex, drilled, onPick, onDrill }: MariReferencePickerProps) {
  const { t } = useTranslation();
  const groupLabels: Record<ReferenceGroupId, string> = {
    open: t("mari.composerReferences.group.open"),
    character: t("mari.composerReferences.group.character"),
    persona: t("mari.composerReferences.group.persona"),
    lorebook: t("mari.composerReferences.group.lorebook"),
    preset: t("mari.composerReferences.group.preset"),
    lorebookEntry: t("mari.composerReferences.group.lorebookEntry"),
  };
  useEffect(() => {
    document.getElementById(referenceOptionId(id, activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id]);

  // Rows arrive grouped; a heading starts each run.
  const groups: Array<{ group: ReferenceGroupId; start: number; rows: RankedReferenceItem[] }> = [];
  rows.forEach((row, index) => {
    const last = groups[groups.length - 1];
    if (last?.group === row.group) last.rows.push(row);
    else groups.push({ group: row.group, start: index, rows: [row] });
  });

  return (
    <div
      id={id}
      role="listbox"
      aria-label={t("mari.composerReferences.listLabel")}
      className="mari-composer-menu__popover mari-reference-picker"
      data-component="MariReferencePicker"
      // Taps on the list must not steal focus from the textarea.
      onMouseDown={(event) => event.preventDefault()}
    >
      {groups.map((group) => (
        <div key={`${group.group}:${group.start}`} role="group" aria-labelledby={`${id}-group-${group.start}`}>
          <p id={`${id}-group-${group.start}`} className="mari-composer-menu__head">
            {groupLabels[group.group]}
          </p>
          {group.rows.map((row, offset) => {
            const index = group.start + offset;
            const Icon = RESULT_TYPE_ICONS[resourceResultType(row.ref.kind)];
            return (
              <MariRow
                key={row.key}
                id={referenceOptionId(id, index)}
                role="option"
                aria-selected={index === activeIndex}
                slot={<Icon aria-hidden="true" />}
                title={row.ref.label}
                fact={row.group === "open" ? t("mari.composerReferences.openFact") : undefined}
                state={index === activeIndex ? "selected" : undefined}
                onClick={() => onPick(index)}
                action={
                  row.group === "lorebook" && !drilled ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="mari-reference-picker__drill"
                      aria-label={t("mari.composerReferences.showEntries", { name: row.ref.label })}
                      title={t("mari.composerReferences.showEntries", { name: row.ref.label })}
                      onClick={() => onDrill(index)}
                    >
                      <ChevronRight aria-hidden="true" />
                    </button>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
