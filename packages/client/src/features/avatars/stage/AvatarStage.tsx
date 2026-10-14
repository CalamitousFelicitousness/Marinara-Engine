// ──────────────────────────────────────────────
// Avatar stage: avatars in Roleplay and Game chats (lane: base)
// ──────────────────────────────────────────────
// Mounted lazily by the chat surfaces. Picks each participant's kind (AvatarConfig.activeKind, falling
// back by AVATAR_KIND_AGENT to a kind whose agent is on; with 2D Avatars on, expression sprites are a
// PNGTuber avatar until one is saved), loads renderers with loadAvatarRenderer(), creates one director
// once an avatar shows, and runs the single frame loop within AVATAR_RENDER_BUDGET (visible count, DPR
// cap, fps, pause when hidden, offscreen, covered or effects-paused, reduced motion). It never hides the
// full-body sprite: the user turns that off by hand. Avatars sit where the sprites would and move with
// the sprites' Arrange mode (placement key `<ownerId>:avatar`).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useQueries, type QueryObserverResult } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AVATAR_2D_AGENT_ID,
  type AvatarConfig,
  type AvatarFeatureFlags,
  type AvatarImageRef,
  type AvatarKind,
  type PngtuberAvatarData,
  type SpriteCharacterVisualSettings,
  type SpritePlacement,
  type SpriteSide,
} from "@marinara-engine/shared";
import { clampSpritePlacement, getDefaultSpritePlacement } from "../../../components/chat/sprite-placement";
import { SPRITE_DISPLAY_SCALE_MAX, SPRITE_DISPLAY_SCALE_MIN } from "../../../components/chat/sprite-display-modes";
import { fetchAvatarModel, useAvatarModelList } from "../../../hooks/use-avatar-models";
import { spriteKeys, type SpriteInfo } from "../../../hooks/use-characters";
import { useMatchMedia } from "../../../hooks/use-match-media";
import { useReducedAmbientEffects } from "../../../hooks/use-reduced-ambient-effects";
import { api } from "../../../lib/api-client";
import {
  AVATAR_RENDER_BUDGET,
  avatarModelKeys,
  type AvatarDirector,
  type AvatarRenderer,
  type AvatarStageProps,
} from "../contract";
import { createAvatarDirector } from "../director/avatar-director";
import { buildPngtuberLayersFromSprites } from "../renderers/pngtuber/pngtuber-layers";
import {
  applyAvatarFeatures,
  avatarTargetFps,
  ownerKey,
  resolveAvatarImage,
  selectStageAvatars,
  withSpriteAvatar,
  type StageAvatar,
} from "./avatar-stage-logic";
import { useAvatarEffectsPaused, useChatCovered, useOnScreen } from "./use-avatar-pause";
import { useAvatarRenderer } from "./use-avatar-renderer";

/** Where avatars stand, matching the chat's sprite layout. All optional: Game passes only side and scale. */
export interface AvatarStageLayout {
  side?: SpriteSide | "center";
  placements?: Record<string, SpritePlacement>;
  characterVisualSettings?: Record<string, SpriteCharacterVisualSettings>;
  /** Full-body sprite scale, which avatars share. */
  scale?: number;
  /** Scene-wide multiplier (Visual Novel sprite size). */
  scaleMultiplier?: number;
  /** The sprites' Arrange mode. */
  editing?: boolean;
  onPlacementChange?: (placementKey: string, placement: SpritePlacement) => void;
  onFinishPlacement?: () => void;
}

/** "Phone" in the budget: a coarse pointer or a viewport below the md breakpoint. */
const PHONE_QUERY = "(max-width: 767px), (pointer: coarse)";
/** Average draw time (ms) above which a phone drops its idle frame rate. */
const PHONE_LOAD_THRESHOLD_MS = 12;

interface StageSlot {
  renderer: AvatarRenderer;
  features: AvatarFeatureFlags;
}

/** Each participant's sprite list: null while loading, empty when it failed. Structurally shared by React
 *  Query, so an unchanged list keeps its identity. */
function combineSpriteLists(results: QueryObserverResult<SpriteInfo[]>[]): (SpriteInfo[] | null)[] {
  return results.map((result) => result.data ?? (result.isError ? [] : null));
}

/** The PNGTuber setup a sprite list makes, built once per list so avatars do not remount on every render. */
const spriteSetupCache = new WeakMap<SpriteInfo[], PngtuberAvatarData | null>();
function spriteSetupFor(sprites: SpriteInfo[] | null | undefined): PngtuberAvatarData | null {
  if (!sprites) return null;
  if (!spriteSetupCache.has(sprites)) spriteSetupCache.set(sprites, buildPngtuberLayersFromSprites(sprites));
  return spriteSetupCache.get(sprites) ?? null;
}

export function avatarPlacementKey(ownerId: string) {
  return `${ownerId}:avatar`;
}

export function AvatarStage({
  chatId,
  mode,
  participants,
  enabledAgentIds,
  side = "left",
  placements,
  characterVisualSettings,
  scale = 1,
  scaleMultiplier = 1,
  editing = false,
  onPlacementChange,
  onFinishPlacement,
}: AvatarStageProps & AvatarStageLayout) {
  const { t } = useTranslation();
  const phone = useMatchMedia(PHONE_QUERY);
  const reducedMotion = useReducedAmbientEffects();
  const effectsPaused = useAvatarEffectsPaused();
  const stageRef = useRef<HTMLDivElement>(null);

  const { data: summaries } = useAvatarModelList(participants.length > 0 && enabledAgentIds.length > 0);
  // With 2D Avatars on, an owner's expression sprites are a PNGTuber avatar until one is saved.
  const spriteLists = useQueries({
    queries: participants.map(({ owner }) => ({
      queryKey: spriteKeys.list(owner.ownerId),
      queryFn: () => api.get<SpriteInfo[]>(`/sprites/${owner.ownerId}`),
      enabled: enabledAgentIds.includes(AVATAR_2D_AGENT_ID),
      staleTime: 5 * 60_000,
    })),
    combine: combineSpriteLists,
  });
  const spritesByOwner = useMemo(
    () => new Map(participants.map((participant, position) => [ownerKey(participant.owner), spriteLists[position]])),
    [participants, spriteLists],
  );
  const spriteAvatarOwners = useMemo(
    () => new Set([...spritesByOwner].filter(([, sprites]) => spriteSetupFor(sprites)).map(([key]) => key)),
    [spritesByOwner],
  );
  const maxVisible = phone ? AVATAR_RENDER_BUDGET.maxVisible.phone : AVATAR_RENDER_BUDGET.maxVisible.desktop;
  const shown = useMemo(
    () => selectStageAvatars(participants, summaries, enabledAgentIds, maxVisible, spriteAvatarOwners),
    [enabledAgentIds, maxVisible, participants, spriteAvatarOwners, summaries],
  );
  const configQueries = useQueries({
    queries: shown.map(({ participant, saved }) => ({
      queryKey: avatarModelKeys.detail(participant.owner),
      queryFn: () => fetchAvatarModel(participant.owner),
      enabled: saved,
      staleTime: 5 * 60_000,
    })),
  });

  // One director per chat, created only once an avatar shows (it may start downloading the classifier
  // model); it subscribes to its own feeds.
  const showsAvatars = shown.length > 0;
  const [director, setDirector] = useState<AvatarDirector | null>(null);
  useEffect(() => {
    if (!showsAvatars) return;
    const created = createAvatarDirector({ chatId, mode, reducedMotion });
    setDirector(created);
    return () => {
      created.dispose();
      setDirector(null);
    };
  }, [chatId, mode, reducedMotion, showsAvatars]);
  useEffect(() => {
    director?.setParticipants(participants);
  }, [director, participants]);

  const onScreen = useOnScreen(stageRef, shown.length > 0);
  const covered = useChatCovered(stageRef, shown.length > 0);

  // Mounted renderers, keyed by owner id. The loop reads this map; slots add and remove themselves.
  const slotsRef = useRef(new Map<string, StageSlot>());
  const [slotsVersion, setSlotsVersion] = useState(0);
  const setSlot = useCallback((ownerId: string, slot: StageSlot | null) => {
    if (slot) slotsRef.current.set(ownerId, slot);
    else slotsRef.current.delete(ownerId);
    setSlotsVersion((version) => version + 1);
  }, []);

  const paused = effectsPaused || !onScreen || covered;
  useEffect(() => {
    const slots = slotsRef.current;
    for (const slot of slots.values()) slot.renderer.setPaused(paused || !director);
    if (paused || !director || slots.size === 0) return;
    let frameRequest = 0;
    let lastDraw = performance.now();
    let talking = false;
    let underLoad = false;
    let drawCostMs = 0;
    const tick = (now: number) => {
      frameRequest = requestAnimationFrame(tick);
      const interval = 1000 / avatarTargetFps({ talking, phone, underLoad });
      if (now - lastDraw < interval - 1) return;
      const dtMs = Math.min(now - lastDraw, 250);
      lastDraw = now;
      const started = performance.now();
      talking = false;
      for (const [ownerId, slot] of slots) {
        const frame = applyAvatarFeatures(director.frame(ownerId, now), slot.features, reducedMotion);
        if (frame.state === "talking") talking = true;
        slot.renderer.update(frame, dtMs);
      }
      drawCostMs = drawCostMs * 0.9 + (performance.now() - started) * 0.1;
      underLoad = phone && drawCostMs > PHONE_LOAD_THRESHOLD_MS;
    };
    frameRequest = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRequest);
  }, [director, paused, phone, reducedMotion, slotsVersion]);

  if (shown.length === 0) return null;

  return (
    <div
      ref={stageRef}
      data-avatar-stage
      data-avatar-paused={paused ? "true" : undefined}
      className={`pointer-events-none absolute inset-0 overflow-hidden ${editing ? "z-[35]" : "z-[5]"}`}
    >
      {shown.map((avatar, position) => {
        const sprites = spritesByOwner.get(ownerKey(avatar.participant.owner));
        const ownerId = avatar.participant.owner.ownerId;
        const ownerSettings = characterVisualSettings?.[ownerId];
        const ownerSide = ownerSettings?.spritePosition ?? side;
        const key = avatarPlacementKey(ownerId);
        const placement = clampSpritePlacement(
          placements?.[key] ??
            placements?.[`${ownerId}:full-body`] ??
            placements?.[ownerId] ??
            getDefaultSpritePlacement(avatar.index, shown.length, ownerSide),
        );
        return (
          <AvatarSlot
            key={`${ownerId}:${avatar.kind}`}
            avatar={avatar}
            savedConfig={avatar.saved ? configQueries[position]?.data : null}
            spriteSetup={spriteSetupFor(sprites)}
            sprites={avatar.kind === "pngtuber" ? (sprites ?? null) : undefined}
            placementKey={key}
            placement={placement}
            count={shown.length}
            scale={(ownerSettings?.fullBodySpriteScale ?? scale) * scaleMultiplier}
            editing={editing}
            phone={phone}
            reducedMotion={reducedMotion}
            stageRef={stageRef}
            label={t("avatars.stage.avatarLabel", { name: avatar.participant.name })}
            finishLabel={t("avatars.stage.finishPlacing")}
            dragLabel={t("ui.chat.charactersprite.dragToMove")}
            releaseLabel={t("ui.chat.charactersprite.releaseToSave")}
            onSlot={setSlot}
            onPlacementChange={onPlacementChange}
            onFinishPlacement={onFinishPlacement}
          />
        );
      })}
    </div>
  );
}

/** Sizes follow the full-body sprite's, so swapping the sprite for an avatar keeps the scene's scale. */
function avatarSizeClass(count: number) {
  if (count >= 3) {
    return "h-[calc(54vh*var(--avatar-scale))] max-w-[calc(58vw*var(--avatar-scale))] md:h-[calc(50vh*var(--avatar-scale))] md:max-w-[calc(28vw*var(--avatar-scale))]";
  }
  if (count === 2) {
    return "h-[calc(60vh*var(--avatar-scale))] max-w-[calc(64vw*var(--avatar-scale))] md:h-[calc(56vh*var(--avatar-scale))] md:max-w-[calc(34vw*var(--avatar-scale))]";
  }
  return "h-[calc(64vh*var(--avatar-scale))] max-w-[calc(86vw*var(--avatar-scale))] md:h-[calc(62vh*var(--avatar-scale))] md:max-w-[calc(44vw*var(--avatar-scale))]";
}

function AvatarSlot({
  avatar,
  savedConfig,
  spriteSetup,
  sprites,
  placementKey,
  placement,
  count,
  scale,
  editing,
  phone,
  reducedMotion,
  stageRef,
  label,
  finishLabel,
  dragLabel,
  releaseLabel,
  onSlot,
  onPlacementChange,
  onFinishPlacement,
}: {
  avatar: StageAvatar;
  /** The owner's avatar.json: undefined while loading, null when it has none. */
  savedConfig: AvatarConfig | null | undefined;
  /** The PNGTuber setup the owner's expression sprites make, used while none is saved. */
  spriteSetup: PngtuberAvatarData | null;
  /** The owner's sprites for a PNGTuber avatar (null while loading), undefined for other kinds. */
  sprites: SpriteInfo[] | null | undefined;
  placementKey: string;
  placement: SpritePlacement;
  count: number;
  scale: number;
  editing: boolean;
  phone: boolean;
  reducedMotion: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  label: string;
  finishLabel: string;
  dragLabel: string;
  releaseLabel: string;
  onSlot: (ownerId: string, slot: StageSlot | null) => void;
  onPlacementChange?: (placementKey: string, placement: SpritePlacement) => void;
  onFinishPlacement?: () => void;
}) {
  const { owner } = avatar.participant;
  const { ownerType, ownerId } = owner;
  const config = useMemo(() => {
    if (savedConfig === undefined) return null;
    const shownConfig = withSpriteAvatar({ ownerType, ownerId }, savedConfig, spriteSetup);
    return shownConfig?.enabled ? shownConfig : null;
  }, [ownerId, ownerType, savedConfig, spriteSetup]);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const resolveImage = useMemo(() => {
    if (!config || sprites === null) return null;
    return (ref: AvatarImageRef) => resolveAvatarImage(owner, config, sprites, ref);
  }, [config, owner, sprites]);
  const imagesKey = sprites ? sprites.map((sprite) => sprite.url).join("|") : "";
  const kind: AvatarKind | null = config ? avatar.kind : null;
  const { renderer } = useAvatarRenderer({
    canvas,
    owner,
    config,
    kind,
    resolveImage,
    imagesKey,
    reducedMotion: reducedMotion || config?.features.idleMotion === false,
    phone,
  });
  const features = config?.features;
  useEffect(() => {
    if (!renderer || !features) return;
    onSlot(owner.ownerId, { renderer, features });
    return () => onSlot(owner.ownerId, null);
  }, [features, onSlot, owner.ownerId, renderer]);

  const { current, dragging, onPointerDown } = usePlacementDrag({
    placement,
    placementKey,
    editing,
    stageRef,
    onPlacementChange,
  });

  const style = useMemo<CSSProperties>(
    () =>
      ({
        left: `${current.x}%`,
        top: `${current.y}%`,
        zIndex: dragging ? 40 : 10 + avatar.index,
        touchAction: editing ? "none" : "auto",
        "--avatar-scale": Math.max(SPRITE_DISPLAY_SCALE_MIN, Math.min(SPRITE_DISPLAY_SCALE_MAX, scale)),
      }) as CSSProperties,
    [avatar.index, current.x, current.y, dragging, editing, scale],
  );

  return (
    <div
      data-avatar-owner={owner.ownerId}
      data-avatar-kind={avatar.kind}
      className={`absolute -translate-x-1/2 -translate-y-full select-none ${editing ? "pointer-events-auto cursor-grab active:cursor-grabbing" : "pointer-events-none"}`}
      style={style}
      onPointerDown={onPointerDown}
    >
      {editing && (
        <div className="absolute left-1/2 top-0 z-[2] flex -translate-x-1/2 -translate-y-[calc(100%+0.35rem)] items-center gap-1">
          <button
            type="button"
            title={finishLabel}
            aria-label={finishLabel}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPlacementChange?.(placementKey, current);
              onFinishPlacement?.();
            }}
            className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] text-[var(--marinara-chat-chrome-button-text-hover)] shadow-lg backdrop-blur-md transition-colors hover:border-[var(--marinara-chat-chrome-button-border-hover)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
          >
            <Check size="0.75rem" strokeWidth={2.4} />
          </button>
          <div className="pointer-events-none whitespace-nowrap rounded-full border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] px-2 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-[var(--marinara-chat-chrome-button-text-hover)] shadow-md">
            {dragging ? releaseLabel : dragLabel}
          </div>
        </div>
      )}
      <canvas
        ref={setCanvas}
        role="img"
        aria-label={label}
        className={`${avatarSizeClass(count)} block aspect-[3/4] ${editing ? "outline-dashed outline-1 outline-[var(--marinara-chat-chrome-button-border)]" : ""}`}
      />
    </div>
  );
}

/** Drag-to-place for Arrange mode, the same gesture as the sprites': percentages of the stage, saved on release. */
function usePlacementDrag({
  placement,
  placementKey,
  editing,
  stageRef,
  onPlacementChange,
}: {
  placement: SpritePlacement;
  placementKey: string;
  editing: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  onPlacementChange?: (placementKey: string, placement: SpritePlacement) => void;
}) {
  const [current, setCurrent] = useState(placement);
  const currentRef = useRef(placement);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: SpritePlacement } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Follow the saved place (by value: the stage builds a new object each render) unless a drag is running.
  const { x, y } = placement;
  useEffect(() => {
    if (dragging) return;
    currentRef.current = { x, y };
    setCurrent({ x, y });
  }, [dragging, x, y]);

  useEffect(() => {
    if (!editing && dragRef.current) {
      dragRef.current = null;
      setDragging(false);
    }
  }, [editing]);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      const stage = stageRef.current;
      if (!drag || !stage || event.pointerId !== drag.pointerId) return;
      const next = clampSpritePlacement({
        x: drag.origin.x + ((event.clientX - drag.startX) / Math.max(stage.clientWidth, 1)) * 100,
        y: drag.origin.y + ((event.clientY - drag.startY) / Math.max(stage.clientHeight, 1)) * 100,
      });
      currentRef.current = next;
      setCurrent(next);
    };
    const finish = (event: PointerEvent) => {
      if (!dragRef.current || event.pointerId !== dragRef.current.pointerId) return;
      dragRef.current = null;
      setDragging(false);
      onPlacementChange?.(placementKey, currentRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [dragging, onPlacementChange, placementKey, stageRef]);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (!editing || (event.button !== 0 && event.pointerType !== "touch")) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: currentRef.current,
    };
    setDragging(true);
  };

  return { current, dragging, onPointerDown };
}
