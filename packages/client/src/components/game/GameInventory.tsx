// Game: Inventory Panel
import { useState, useCallback, useEffect, useRef } from "react";
import {
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Check, ChevronLeft, ChevronRight, Minus, Package, Plus, Scissors, Wand2, X } from "lucide-react";
import { gameInventoryNameKey } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { defaultInventorySplitSize, parseInventoryAmount } from "../../lib/game-inventory-amount";
import { useTranslation as useUiTranslation } from "react-i18next";

/** One stack. Two stacks may hold the same item, so a stack is told apart by its id, never its name. */
export interface InventoryItem {
  id: string;
  name: string;
  quantity: number;
}

interface GameInventoryProps {
  items: InventoryItem[];
  open: boolean;
  onClose: () => void;
  /** Called when the user wants to add a new item. Resolves to the new stack's id. */
  onAddItem?: () => Promise<string | null> | string | null;
  /** Called when the user wants to use an item during input phase */
  onUseItem?: (itemName: string) => void;
  /** Called when the user renames a stack. Resolves to the id of the stack holding the result. */
  onRenameItem?: (stackId: string, nextName: string) => Promise<string | null> | string | null;
  /** Called when the user sets a stack's count: the +1 and -1 buttons, or a typed amount. 0 removes it. */
  onSetItemQuantity?: (stackId: string, quantity: number) => void | Promise<void>;
  /** Called when the user splits part of a stack into a new one. Resolves to the new stack's id. */
  onSplitItem?: (stackId: string, size: number) => Promise<string | null> | string | null;
  /** Called when the user drops a stack onto another stack of the same item. */
  onMergeItems?: (fromId: string, intoId: string) => void | Promise<void>;
  /** Called when the user drags one item onto another to swap their positions */
  onReorderItem?: (fromIndex: number, toIndex: number) => void | Promise<void>;
  /** Whether the player can interact (input phase) */
  canInteract?: boolean;
}

const ITEMS_PER_PAGE = 20;

export function GameInventory({
  items,
  open,
  onClose,
  onAddItem,
  onUseItem,
  onRenameItem,
  onSetItemQuantity,
  onSplitItem,
  onMergeItems,
  onReorderItem,
  canInteract,
}: GameInventoryProps) {
  const { t: localizeUi } = useUiTranslation();
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [addPending, setAddPending] = useState(false);
  const [amountPending, setAmountPending] = useState(false);
  const [amountDraft, setAmountDraft] = useState("");
  const [splitDraft, setSplitDraft] = useState<string | null>(null);
  const [splitPending, setSplitPending] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);

  // Mouse: 4px distance threshold so quick clicks still select.
  // Touch: 200ms hold within 5px so swipe-to-scroll still works on mobile.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const handleItemClick = useCallback((item: InventoryItem) => {
    setSelectedItem((prev) => (prev === item.id ? null : item.id));
  }, []);

  const handleUse = useCallback(
    (itemName: string) => {
      onUseItem?.(itemName);
      setSelectedItem(null);
    },
    [onUseItem],
  );

  // Clear selection if the selected stack was removed
  useEffect(() => {
    if (selectedItem && !items.some((i) => i.id === selectedItem)) {
      setSelectedItem(null);
    }
  }, [items, selectedItem]);

  const selectedInventoryItem = selectedItem ? (items.find((item) => item.id === selectedItem) ?? null) : null;
  const pageCount = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
  const pageStart = pageIndex * ITEMS_PER_PAGE;
  const pageItems = items.slice(pageStart, pageStart + ITEMS_PER_PAGE);

  useEffect(() => {
    setRenameDraft(selectedInventoryItem?.name ?? "");
  }, [selectedInventoryItem?.name]);

  // The amount field shows the stack as it stands whenever it changes or another stack is picked, and
  // a split in progress is dropped with it.
  const selectedStackId = selectedInventoryItem?.id;
  const selectedQuantity = selectedInventoryItem?.quantity;
  useEffect(() => {
    setAmountDraft(selectedQuantity === undefined ? "" : String(selectedQuantity));
  }, [selectedStackId, selectedQuantity]);
  useEffect(() => {
    setSplitDraft(null);
  }, [selectedStackId]);

  useEffect(() => {
    setPageIndex((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  useEffect(() => {
    if (!selectedItem) return;
    const selectedIndex = items.findIndex((item) => item.id === selectedItem);
    if (selectedIndex >= 0) {
      setPageIndex(Math.floor(selectedIndex / ITEMS_PER_PAGE));
    }
  }, [items, selectedItem]);

  const handleRename = useCallback(
    async (item: InventoryItem) => {
      if (!onRenameItem) return;

      const nextName = renameDraft.trim().replace(/\s+/g, " ");
      if (!nextName || nextName === item.name.trim()) return;

      setRenamePending(true);
      try {
        const resolvedId = await onRenameItem(item.id, nextName);
        if (resolvedId) {
          setSelectedItem(resolvedId);
        }
      } finally {
        setRenamePending(false);
      }
    },
    [onRenameItem, renameDraft],
  );

  const handleAdd = useCallback(async () => {
    if (!onAddItem) return;

    setAddPending(true);
    try {
      const addedStackId = await onAddItem();
      if (addedStackId) {
        setSelectedItem(addedStackId);
        setPageIndex(Math.floor(items.length / ITEMS_PER_PAGE));
      }
    } finally {
      setAddPending(false);
    }
  }, [items.length, onAddItem]);

  const setQuantity = useCallback(
    async (item: InventoryItem, quantity: number) => {
      if (!onSetItemQuantity || quantity === item.quantity) return;
      setAmountPending(true);
      try {
        await onSetItemQuantity(item.id, quantity);
      } finally {
        setAmountPending(false);
      }
    },
    [onSetItemQuantity],
  );

  /** What was typed into the amount field: a count, or +N / -N. Emptying a stack of more than one asks
   *  first, since that is the whole pile gone in one keystroke. Enter disables the field while it
   *  saves, which blurs it, and the confirmation takes focus too: one commit runs at a time, so neither
   *  commits the same amount again. */
  const amountCommitting = useRef(false);
  const commitAmount = useCallback(
    async (item: InventoryItem) => {
      if (amountCommitting.current) return;
      const next = parseInventoryAmount(amountDraft, item.quantity);
      if (next === null || next === item.quantity) {
        setAmountDraft(String(item.quantity));
        return;
      }
      amountCommitting.current = true;
      try {
        if (
          next === 0 &&
          item.quantity > 1 &&
          !window.confirm(
            localizeUi("ui.game.gameinventory.removeAllValue1Confirm", { count: item.quantity, value1: item.name }),
          )
        ) {
          setAmountDraft(String(item.quantity));
          return;
        }
        setAmountDraft(String(next));
        await setQuantity(item, next);
      } finally {
        amountCommitting.current = false;
      }
    },
    [amountDraft, localizeUi, setQuantity],
  );

  const commitSplit = useCallback(
    async (item: InventoryItem) => {
      if (!onSplitItem || splitDraft === null) return;
      const size = Number.parseInt(splitDraft, 10);
      if (!Number.isInteger(size) || size < 1 || size >= item.quantity) return;
      setSplitPending(true);
      try {
        const newStackId = await onSplitItem(item.id, size);
        if (newStackId) setSplitDraft(null);
      } finally {
        setSplitPending(false);
      }
    },
    [onSplitItem, splitDraft],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const fromIndex = event.active.data.current?.index;
      const toIndex = event.over?.data.current?.index;
      if (typeof fromIndex !== "number" || typeof toIndex !== "number") return;
      if (fromIndex === toIndex) return;
      // Onto another stack of the same item, the two become one; onto anything else, they swap places.
      const from = items[fromIndex];
      const to = items[toIndex];
      if (onMergeItems && from && to && gameInventoryNameKey(from.name) === gameInventoryNameKey(to.name)) {
        void onMergeItems(from.id, to.id);
        return;
      }
      if (onReorderItem) void onReorderItem(fromIndex, toIndex);
    },
    [items, onMergeItems, onReorderItem],
  );

  if (!open) return null;

  const slots: Array<InventoryItem | null> = [];
  for (let i = 0; i < ITEMS_PER_PAGE; i++) {
    slots.push(pageItems[i] ?? null);
  }

  return (
    <div
      className="fixed inset-y-0 z-[80] flex items-center justify-center bg-black/70 p-3 pb-[max(var(--mari-safe-area-inset-bottom,env(safe-area-inset-bottom)),0.75rem)] pt-[max(env(safe-area-inset-top),0.75rem)] backdrop-blur-sm sm:p-4"
      style={{
        left: "var(--mari-chat-ui-inset-left, 0px)",
        right: "var(--mari-chat-ui-inset-right, 0px)",
      }}
    >
      <div className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-white/10 bg-black shadow-[0_0_40px_rgba(0,0,0,0.8)] supports-[height:100dvh]:max-h-[85dvh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/8 bg-white/[0.02] px-4 py-3">
          <div className="flex items-center gap-2">
            <Package size={15} className="text-amber-400/80" />
            <h2 className="text-sm font-semibold tracking-wide text-white/90">
              {localizeUi("ui.game.gamecharactersheet.inventory")}
            </h2>
            <span className="rounded bg-white/8 px-1.5 py-0.5 text-[0.6rem] tabular-nums text-white/80">
              {items.length}{" "}
              {items.length === 1
                ? localizeUi("ui.game.gameinventory.item")
                : localizeUi("ui.panels.importsettings.items")}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
          >
            <X size={14} />
          </button>
        </div>

        {/* Item list */}
        <div className="flex-1 overflow-y-auto p-3">
          {items.length > 0 ? (
            <>
              {pageCount > 1 && (
                <div className="mb-2 flex items-center justify-between gap-2 text-[0.625rem] text-white/45">
                  <button
                    onClick={() => setPageIndex((page) => Math.max(0, page - 1))}
                    disabled={pageIndex === 0}
                    className="flex h-6 w-6 items-center justify-center rounded border border-white/8 bg-white/[0.03] transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
                    title={localizeUi("ui.game.gameinventory.previousInventoryPage")}
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <span className="tabular-nums">
                    {localizeUi("ui.game.gameinventory.page")} {pageIndex + 1} / {pageCount}
                  </span>
                  <button
                    onClick={() => setPageIndex((page) => Math.min(pageCount - 1, page + 1))}
                    disabled={pageIndex >= pageCount - 1}
                    className="flex h-6 w-6 items-center justify-center rounded border border-white/8 bg-white/[0.03] transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
                    title={localizeUi("ui.game.gameinventory.nextInventoryPage")}
                  >
                    <ChevronRight size={12} />
                  </button>
                </div>
              )}
              <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                <div className="grid grid-cols-5 gap-1.5">
                  {slots.map((item, i) => {
                    const globalIndex = pageStart + i;
                    return (
                      <InventorySlot
                        key={`slot-${globalIndex}`}
                        item={item}
                        globalIndex={globalIndex}
                        selected={Boolean(item && selectedItem === item.id)}
                        reorderEnabled={Boolean(onReorderItem || onMergeItems)}
                        onClick={() => item && handleItemClick(item)}
                      />
                    );
                  })}
                </div>
              </DndContext>
            </>
          ) : (
            <div className="flex min-h-40 flex-col items-center justify-center rounded border border-dashed border-white/10 bg-white/[0.02] px-4 text-center">
              <Package size={18} className="mb-2 text-white/25" />
              <div className="text-[0.75rem] font-medium text-white/55">
                {localizeUi("ui.game.gameinventory.inventoryEmpty")}
              </div>
              <div className="mt-1 text-[0.65rem] text-white/35">
                {localizeUi("ui.game.gameinventory.addAnItemToStartTrackingSupplies")}
              </div>
            </div>
          )}
        </div>

        {/* Action bar */}
        {(selectedItem || onAddItem) && (
          <div className="border-t border-white/8 bg-white/[0.02] px-4 py-2.5">
            {selectedInventoryItem ? (
              <div className="mb-2 whitespace-normal break-words text-[0.7rem] font-medium text-white/60 [overflow-wrap:anywhere]">
                {selectedInventoryItem.name}
              </div>
            ) : (
              <div className="mb-2 text-[0.7rem] font-medium text-white/45">
                {localizeUi("ui.game.gameinventory.addANewItemThenRenameIt")}
              </div>
            )}
            {onRenameItem && selectedInventoryItem && (
              <div className="mb-2.5 flex gap-1.5">
                <input
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setRenameDraft(selectedInventoryItem.name);
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleRename(selectedInventoryItem);
                    }
                  }}
                  disabled={renamePending}
                  className="min-w-0 flex-1 rounded border border-white/10 bg-black/40 px-2 py-1.5 text-[0.7rem] text-white/85 outline-none transition-colors focus:border-amber-400/40"
                  placeholder={localizeUi("ui.game.gameinventory.itemName")}
                />
                <button
                  onClick={() => void handleRename(selectedInventoryItem)}
                  disabled={
                    renamePending || !renameDraft.trim() || renameDraft.trim() === selectedInventoryItem.name.trim()
                  }
                  className="flex shrink-0 items-center justify-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[0.7rem] font-semibold text-amber-300 transition-colors hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Check size={12} />
                  {localizeUi("ui.noodle.noodlehome.save")}
                </button>
              </div>
            )}
            {onSplitItem && selectedInventoryItem && splitDraft !== null && (
              <div className="mb-2.5 flex items-center gap-1.5">
                <label
                  htmlFor="game-inventory-split-size"
                  className="min-w-0 flex-1 text-[0.65rem] leading-tight text-white/55"
                >
                  {localizeUi("ui.game.gameinventory.splitHowMany", { max: selectedInventoryItem.quantity - 1 })}
                </label>
                <input
                  id="game-inventory-split-size"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={selectedInventoryItem.quantity - 1}
                  value={splitDraft}
                  autoFocus
                  onChange={(e) => setSplitDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setSplitDraft(null);
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitSplit(selectedInventoryItem);
                    }
                  }}
                  disabled={splitPending}
                  className="w-16 rounded border border-white/10 bg-black/40 px-2 py-1.5 text-[0.7rem] tabular-nums text-white/85 outline-none transition-colors focus:border-amber-400/40"
                />
                <button
                  onClick={() => void commitSplit(selectedInventoryItem)}
                  disabled={
                    splitPending ||
                    !(
                      Number.parseInt(splitDraft, 10) >= 1 &&
                      Number.parseInt(splitDraft, 10) < selectedInventoryItem.quantity
                    )
                  }
                  className="flex shrink-0 items-center justify-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[0.7rem] font-semibold text-amber-300 transition-colors hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Scissors size={12} />
                  {localizeUi("ui.game.gameinventory.split")}
                </button>
                <button
                  onClick={() => setSplitDraft(null)}
                  className="rounded p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
                  aria-label={localizeUi("ui.game.gameinventory.cancelSplit")}
                  title={localizeUi("ui.game.gameinventory.cancelSplit")}
                >
                  <X size={12} />
                </button>
              </div>
            )}
            <div className="flex gap-1.5">
              {onAddItem && (
                <button
                  onClick={() => void handleAdd()}
                  disabled={addPending}
                  className="flex flex-1 items-center justify-center gap-1 rounded border border-white/8 bg-white/[0.03] py-1.5 text-[0.7rem] text-white/70 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus size={12} />
                  {localizeUi("ui.characters.metadatatab.add")}
                </button>
              )}
              {selectedInventoryItem && onSetItemQuantity && (
                <div
                  className="flex h-7 shrink-0 items-center overflow-hidden rounded border border-white/8 bg-white/[0.03]"
                  aria-label={localizeUi("ui.game.gameinventory.value1AmountControls", {
                    value1: selectedInventoryItem.name,
                  })}
                >
                  <button
                    type="button"
                    onClick={() => void setQuantity(selectedInventoryItem, selectedInventoryItem.quantity - 1)}
                    disabled={amountPending}
                    className="flex h-full w-7 items-center justify-center text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={
                      selectedInventoryItem.quantity > 1
                        ? localizeUi("ui.game.gameinventory.decreaseValue1Amount", {
                            value1: selectedInventoryItem.name,
                          })
                        : localizeUi("ui.game.gameinventory.deleteValue1", { value1: selectedInventoryItem.name })
                    }
                    title={
                      selectedInventoryItem.quantity > 1
                        ? localizeUi("ui.game.gameinventory.decreaseAmount")
                        : localizeUi("ui.game.gameinventory.deleteItem")
                    }
                  >
                    <Minus size={12} />
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={amountDraft}
                    onChange={(e) => setAmountDraft(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => void commitAmount(selectedInventoryItem)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setAmountDraft(String(selectedInventoryItem.quantity));
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitAmount(selectedInventoryItem);
                      }
                    }}
                    disabled={amountPending}
                    aria-label={localizeUi("ui.game.gameinventory.value1Amount", {
                      value1: selectedInventoryItem.name,
                    })}
                    title={localizeUi("ui.game.gameinventory.amountHint")}
                    className="h-full w-14 border-x border-white/8 bg-transparent px-1 text-center text-[0.7rem] font-semibold tabular-nums text-white/80 outline-none focus:bg-white/[0.05]"
                  />
                  <button
                    type="button"
                    onClick={() => void setQuantity(selectedInventoryItem, selectedInventoryItem.quantity + 1)}
                    disabled={amountPending}
                    className="flex h-full w-7 items-center justify-center text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={localizeUi("ui.game.gameinventory.increaseValue1Amount", {
                      value1: selectedInventoryItem.name,
                    })}
                    title={localizeUi("ui.game.gameinventory.increaseAmount")}
                  >
                    <Plus size={12} />
                  </button>
                </div>
              )}
              {selectedInventoryItem && onSplitItem && selectedInventoryItem.quantity > 1 && splitDraft === null && (
                <button
                  type="button"
                  onClick={() => setSplitDraft(String(defaultInventorySplitSize(selectedInventoryItem.quantity)))}
                  className="flex h-7 shrink-0 items-center justify-center gap-1 rounded border border-white/8 bg-white/[0.03] px-2 text-[0.7rem] text-white/70 transition-colors hover:bg-white/[0.06]"
                  aria-label={localizeUi("ui.game.gameinventory.splitValue1", { value1: selectedInventoryItem.name })}
                  title={localizeUi("ui.game.gameinventory.splitStack")}
                >
                  <Scissors size={12} />
                  {localizeUi("ui.game.gameinventory.split")}
                </button>
              )}
              {selectedInventoryItem && canInteract && onUseItem && (
                <button
                  onClick={() => handleUse(selectedInventoryItem.name)}
                  className="flex flex-1 items-center justify-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 py-1.5 text-[0.7rem] font-semibold text-amber-400 transition-colors hover:bg-amber-500/15"
                >
                  <Wand2 size={12} />
                  {localizeUi("ui.agents.agenteditor.use")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface InventorySlotProps {
  item: InventoryItem | null;
  globalIndex: number;
  selected: boolean;
  reorderEnabled: boolean;
  onClick: () => void;
}

function InventorySlot({ item, globalIndex, selected, reorderEnabled, onClick }: InventorySlotProps) {
  const { t: localizeUi } = useUiTranslation();
  const enabled = reorderEnabled && Boolean(item);
  const slotData = { index: globalIndex };
  const {
    setNodeRef: setDragRef,
    attributes,
    listeners,
    isDragging,
  } = useDraggable({ id: `slot-drag-${globalIndex}`, data: slotData, disabled: !enabled });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `slot-drop-${globalIndex}`,
    data: slotData,
    disabled: !enabled,
  });
  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );

  return (
    <button
      ref={setRefs}
      {...attributes}
      {...listeners}
      onClick={onClick}
      disabled={!item}
      title={
        item
          ? item.quantity > 1
            ? localizeUi("ui.game.inventoryslot.value1Value2", { value1: item.name, value2: item.quantity })
            : item.name
          : undefined
      }
      aria-label={
        item
          ? item.quantity > 1
            ? localizeUi("ui.game.inventoryslot.value1XValue2", { value1: item.name, value2: item.quantity })
            : item.name
          : undefined
      }
      aria-pressed={enabled ? isDragging : undefined}
      className={cn(
        "group relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded border transition-all",
        // touch-action: none lets the TouchSensor activate without browser scroll-gestures stealing the touch.
        // Scrolling the inventory panel is still possible by touching the modal background / pagination row.
        enabled && "touch-none",
        item
          ? selected
            ? "border-amber-500/50 bg-amber-500/10 shadow-[inset_0_0_12px_rgba(245,158,11,0.08)]"
            : "border-white/8 bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.06]"
          : "cursor-default border-white/5 bg-white/[0.015]",
        enabled && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
        isOver && !isDragging && "border-amber-400/70 ring-2 ring-amber-400/60",
      )}
    >
      {item && (
        <>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gradient-to-b from-white/8 to-white/[0.02] text-sm font-bold text-amber-400/80 ring-1 ring-white/8">
            {item.name.charAt(0).toUpperCase()}
          </div>
          <div className="mt-1 flex min-h-0 w-full min-w-0 flex-1 flex-col items-center justify-center px-1">
            <div className="flex max-h-full min-h-0 w-full min-w-0 flex-col items-center gap-0.5 overflow-hidden max-md:overflow-y-auto max-md:overscroll-contain max-md:touch-pan-y">
              <span className="block w-full whitespace-normal break-words text-center text-[0.58rem] font-medium leading-tight text-white/80 [overflow-wrap:anywhere]">
                {item.name}
              </span>
              {item.quantity > 1 && (
                <span className="shrink-0 rounded bg-white/15 px-1.5 py-0.5 text-[0.55rem] font-semibold tabular-nums text-white">
                  {localizeUi("ui.panels.imagedimensionrow.x")}
                  {item.quantity}
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </button>
  );
}
