// ──────────────────────────────────────────────
// Chat: Roleplay HUD — immersive world-state widgets
// Each tracker category gets its own mini widget with
// a compact preview and expandable editable popover.
// Uses a compact horizontal strip with bottom popovers.
// ──────────────────────────────────────────────
import { Suspense, lazy, useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { MapPin, Users, Backpack, Scroll, Swords, RefreshCw, BarChart3, SlidersHorizontal } from "lucide-react";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api-client";
import { TrackerPanelIcon } from "../ui/TrackerPanelIcon";
import { WorldCalendarIcon } from "../ui/WorldCalendarIcon";
import { WorldClockIcon, WorldThermometerIcon } from "../ui/WorldStateInstruments";
import { useGameStateStore } from "../../stores/game-state.store";
import { useAgentStore } from "../../stores/agent.store";
import { useGameStatePatcher } from "../../hooks/use-game-state-patcher";
import { useUIStore } from "../../stores/ui.store";
import { useReducedAmbientEffects } from "../../hooks/use-reduced-ambient-effects";
import {
  partitionTrackerCapabilityPackages,
  useInstalledCapabilityPackages,
} from "../../hooks/use-capability-packages";
import { CapabilityElement } from "../capabilities/CapabilityElement";
import {
  classifyWorldWeather,
  getLocationPinColor,
  getTemperatureGaugeDisplay,
  getWorldDateDisplay,
  getWorldTimeDisplay,
  type WorldWeatherFamily,
} from "../../lib/world-state-helpers";
import { TrackerLockProvider, useTrackerLockContext } from "../../features/tracker-panel/components/TrackerLockContext";
import { buildInventoryTrackerEditPatch } from "../../features/tracker-panel/lib/inventory-tracker-edit";
import { useTrackerFieldLockUpdater } from "../../features/tracker-panel/hooks/use-tracker-field-lock-updater";
import { NEUTRAL_PANEL_SCROLL_AREA, NEUTRAL_PANEL_SHELL } from "../ui/neutral-surface-styles";
import {
  CHAT_TOOLBAR_ICON_GAP_CLASS,
  CHAT_TOOLBAR_MOBILE_OVERFLOW_HEIGHT_CLASS,
  getChatToolbarButtonClass,
} from "./ChatToolbarControls";
import type {
  GameState,
  PresentCharacter,
  CharacterStat,
  InventoryTrackerGroup,
  InventoryTrackerRow,
  QuestProgress,
  CustomTrackerField,
  WorldCustomField,
  TrackerHiddenFields,
  InstalledCapabilityPackage,
} from "@marinara-engine/shared";
import {
  isNamedTrackerRow,
  normalizeTrackerFieldLocksForState,
  normalizeTrackerHiddenFields,
  toggleTrackerFieldLock,
} from "@marinara-engine/shared";
import type { TrackerTemperatureUnit } from "../../stores/ui.store";
import { useTranslation as useUiTranslation } from "react-i18next";

const EMPTY_AGENT_TYPE_SET = new Set<string>();

interface RoleplayHUDProps {
  chatId: string;
  isStreaming: boolean;
  onRetriggerTrackers?: () => void;
  /** Re-run one tracker agent only (same pipeline as full tracker run). */
  onRerunSingleTracker?: (agentType: string) => void;
  /** When true, tracker agents are manual — show a trigger button in the widget strip */
  manualTrackers?: boolean;
  /** When provided, overrides the globally-computed set so that only per-chat agents show widgets. */
  enabledAgentTypes?: Set<string>;
}

const CombinedPlayerPanel = lazy(async () =>
  import("./RoleplayHUDPanels").then((module) => ({ default: module.CombinedPlayerPanel })),
);
const CombinedWorldPanel = lazy(async () =>
  import("./RoleplayHUDPanels").then((module) => ({ default: module.CombinedWorldPanel })),
);

/** Installed tracker packages the chat runs that draw in the Roleplay HUD. */
export function selectRoleplayTrackerPackages(
  installed: readonly InstalledCapabilityPackage[],
  enabledAgentTypes: Set<string>,
) {
  return installed.filter(
    (item) =>
      item.status === "active" &&
      enabledAgentTypes.has(item.id) &&
      Boolean(item.manifest.entrypoints.client) &&
      item.manifest.contributions?.slots?.includes("roleplay-tracker"),
  );
}

/**
 * Live tracker values and their edit handlers, shared by the HUD and the Tracker window. Each caller
 * passes its own `registrationId` so their pending edits flush independently.
 */
export function useRoleplayTrackerState(chatId: string, enabledAgentTypes: Set<string>, registrationId: string) {
  const [lockMode, setLockMode] = useState(false);
  const gameState = useGameStateStore((s) => s.current);
  const { patchField, patchPlayerStats, patchPlayerStatsMany } = useGameStatePatcher(chatId, registrationId);
  const { data: installedCapabilities = [] } = useInstalledCapabilityPackages();
  const packages = partitionTrackerCapabilityPackages(
    selectRoleplayTrackerPackages(installedCapabilities, enabledAgentTypes),
  );

  const playerStats = gameState?.playerStats ?? null;
  // Editing one group can rewrite two, so this must land as a single patch.
  const editInventoryTracker = (group: InventoryTrackerGroup, rows: InventoryTrackerRow[]) =>
    patchPlayerStatsMany((current) => buildInventoryTrackerEditPatch(current, group, rows));
  const fieldLocks = gameState ? normalizeTrackerFieldLocksForState(gameState.fieldLocks, gameState) : null;
  const hiddenTrackerFields = gameState ? normalizeTrackerHiddenFields(gameState.hiddenTrackerFields) : null;
  const updateFieldLocks = useTrackerFieldLockUpdater({ chatId, fieldLocks, patchField });
  const updateHiddenTrackerFields = useCallback(
    (updater: (hiddenFields: TrackerHiddenFields | null | undefined) => TrackerHiddenFields) => {
      const latestState = useGameStateStore.getState().current;
      const base =
        latestState?.chatId === chatId
          ? normalizeTrackerHiddenFields(latestState.hiddenTrackerFields)
          : hiddenTrackerFields;
      patchField("hiddenTrackerFields", updater(base));
    },
    [chatId, hiddenTrackerFields, patchField],
  );
  const toggleFieldLock = useCallback(
    (key: string) => {
      updateFieldLocks((locks) => toggleTrackerFieldLock(locks, key));
    },
    [updateFieldLocks],
  );

  return {
    packages,
    patchField,
    patchPlayerStats,
    editInventoryTracker,
    date: gameState?.date ?? null,
    time: gameState?.time ?? null,
    location: gameState?.location ?? null,
    weather: gameState?.weather ?? null,
    temperature: gameState?.temperature ?? null,
    worldCustomFields: Array.isArray(gameState?.worldCustomFields) ? gameState.worldCustomFields : [],
    presentCharacters: gameState?.presentCharacters ?? [],
    personaStatBars: gameState?.personaStats ?? [],
    personaStatus: playerStats?.status ?? "",
    activeQuests: playerStats?.activeQuests ?? [],
    customTrackerFields: Array.isArray(playerStats?.customTrackerFields)
      ? playerStats.customTrackerFields.filter(isNamedTrackerRow)
      : [],
    inventoryTrackerCurrencies: playerStats?.inventoryTrackerCurrencies ?? [],
    inventoryTrackerEquipped: playerStats?.inventoryTrackerEquipped ?? [],
    inventoryTrackerInventory: playerStats?.inventoryTrackerInventory ?? [],
    lockProviderProps: {
      fieldLocks,
      hiddenTrackerFields,
      lockMode,
      onSetLockMode: setLockMode,
      onToggleFieldLock: toggleFieldLock,
      onUpdateFieldLocks: updateFieldLocks,
      onUpdateHiddenFields: updateHiddenTrackerFields,
    },
  };
}

export function RoleplayHUD({
  chatId,
  isStreaming,
  onRetriggerTrackers,
  onRerunSingleTracker,
  manualTrackers,
  mobileCompact,
  enabledAgentTypes: enabledAgentTypesProp,
}: RoleplayHUDProps & { mobileCompact?: boolean }) {
  const gameStateRefreshing = useGameStateStore((s) => s.isRefreshing);
  const setGameState = useGameStateStore((s) => s.setGameState);

  const enabledAgentTypes = enabledAgentTypesProp ?? EMPTY_AGENT_TYPE_SET;
  const {
    packages: {
      memoryNag: memoryNagTrackerPackages,
      beholder: beholderTrackerPackages,
      other: otherRoleplayTrackerPackages,
    },
    patchField,
    patchPlayerStats,
    editInventoryTracker,
    date,
    time,
    location,
    weather,
    temperature,
    worldCustomFields,
    presentCharacters,
    personaStatBars,
    personaStatus,
    activeQuests,
    customTrackerFields,
    inventoryTrackerCurrencies,
    inventoryTrackerEquipped,
    inventoryTrackerInventory,
    lockProviderProps,
  } = useRoleplayTrackerState(chatId, enabledAgentTypes, "roleplay-hud");

  const isAgentProcessing = useAgentStore((s) => s.processingChatIds.includes(chatId));
  const trackerPanelEnabled = useUIStore((s) => s.trackerPanelEnabled);
  const trackerPanelOpen = useUIStore((s) => s.trackerPanelOpen);
  const trackerPanelHideHudWidgets = useUIStore((s) => s.trackerPanelHideHudWidgets);
  const trackerTemperatureUnit = useUIStore((s) => s.trackerTemperatureUnit);
  const toggleTrackerPanel = useUIStore((s) => s.toggleTrackerPanel);

  const isTrackerBusy = isAgentProcessing || isStreaming || gameStateRefreshing;
  // Phones only: on a computer, trackers live in the Tracker Panel or the Tracker window.
  const showHudTrackerWidgets = !(trackerPanelEnabled && trackerPanelHideHudWidgets);

  useEffect(() => {
    if (!chatId) return;
    // If the store already holds state for this chat, skip the redundant fetch.
    // This happens when ChatArea remounts after visiting an editor panel.
    const existing = useGameStateStore.getState().current;
    if (existing?.chatId === chatId) return;

    let cancelled = false;
    api
      .get<GameState | null>(`/chats/${chatId}/game-state`)
      .then((gs) => {
        if (!cancelled) setGameState(gs ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chatId, setGameState]);

  const hasPersonaStatsTracker = enabledAgentTypes.has("persona-stats");
  const hasPlayerTrackerSections =
    hasPersonaStatsTracker ||
    enabledAgentTypes.has("character-tracker") ||
    enabledAgentTypes.has("quest") ||
    enabledAgentTypes.has("custom-tracker");
  const hasInventoryTracker = enabledAgentTypes.has("inventory-tracker");
  const hasMobilePlayerTrackerSections =
    hasPlayerTrackerSections || hasInventoryTracker || memoryNagTrackerPackages.length > 0;

  // If mobileCompact, widgets are even narrower and action buttons are not cut off

  return (
    <TrackerLockProvider {...lockProviderProps}>
      <div className={cn("rpg-hud", "flex items-center", CHAT_TOOLBAR_ICON_GAP_CLASS, mobileCompact && "min-w-0")}>
        {/* Desktop shows and hides the Tracker Panel from Chat Settings. */}
        {trackerPanelEnabled && !trackerPanelOpen && (
          <span className="contents md:hidden">
            <TrackerPanelToggleButton onToggle={() => toggleTrackerPanel(chatId)} />
          </span>
        )}

        {beholderTrackerPackages.map((item) => (
          <RoleplayTrackerCapability
            key={`${item.id}-beholder-launcher`}
            packageId={item.id}
            chatId={chatId}
            compact={mobileCompact}
            onRerunSingleTracker={onRerunSingleTracker}
            isTrackerRetryBusy={isTrackerBusy}
          />
        ))}

        {/* ── Mobile: combined widgets, grouped with tracker and agent controls ── */}
        {showHudTrackerWidgets && (
          <div
            className={cn(
              "flex items-center md:hidden",
              CHAT_TOOLBAR_ICON_GAP_CLASS,
              mobileCompact && "min-w-0 justify-start",
            )}
          >
            {enabledAgentTypes.has("world-state") && (
              <CombinedWorldWidget
                location={location ?? ""}
                date={date ?? ""}
                time={time ?? ""}
                weather={weather ?? ""}
                temperature={temperature ?? ""}
                worldCustomFields={worldCustomFields}
                trackerTemperatureUnit={trackerTemperatureUnit}
                onSaveLocation={(v) => patchField("location", v)}
                onSaveDate={(v) => patchField("date", v)}
                onSaveTime={(v) => patchField("time", v)}
                onSaveWeather={(v) => patchField("weather", v)}
                onSaveTemperature={(v) => patchField("temperature", v)}
                onUpdateWorldCustomFields={(fields) => patchField("worldCustomFields", fields)}
                onRerunSingleTracker={onRerunSingleTracker}
                isTrackerRetryBusy={isTrackerBusy}
              />
            )}

            {hasMobilePlayerTrackerSections && (
              <CombinedPlayerWidget
                showPersona={hasPersonaStatsTracker}
                showCharacters={enabledAgentTypes.has("character-tracker")}
                showQuests={enabledAgentTypes.has("quest")}
                showInventory={hasInventoryTracker}
                memoryNagPackageIds={memoryNagTrackerPackages.map((item) => item.id)}
                chatId={chatId}
                showCustomTracker={enabledAgentTypes.has("custom-tracker")}
                personaStats={personaStatBars}
                onUpdatePersonaStats={(bars) => patchField("personaStats", bars)}
                personaStatus={personaStatus}
                onUpdatePersonaStatus={(status) => patchPlayerStats("status", status)}
                characters={presentCharacters}
                onUpdateCharacters={(chars) => patchField("presentCharacters", chars)}
                quests={activeQuests}
                onUpdateQuests={(q) => patchPlayerStats("activeQuests", q)}
                inventoryCurrencies={inventoryTrackerCurrencies}
                inventoryEquipped={inventoryTrackerEquipped}
                inventory={inventoryTrackerInventory}
                onUpdateInventoryCurrencies={(rows) => editInventoryTracker("currencies", rows)}
                onUpdateInventoryEquipped={(rows) => editInventoryTracker("equipped", rows)}
                onUpdateInventory={(rows) => editInventoryTracker("inventory", rows)}
                customTrackerFields={customTrackerFields}
                onUpdateCustomTracker={(fields) => patchPlayerStats("customTrackerFields", fields)}
                onRerunSingleTracker={onRerunSingleTracker}
                isTrackerRetryBusy={isTrackerBusy}
              />
            )}

            {otherRoleplayTrackerPackages.map((item) => (
              <RoleplayTrackerCapability
                key={`${item.id}-roleplay-tracker-mobile`}
                packageId={item.id}
                chatId={chatId}
                compact
                onRerunSingleTracker={onRerunSingleTracker}
                isTrackerRetryBusy={isTrackerBusy}
              />
            ))}

            {/* Manual tracker trigger button (mobile) */}
            {manualTrackers && onRetriggerTrackers && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  onRetriggerTrackers();
                }}
                disabled={isTrackerBusy}
                className={cn(
                  MOBILE_HUD_BTN,
                  "justify-center text-[0.5625rem] font-medium",
                  isTrackerBusy && "text-[var(--marinara-chat-chrome-button-text-active)]",
                )}
              >
                <RefreshCw size="0.875rem" className={cn("shrink-0 h-4 w-4", isTrackerBusy && "animate-spin")} />
              </button>
            )}
          </div>
        )}
      </div>
    </TrackerLockProvider>
  );
}

/** Common mobile HUD button sizing – used by all four strip buttons */
const HUD_ICON_BUTTON = getChatToolbarButtonClass({ compact: true });
const MOBILE_HUD_BTN = cn(HUD_ICON_BUTTON, CHAT_TOOLBAR_MOBILE_OVERFLOW_HEIGHT_CLASS, "cursor-pointer select-none");

export function RoleplayTrackerCapability({
  packageId,
  chatId,
  compact = false,
  onRerunSingleTracker,
  isTrackerRetryBusy,
}: {
  packageId: string;
  chatId: string;
  compact?: boolean;
  onRerunSingleTracker?: (agentType: string) => void;
  isTrackerRetryBusy?: boolean;
}) {
  const { lockMode, onSetLockMode } = useTrackerLockContext();
  return (
    <span className="contents [&_button>svg]:!text-inherit">
      <CapabilityElement
        packageId={packageId}
        view="toolbar"
        capabilityProps={{
          chatId,
          chatMode: "roleplay",
          mobileCompact: compact,
          onRerunTracker: onRerunSingleTracker ? () => onRerunSingleTracker(packageId) : undefined,
          trackerRetryBusy: isTrackerRetryBusy,
          lockMode,
          onToggleLockMode: onSetLockMode ? () => onSetLockMode(!lockMode) : undefined,
          toolbarButtonClass: getChatToolbarButtonClass({
            compact,
            className: compact ? CHAT_TOOLBAR_MOBILE_OVERFLOW_HEIGHT_CLASS : undefined,
          }),
        }}
        className="contents"
      />
    </span>
  );
}

function DeferredHUDPanelFallback({ label }: { label: string }) {
  return <div className="px-3 py-4 text-center text-[0.625rem] text-[var(--muted-foreground)]/60">{label}</div>;
}

function TrackerPanelToggleButton({ onToggle }: { onToggle: () => void }) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <button
      data-tracker-panel-toggle="roleplay-hud"
      onClick={onToggle}
      className={WIDGET}
      title={localizeUi("ui.chat.trackerpaneltogglebutton.showTrackerPanel")}
      aria-label={localizeUi("ui.chat.trackerpaneltogglebutton.showTrackerPanel")}
    >
      <TrackerPanelIcon size="1.05rem" className="shrink-0" />
      <span className="sr-only">{localizeUi("ui.panels.trackerpanelappearancedrawer.trackerPanel")}</span>
    </button>
  );
}

// ═══════════════════════════════════════════════
// Combined Player Widget — merges Persona, Chars,
// Quests, and custom fields into a single expandable panel
// ═══════════════════════════════════════════════

function CombinedPlayerWidget({
  showPersona,
  showCharacters,
  showQuests,
  showInventory,
  memoryNagPackageIds,
  chatId,
  showCustomTracker,
  personaStats,
  onUpdatePersonaStats,
  personaStatus,
  onUpdatePersonaStatus,
  characters,
  onUpdateCharacters,
  quests,
  onUpdateQuests,
  inventoryCurrencies,
  inventoryEquipped,
  inventory,
  onUpdateInventoryCurrencies,
  onUpdateInventoryEquipped,
  onUpdateInventory,
  customTrackerFields,
  onUpdateCustomTracker,
  onRerunSingleTracker,
  isTrackerRetryBusy,
}: {
  showPersona: boolean;
  showCharacters: boolean;
  showQuests: boolean;
  showInventory: boolean;
  memoryNagPackageIds: string[];
  chatId: string;
  showCustomTracker: boolean;
  personaStats: CharacterStat[];
  onUpdatePersonaStats: (bars: CharacterStat[]) => void;
  personaStatus: string;
  onUpdatePersonaStatus: (status: string) => void;
  characters: PresentCharacter[];
  onUpdateCharacters: (chars: PresentCharacter[]) => void;
  quests: QuestProgress[];
  onUpdateQuests: (quests: QuestProgress[]) => void;
  inventoryCurrencies: InventoryTrackerRow[];
  inventoryEquipped: InventoryTrackerRow[];
  inventory: InventoryTrackerRow[];
  onUpdateInventoryCurrencies: (rows: InventoryTrackerRow[]) => void;
  onUpdateInventoryEquipped: (rows: InventoryTrackerRow[]) => void;
  onUpdateInventory: (rows: InventoryTrackerRow[]) => void;
  customTrackerFields: CustomTrackerField[];
  onUpdateCustomTracker: (fields: CustomTrackerField[]) => void;
  onRerunSingleTracker?: (agentType: string) => void;
  isTrackerRetryBusy?: boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className={WIDGET}
        title={localizeUi("ui.chat.combinedplayerwidget.playerTracker")}
      >
        <div className="flex h-4 items-center justify-center shrink-0">
          <Swords size="0.875rem" className="max-md:h-4 max-md:w-4" />
        </div>
        <span className="sr-only">{localizeUi("ui.chat.combinedplayerwidget.tracker")}</span>
      </button>

      <WidgetPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        className="w-80 max-h-[min(75vh,32rem)]"
      >
        <Suspense
          fallback={<DeferredHUDPanelFallback label={localizeUi("ui.chat.combinedplayerwidget.loadingTrackers")} />}
        >
          <CombinedPlayerPanel
            showPersona={showPersona}
            showCharacters={showCharacters}
            showQuests={showQuests}
            showInventory={showInventory}
            memoryNagPackageIds={memoryNagPackageIds}
            chatId={chatId}
            showCustomTracker={showCustomTracker}
            personaStats={personaStats}
            onUpdatePersonaStats={onUpdatePersonaStats}
            personaStatus={personaStatus}
            onUpdatePersonaStatus={onUpdatePersonaStatus}
            characters={characters}
            onUpdateCharacters={onUpdateCharacters}
            quests={quests}
            onUpdateQuests={onUpdateQuests}
            inventoryCurrencies={inventoryCurrencies}
            inventoryEquipped={inventoryEquipped}
            inventory={inventory}
            onUpdateInventoryCurrencies={onUpdateInventoryCurrencies}
            onUpdateInventoryEquipped={onUpdateInventoryEquipped}
            onUpdateInventory={onUpdateInventory}
            customTrackerFields={customTrackerFields}
            onUpdateCustomTracker={onUpdateCustomTracker}
            onClose={() => setOpen(false)}
            onRerunSingleTracker={onRerunSingleTracker}
            isTrackerRetryBusy={isTrackerRetryBusy}
          />
        </Suspense>
      </WidgetPopover>
    </div>
  );
}

/** Shared popover wrapper used by tracker widgets — renders via portal to escape overflow clipping */
function WidgetPopover({
  open,
  onClose,
  anchorRef,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const computePosition = useCallback(() => {
    if (!anchorRef.current) return null;
    const rect = anchorRef.current.getBoundingClientRect();
    const popoverWidth = ref.current?.offsetWidth ?? 288;
    const popoverHeight = ref.current?.offsetHeight ?? 200;
    const top = rect.bottom + 4;
    let left: number;

    // Bottom placement — center horizontally on screen for mobile
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
      left = Math.round((window.innerWidth - popoverWidth) / 2);
    } else {
      left = rect.left;
      if (left + popoverWidth > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - popoverWidth - 8);
      }
    }
    return {
      top: Math.max(8, Math.min(top, window.innerHeight - popoverHeight - 8)),
      left: Math.max(8, Math.min(left, window.innerWidth - popoverWidth - 8)),
    };
  }, [anchorRef]);

  // Position the popover relative to the anchor element
  useLayoutEffect(() => {
    if (!open) return;
    setPos(computePosition());
  }, [open, computePosition]);

  // Reposition on scroll/resize
  useEffect(() => {
    if (!open) return;
    const update = () => setPos(computePosition());
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    if (ref.current) observer.observe(ref.current);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, [open, computePosition]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current && !ref.current.contains(target) && !anchorRef.current?.contains(target)) {
        // Delay close so that the input's blur event fires first, committing any edits
        requestAnimationFrame(() => onClose());
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      style={pos ? { position: "fixed", top: pos.top, left: pos.left } : { position: "fixed", top: -9999, left: -9999 }}
      className={cn(
        NEUTRAL_PANEL_SHELL,
        NEUTRAL_PANEL_SCROLL_AREA,
        "z-[9999] min-h-24 min-w-60 max-w-[calc(100vw-1rem)] resize overflow-auto",
        className,
        "!max-h-[calc(100vh-1rem)]",
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

// ═══════════════════════════════════════════════
// Miniature displays: each tracker's compact view, shown while its
// Tracker window drawer is collapsed
// ═══════════════════════════════════════════════

/** The toolbar tile a miniature sits in. It ignores the pointer, so a press reaches the drawer header. */
export const TRACKER_MINIATURE_TILE = cn(
  getChatToolbarButtonClass({ compact: true }),
  "pointer-events-none group flex-col gap-0 overflow-hidden",
);

export function PersonaStatsMiniature({ bars }: { bars: CharacterStat[] }) {
  if (bars.length === 0) return <BarChart3 size="0.875rem" className="max-md:h-3.5 max-md:w-3.5" />;
  return (
    <div className="flex w-6 max-md:w-8 flex-col justify-center gap-0.5 max-md:gap-px shrink-0">
      {bars.map((bar) => {
        const pct = bar.max > 0 ? Math.min(100, (bar.value / bar.max) * 100) : 0;
        return (
          <div
            key={bar.name}
            className="h-1 max-md:h-px w-full rounded-full bg-[var(--muted)]/30 dark:bg-foreground/10 overflow-hidden"
          >
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${pct}%`,
                backgroundColor: bar.color || "#a1a1aa",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function CharactersMiniature() {
  return <Users size="0.875rem" className="transition-colors max-md:h-3.5 max-md:w-3.5" />;
}

export function CustomTrackerMiniature({ fields }: { fields: CustomTrackerField[] }) {
  const reduceAmbientEffects = useReducedAmbientEffects();
  const [cycleIdx, setCycleIdx] = useState(0);
  const [animKey, setAnimKey] = useState(0);

  // Cycle through fields every 3 seconds
  useEffect(() => {
    if (reduceAmbientEffects || fields.length <= 1) return;
    const timer = setInterval(() => {
      setCycleIdx((prev) => (prev + 1) % fields.length);
      setAnimKey((k) => k + 1);
    }, 3000);
    return () => clearInterval(timer);
  }, [fields.length, reduceAmbientEffects]);

  useEffect(() => {
    if (cycleIdx >= fields.length) setCycleIdx(0);
  }, [fields.length, cycleIdx]);

  const currentField = fields[cycleIdx];
  if (fields.length === 0 || !currentField) {
    return <SlidersHorizontal size="0.875rem" className="max-md:h-3 max-md:w-3" />;
  }
  const previewLabel = currentField.value ? `${currentField.name}: ${currentField.value}` : currentField.name;
  const longestWord = previewLabel.split(/\s+/).reduce((max, w) => Math.max(max, w.length), 0);
  const previewFontSize = Math.max(3.5, Math.min(6, 60 / Math.max(longestWord, 1)));
  return (
    <span
      key={animKey}
      className={cn(
        "w-full px-0.5 text-center font-semibold leading-[1.2]",
        !reduceAmbientEffects && "animate-[inventory-cycle_0.4s_ease-out]",
      )}
      style={{ fontSize: `${previewFontSize}px` }}
    >
      {previewLabel}
    </span>
  );
}

export function InventoryTrackerMiniature({ total }: { total: number }) {
  return total > 0 ? (
    <span className="text-[0.625rem] font-semibold tabular-nums">{total}</span>
  ) : (
    <Backpack size="0.875rem" className="max-md:h-3 max-md:w-3" />
  );
}

export function QuestsMiniature({ quests }: { quests: QuestProgress[] }) {
  // The first incomplete objective from the most recent incomplete quest
  const incompleteQuests = quests.filter((q) => !q.completed);
  const mainQuest = incompleteQuests.length > 0 ? incompleteQuests[incompleteQuests.length - 1] : undefined;
  const currentObjective = mainQuest?.objectives.find((o) => !o.completed);
  if (!currentObjective) return <Scroll size="0.875rem" className="max-md:h-3 max-md:w-3" />;
  return (
    <span className="widget-scroll-text w-full px-0.5 text-center text-[0.375rem] font-semibold leading-[1.15] max-md:text-[0.5rem]">
      <span className="inline-flex animate-[widget-scroll_8s_linear_infinite] whitespace-nowrap">
        <span className="px-3">{currentObjective.text}</span>
        <span className="px-3" aria-hidden>
          {currentObjective.text}
        </span>
      </span>
    </span>
  );
}

// ═══════════════════════════════════════════════
// Uniform World-State Widgets
// ═══════════════════════════════════════════════

const WIDGET = cn(
  HUD_ICON_BUTTON,
  CHAT_TOOLBAR_MOBILE_OVERFLOW_HEIGHT_CLASS,
  "group flex-col gap-0 overflow-hidden cursor-pointer select-none",
);

// ═══════════════════════════════════════════════
// Combined World-State Widget (icon strip + popover, phones)
// ═══════════════════════════════════════════════

interface WorldTrackerValues {
  location: string;
  date: string;
  time: string;
  weather: string;
  temperature: string;
  worldCustomFields: WorldCustomField[];
}

/** Icons and colors the World State miniature and its panel share. */
export function getWorldTrackerDisplay(world: WorldTrackerValues, trackerTemperatureUnit: TrackerTemperatureUnit) {
  const { location, date, time, weather, temperature, worldCustomFields } = world;
  const weatherFamily = classifyWorldWeather(weather);
  const weatherStyle = HUD_WEATHER_STYLES[weatherFamily];
  const dateDisplay = getWorldDateDisplay(date);
  const timeDisplay = getWorldTimeDisplay(time);
  const temperatureDisplay = getTemperatureGaugeDisplay(temperature, trackerTemperatureUnit);
  const hasWorldState =
    [location, date, time, weather, temperature].some((value) => value.trim().length > 0) ||
    worldCustomFields.some((field) => field.name.trim().length > 0 || field.value.trim().length > 0);
  return {
    hasWorldState,
    weatherEmoji: weatherStyle.emoji,
    weatherColor: weatherFamily === "atmosphere" && !weather ? "text-[var(--muted-foreground)]/70" : weatherStyle.color,
    pinColor: getLocationPinColor(location),
    dateDisplay,
    timeDisplay,
    timeColor:
      timeDisplay.kind === "empty" ? "text-[var(--muted-foreground)]/70" : HUD_TIME_COLORS[timeDisplay.timeOfDay],
    temperatureDisplay,
    tempColor: temperatureDisplay.color,
  };
}

type WorldTrackerDisplay = ReturnType<typeof getWorldTrackerDisplay>;

/** The World State tile: a square until there is world state, then a row of icons. */
export function getWorldMiniatureTileClass(hasWorldState: boolean, open = false) {
  return cn(
    getChatToolbarButtonClass({
      compact: true,
      open,
      className: CHAT_TOOLBAR_MOBILE_OVERFLOW_HEIGHT_CLASS,
    }),
    hasWorldState ? "w-auto min-w-8 gap-1 px-2" : "group flex-col gap-0 overflow-hidden",
  );
}

function CombinedWorldWidget({
  location,
  date,
  time,
  weather,
  temperature,
  worldCustomFields,
  trackerTemperatureUnit,
  onSaveLocation,
  onSaveDate,
  onSaveTime,
  onSaveWeather,
  onSaveTemperature,
  onUpdateWorldCustomFields,
  onRerunSingleTracker,
  isTrackerRetryBusy,
}: WorldTrackerValues & {
  trackerTemperatureUnit: TrackerTemperatureUnit;
  onSaveLocation: (v: string) => void;
  onSaveDate: (v: string) => void;
  onSaveTime: (v: string) => void;
  onSaveWeather: (v: string) => void;
  onSaveTemperature: (v: string) => void;
  onUpdateWorldCustomFields: (fields: WorldCustomField[]) => void;
  onRerunSingleTracker?: (agentType: string) => void;
  isTrackerRetryBusy?: boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const display = getWorldTrackerDisplay(
    { location, date, time, weather, temperature, worldCustomFields },
    trackerTemperatureUnit,
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className={cn(getWorldMiniatureTileClass(display.hasWorldState, open), "cursor-pointer select-none")}
        title={localizeUi("ui.panels.appearancesettings.worldState")}
      >
        <WorldStateMiniature display={display} />
      </button>

      <WidgetPopover open={open} onClose={() => setOpen(false)} anchorRef={buttonRef} className="w-64">
        <Suspense
          fallback={<DeferredHUDPanelFallback label={localizeUi("ui.chat.combinedworldwidget.loadingWorldState")} />}
        >
          <CombinedWorldPanel
            location={location}
            date={date}
            time={time}
            weather={weather}
            temperature={temperature}
            worldCustomFields={worldCustomFields}
            onSaveLocation={onSaveLocation}
            onSaveDate={onSaveDate}
            onSaveTime={onSaveTime}
            onSaveWeather={onSaveWeather}
            onSaveTemperature={onSaveTemperature}
            onUpdateWorldCustomFields={onUpdateWorldCustomFields}
            weatherEmoji={display.weatherEmoji}
            pinColor={display.pinColor}
            dateColor={display.dateDisplay.iconColor}
            timeColor={display.timeColor}
            weatherColor={display.weatherColor}
            tempColor={display.tempColor}
            onClose={() => setOpen(false)}
            onRerunSingleTracker={onRerunSingleTracker}
            isTrackerRetryBusy={isTrackerRetryBusy}
          />
        </Suspense>
      </WidgetPopover>
    </div>
  );
}

export function WorldStateMiniature({ display }: { display: WorldTrackerDisplay }) {
  const { hasWorldState, dateDisplay, timeDisplay, timeColor, weatherColor, weatherEmoji, temperatureDisplay } =
    display;
  return !hasWorldState ? (
    <MapPin size="0.875rem" className="shrink-0 max-md:h-3.5 max-md:w-3.5" />
  ) : (
    <>
      {/* Location pin */}
      <MapPin size="0.9375rem" className="shrink-0 drop-shadow-sm" />

      {/* Mini calendar with day number */}
      <WorldCalendarIcon
        day={dateDisplay.day}
        className={cn("h-4 w-4 shrink-0 drop-shadow-sm", dateDisplay.iconColor)}
      />

      <WorldClockIcon
        display={timeDisplay}
        variant="monochrome"
        className={cn("h-4 w-4 shrink-0 drop-shadow-sm", timeColor)}
      />

      {/* Weather emoji */}
      <span
        className={cn("text-sm leading-none shrink-0 drop-shadow-sm [text-shadow:0_0_8px_currentColor]", weatherColor)}
      >
        {weatherEmoji}
      </span>

      <WorldThermometerIcon display={temperatureDisplay} variant="solid-bulb" className="h-4 w-[0.625rem] shrink-0" />
      {temperatureDisplay.isPure && (
        <span
          className="shrink-0 text-[0.5rem] font-bold leading-none md:text-[0.5625rem]"
          style={{ color: display.tempColor }}
        >
          {temperatureDisplay.label}
        </span>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

const HUD_WEATHER_STYLES: Record<WorldWeatherFamily, { emoji: string; color: string }> = {
  thunder: { emoji: "⛈️", color: "text-violet-300" },
  blizzard: { emoji: "🌨️", color: "text-sky-300" },
  "heavy-rain": { emoji: "🌧️", color: "text-blue-300" },
  rain: { emoji: "🌦️", color: "text-cyan-300" },
  hail: { emoji: "🧊", color: "text-sky-200" },
  snow: { emoji: "❄️", color: "text-sky-300" },
  fog: { emoji: "🌫️", color: "text-zinc-300" },
  sand: { emoji: "🏜️", color: "text-amber-300" },
  ash: { emoji: "🌋", color: "text-stone-300" },
  fire: { emoji: "🔥", color: "text-red-400" },
  wind: { emoji: "💨", color: "text-teal-300" },
  blossom: { emoji: "🌸", color: "text-[var(--marinara-chat-chrome-panel-text)]" },
  aurora: { emoji: "🌌", color: "text-[var(--marinara-chat-chrome-panel-text)]" },
  cloud: { emoji: "☁️", color: "text-zinc-300" },
  clear: { emoji: "☀️", color: "text-yellow-300" },
  heat: { emoji: "🥵", color: "text-red-400" },
  cold: { emoji: "🥶", color: "text-sky-300" },
  atmosphere: { emoji: "🌤️", color: "text-sky-300" },
};

const HUD_TIME_COLORS: Record<ReturnType<typeof getWorldTimeDisplay>["timeOfDay"], string> = {
  dawn: "text-amber-300",
  day: "text-yellow-300",
  dusk: "text-orange-400",
  night: "text-indigo-300",
  unknown: "text-amber-300",
};
