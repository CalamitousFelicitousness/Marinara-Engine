import type { ReactNode } from "react";
import { Backpack, X } from "lucide-react";
import {
  isTrackerFieldLocked,
  removeTrackerFieldLockPrefix,
  renameTrackerFieldLockPrefix,
  roleplayInventoryTrackerLockKey,
  roleplayInventoryTrackerRowLockPrefix,
  type InventoryTrackerGroup,
  type InventoryTrackerRow,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { InlineEdit, InlineNumber } from "../controls/InlineControls";
import { TrackerReadabilityVeil } from "../controls/TrackerProfileChrome";
import { AddRowButton, EmptySection, SectionHeader } from "../controls/SectionControls";
import { useTrackerLockContext } from "../TrackerLockContext";

type InventoryGroupProps = {
  group: InventoryTrackerGroup;
  label: string;
  rows: InventoryTrackerRow[];
  onUpdate: (rows: InventoryTrackerRow[]) => void;
  deleteMode: boolean;
  addMode: boolean;
};

function InventoryGroup({ group, label, rows, onUpdate, deleteMode, addMode }: InventoryGroupProps) {
  const { t: localizeUi } = useUiTranslation();
  const { fieldLocks, lockMode, onToggleFieldLock, onUpdateFieldLocks } = useTrackerLockContext();
  const updateRow = (index: number, row: InventoryTrackerRow) => {
    const previous = rows[index];
    if (previous && previous.name !== row.name) {
      onUpdateFieldLocks?.((locks) =>
        renameTrackerFieldLockPrefix(
          locks,
          roleplayInventoryTrackerRowLockPrefix(group, previous, index),
          roleplayInventoryTrackerRowLockPrefix(group, row, index),
        ),
      );
    }
    const next = [...rows];
    next[index] = row;
    onUpdate(next);
  };
  const removeRow = (index: number) => {
    onUpdateFieldLocks?.((locks) =>
      removeTrackerFieldLockPrefix(locks, roleplayInventoryTrackerRowLockPrefix(group, rows[index]!, index)),
    );
    onUpdate(rows.filter((_, rowIndex) => rowIndex !== index));
  };

  return (
    <div className="min-w-0 border-b border-[var(--border)]/25 p-1.5 @min-[360px]:border-b-0 @min-[360px]:border-r last:border-0">
      <div className="mb-1 flex min-h-6 items-center justify-between gap-1 px-0.5">
        <span className="truncate text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
          {label}
        </span>
        {addMode && (
          <AddRowButton
            title={localizeUi("ui.trackerPanel.inventoryTracker.addToGroup", { group: label })}
            onClick={() => onUpdate([...rows, { name: localizeUi("ui.trackerPanel.inventoryTracker.newItem") }])}
            className="h-5 min-h-5 w-5 min-w-5"
          />
        )}
      </div>
      <div className="space-y-1">
        {rows.length === 0 && (
          <EmptySection>{localizeUi("ui.trackerPanel.inventoryTracker.emptyGroup")}</EmptySection>
        )}
        {rows.map((row, index) => {
          const nameKey = roleplayInventoryTrackerLockKey(group, row, "name", index);
          const qtyKey = roleplayInventoryTrackerLockKey(group, row, "qty", index);
          return (
            <div
              key={`${row.name}-${index}`}
              className="relative grid min-h-6 grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-1 rounded-sm border border-[var(--tracker-profile-slot-rule)] bg-[image:var(--tracker-profile-slot-surface)] px-1 shadow-[inset_0_1px_2px_var(--tracker-profile-slot-shadow)]"
            >
              <InlineEdit
                value={row.name}
                onSave={(name) => updateRow(index, { ...row, name: name || localizeUi("ui.trackerPanel.inventoryTracker.item") })}
                placeholder={localizeUi("ui.trackerPanel.inventoryTracker.item")}
                className="min-w-0 px-0.5 text-[0.625rem] font-medium"
                showEditHint={false}
                scrollOnHover
                locked={isTrackerFieldLocked(fieldLocks, nameKey)}
                lockMode={lockMode}
                onToggleLock={() => onToggleFieldLock?.(nameKey)}
              />
              <InlineNumber
                value={row.qty ?? 1}
                min={1}
                onChange={(qty) => updateRow(index, qty > 1 ? { ...row, qty } : { name: row.name })}
                className="px-0 text-right text-[0.625rem] tabular-nums"
                title={localizeUi("ui.trackerPanel.inventoryTracker.quantityFor", { item: row.name })}
                locked={isTrackerFieldLocked(fieldLocks, qtyKey)}
                lockMode={lockMode}
                onToggleLock={() => onToggleFieldLock?.(qtyKey)}
              />
              {deleteMode && (
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--background)] text-[var(--destructive)] ring-1 ring-[var(--border)]"
                  title={localizeUi("ui.trackerPanel.inventoryTracker.removeItem", { item: row.name })}
                  aria-label={localizeUi("ui.trackerPanel.inventoryTracker.removeItem", { item: row.name })}
                >
                  <X size="0.5625rem" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function InventoryTrackerPanel({
  currencies,
  equipped,
  inventory,
  action,
  onUpdateCurrencies,
  onUpdateEquipped,
  onUpdateInventory,
  deleteMode,
  addMode,
  collapsed = false,
  onToggleCollapsed,
}: {
  currencies: InventoryTrackerRow[];
  equipped: InventoryTrackerRow[];
  inventory: InventoryTrackerRow[];
  action?: ReactNode;
  onUpdateCurrencies: (rows: InventoryTrackerRow[]) => void;
  onUpdateEquipped: (rows: InventoryTrackerRow[]) => void;
  onUpdateInventory: (rows: InventoryTrackerRow[]) => void;
  deleteMode: boolean;
  addMode: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <section className="relative z-10 overflow-hidden border-b border-[var(--border)] bg-[var(--tracker-panel-section-background,color-mix(in_srgb,var(--card)_10%,transparent))]">
      <TrackerReadabilityVeil strength="strong" />
      <div className="relative z-10">
        <SectionHeader
          icon={<Backpack size="0.6875rem" />}
          title={localizeUi("ui.trackerPanel.inventoryTracker.title")}
          badge={currencies.length + equipped.length + inventory.length}
          action={action}
          collapsed={collapsed}
          onToggle={onToggleCollapsed}
        />
        {!collapsed && (
          <div className="grid grid-cols-1 @min-[360px]:grid-cols-3">
            <InventoryGroup
              group="currencies"
              label={localizeUi("ui.trackerPanel.inventoryTracker.currencies")}
              rows={currencies}
              onUpdate={onUpdateCurrencies}
              deleteMode={deleteMode}
              addMode={addMode}
            />
            <InventoryGroup
              group="equipped"
              label={localizeUi("ui.trackerPanel.inventoryTracker.equipped")}
              rows={equipped}
              onUpdate={onUpdateEquipped}
              deleteMode={deleteMode}
              addMode={addMode}
            />
            <InventoryGroup
              group="inventory"
              label={localizeUi("ui.trackerPanel.inventoryTracker.inventory")}
              rows={inventory}
              onUpdate={onUpdateInventory}
              deleteMode={deleteMode}
              addMode={addMode}
            />
          </div>
        )}
      </div>
    </section>
  );
}
