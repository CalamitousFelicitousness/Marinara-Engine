// A dungeon, cave or station map the Game Master opened with `[map:]`: drawn with its set's tile pack when
// the player has it, else in plain colours; a click walks the party there by the shortest way, its minutes
// on the game's clock and the walk told on the next turn; from the way out, the party leaves.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DoorOpen, Footprints } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  DUNGEON_EXIT_PROP,
  DUNGEON_SETS,
  characterFacing,
  characterFrameAt,
  dungeonAreaAt,
  dungeonFromGameDungeonMap,
  dungeonWalkable,
  worldEdgePiece,
  type CharacterFacing,
  type TilePack,
} from "@marinara-engine/shared";
import { useDungeonLeave, useDungeonMap, useDungeonWalk } from "../../hooks/use-game";
import {
  overworldBaseResolution,
  overworldCamera,
  useOverworldAtlas,
  useTilePackLibrary,
} from "../../hooks/use-overworld-view";
import { api } from "../../lib/api-client";
import { useGameStateStore } from "../../stores/game-state.store";
import { OVERWORLD_TILE, cellNoise, paintParty } from "../../lib/overworld-paint";

const T = OVERWORLD_TILE;
type Point = { x: number; y: number };
const WALK_MS_PER_CELL = 70;
const WALK_LONGEST_MS = 3000;
/** Without the set's art: the ground in plain colours. */
const PLAIN = { floor: "#4a443d", wall: "#837767", liquid: "#245a78", prop: "#c9a86a" };
const centreOf = (cell: Point): Point => ({ x: cell.x * T + T / 2, y: cell.y * T + T / 2 });

/** The set's own tile pack, when the player's library has one by the set's name. */
function useDungeonPack(set: string | undefined): TilePack | null | "loading" {
  const { data: library, isPending } = useTilePackLibrary();
  const entry = set ? library?.packs.find((pack) => pack.id === set) : undefined;
  const { data, isPending: packPending } = useQuery({
    queryKey: ["game", "tile-packs", "dungeon", set, entry?.version ?? null],
    queryFn: async () =>
      (await api.get<{ pack: TilePack }>(`/game-tile-packs/pack?id=${encodeURIComponent(set!)}`)).pack,
    enabled: Boolean(entry),
    staleTime: Infinity,
  });
  if (isPending || (entry && packPending)) return "loading";
  return entry ? (data ?? null) : null;
}

export function DungeonMapView({
  chatId,
  turnKey,
  canWalk,
  onLeft,
}: {
  chatId: string;
  turnKey: string | null;
  /** False while a turn is under way: the party stays put. */
  canWalk: boolean;
  /** The party left by the way out. */
  onLeft: () => void;
}) {
  const { t } = useTranslation();
  const { data } = useDungeonMap(chatId, turnKey, true);
  const kept = data?.map ?? null;
  const cells = useMemo(() => (kept ? dungeonFromGameDungeonMap(kept) : null), [kept]);
  const set = kept ? DUNGEON_SETS.find((each) => each.id === kept.set) : undefined;
  const pack = useDungeonPack(kept?.set);
  // A pack of the set's own: "dungeon" names no family the library chooses for, so only `own` draws.
  const drawTile = useOverworldAtlas("dungeon", pack === null ? undefined : pack);
  const walkMutation = useDungeonWalk();
  const leaveMutation = useDungeonLeave();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const walkingRef = useRef(false);
  const [walking, setWalking] = useState(false);
  const scale = Math.max(2, Math.min(4, Math.floor(Math.min(size.width / 360, size.height / 260))));

  // ── The map, drawn once: ground, the liquid's edges, then the props from the back row to the front ──
  const shownAt = scale * (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  const resolution = cells ? overworldBaseResolution(drawTile, cells.width * T * cells.height * T, shownAt) : 1;
  const base = useMemo(() => {
    const canvas = document.createElement("canvas");
    if (!cells || drawTile.loading) return canvas;
    canvas.width = cells.width * T * resolution;
    canvas.height = cells.height * T * resolution;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;
    ctx.scale(resolution, resolution);
    ctx.imageSmoothingEnabled = true;
    const plain = (colour: string, x: number, y: number) => {
      ctx.fillStyle = colour;
      ctx.fillRect(x, y, T, T);
    };
    const liquidEdges = drawTile.hasEdges("dn_liquid");
    for (let y = 0; y < cells.height; y++)
      for (let x = 0; x < cells.width; x++) {
        const ground = cells.ground[y * cells.width + x];
        if (ground === "rock") continue;
        const pick = cellNoise(x, y)(5);
        // With the liquid's edge pieces, a pool is under-painted as floor and drawn by the pieces.
        const id = ground === "wall" ? "dn_wall" : ground === "liquid" && !liquidEdges ? "dn_liquid" : "dn_floor";
        const colour =
          ground === "wall" ? PLAIN.wall : ground === "liquid" && !liquidEdges ? PLAIN.liquid : PLAIN.floor;
        if (!drawTile(ctx, id, x * T, y * T, pick)) plain(colour, x * T, y * T);
      }
    if (liquidEdges) {
      const rows = drawTile.edgeRows("dn_liquid");
      const filled = (x: number, y: number) => cells.ground[y * cells.width + x] === "liquid";
      for (let y = 0; y <= cells.height; y++)
        for (let x = 0; x <= cells.width; x++) {
          const piece = worldEdgePiece(filled, x, y, cells.width, cells.height, rows);
          if (piece >= 0) drawTile.edge(ctx, "dn_liquid", piece, x * T, y * T, cellNoise(x, y)(71));
        }
    }
    for (let y = 0; y < cells.height; y++)
      for (let x = 0; x < cells.width; x++) {
        const prop = cells.props[y * cells.width + x]!;
        if (prop < 0) continue;
        if (!drawTile(ctx, `dn_prop${prop}`, x * T, y * T)) {
          ctx.fillStyle = PLAIN.prop;
          if (prop === DUNGEON_EXIT_PROP) {
            ctx.fillRect(x * T + 3, y * T + 3, T - 6, T - 6);
          } else {
            ctx.beginPath();
            ctx.arc(x * T + T / 2, y * T + T / 2, T / 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    return canvas;
  }, [cells, drawTile, resolution]);
  const mapSize = cells ? { width: cells.width * T, height: cells.height * T } : { width: 0, height: 0 };

  // ── The party, and the view ──
  const partyRef = useRef<Point | null>(null);
  const facingRef = useRef<CharacterFacing>("down");
  if (!walkingRef.current) partyRef.current = kept ? centreOf(kept.at) : null;
  const camera = useCallback(
    (at: Point) => overworldCamera(at, mapSize, size, scale),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapSize.width, mapSize.height, scale, size],
  );
  const resting = camera(partyRef.current ?? { x: mapSize.width / 2, y: mapSize.height / 2 });

  const draw = useCallback(
    (cam: Point, frame = 1) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx || size.width === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const [width, height] = [Math.round(size.width * dpr), Math.round(size.height * dpr)];
      if (canvas.width !== width || canvas.height !== height) [canvas.width, canvas.height] = [width, height];
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#05060a";
      ctx.fillRect(0, 0, width, height);
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, -cam.x * dpr, -cam.y * dpr);
      ctx.imageSmoothingEnabled = drawTile.image && resolution > scale * dpr;
      ctx.drawImage(base, 0, 0, base.width / resolution, base.height / resolution);
      ctx.imageSmoothingEnabled = false;
      const party = partyRef.current;
      if (party) {
        const drawn = drawTile.character(
          ctx,
          "party",
          Math.round(party.x) - 8,
          Math.round(party.y) - 8,
          facingRef.current,
          frame,
        );
        const [x, y] = [Math.round(party.x) - 8, Math.round(party.y) - 14];
        if (!drawn && !drawTile(ctx, "party", x, y)) paintParty(ctx, x + 1, y + 1, frame !== 1);
      }
    },
    [base, drawTile, resolution, scale, size.height, size.width],
  );
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const hasMap = Boolean(kept);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMap]);
  useEffect(() => {
    if (!walkingRef.current) draw(resting);
  }, [draw, resting.x, resting.y]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Walking ──
  const frameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );
  const walkTo = useCallback(
    async (to: Point) => {
      if (!kept || !cells || !canWalk || walkingRef.current) return;
      if (to.x === kept.at.x && to.y === kept.at.y) return;
      if (!dungeonWalkable(cells, to.x, to.y)) return;
      walkingRef.current = true;
      let result;
      try {
        result = await walkMutation.mutateAsync({ chatId, map: kept.id, x: to.x, y: to.y });
      } catch (error) {
        walkingRef.current = false;
        toast.error(error instanceof Error && error.message ? error.message : t("game.dungeon.walkFailed"));
        return;
      }
      const points = [centreOf(kept.at), ...result.path.map(centreOf)];
      const duration = Math.min(WALK_LONGEST_MS, Math.max(300, result.path.length * WALK_MS_PER_CELL));
      setWalking(true);
      const started = performance.now();
      const frame = (now: number) => {
        const progress = Math.min(1, (now - started) / duration);
        const along = progress * (points.length - 1);
        const index = Math.min(points.length - 2, Math.floor(along));
        const [a, b] = [points[index]!, points[index + 1]!];
        const part = along - index;
        partyRef.current = { x: a.x + (b.x - a.x) * part, y: a.y + (b.y - a.y) * part };
        facingRef.current = characterFacing(b.x - a.x, b.y - a.y, facingRef.current);
        drawRef.current(cameraRef.current(partyRef.current), characterFrameAt(now));
        if (progress < 1) {
          frameRef.current = requestAnimationFrame(frame);
          return;
        }
        frameRef.current = null;
        walkingRef.current = false;
        setWalking(false);
        const snapshot = useGameStateStore.getState().current;
        if (snapshot?.chatId === chatId)
          useGameStateStore.getState().setGameState({ ...snapshot, time: result.formatted });
      };
      frameRef.current = requestAnimationFrame(frame);
    },
    [canWalk, cells, chatId, kept, t, walkMutation],
  );

  const onCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!cells) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.floor((resting.x + (event.clientX - rect.left) / scale) / T);
    const y = Math.floor((resting.y + (event.clientY - rect.top) / scale) / T);
    void walkTo({ x, y });
  };

  if (!kept || !cells || !set) {
    return <div className="absolute inset-0 z-0 bg-black" role="region" aria-label={t("game.dungeon.region")} />;
  }
  const onWayOut = cells.props[kept.at.y * cells.width + kept.at.x] === DUNGEON_EXIT_PROP;
  const area = dungeonAreaAt(kept, kept.at.x, kept.at.y);
  const leave = async () => {
    try {
      await leaveMutation.mutateAsync({ chatId, map: kept.id });
      onLeft();
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("game.dungeon.leaveFailed"));
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-0 overflow-clip bg-black"
      role="region"
      aria-label={t("game.dungeon.region")}
      data-component="DungeonMapView"
      data-tiles={drawTile.loading ? "loading" : drawTile.image ? "image" : "plain"}
    >
      <canvas
        ref={canvasRef}
        onClick={onCanvasClick}
        className="absolute inset-0 h-full w-full cursor-pointer [image-rendering:pixelated]"
        aria-label={t("game.dungeon.canvas", { name: kept.name })}
      />
      <div className="pointer-events-none absolute bottom-24 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        <p className="rounded-lg bg-black/60 px-3 py-1 text-xs text-white/85">
          {kept.name}
          {" · "}
          {area ? t("game.dungeon.area", { area }) : t("game.dungeon.passage")}
          {walking && <Footprints size={12} className="ml-2 inline animate-pulse" aria-hidden="true" />}
        </p>
        {onWayOut && (
          <button
            type="button"
            onClick={() => void leave()}
            disabled={!canWalk || walking || leaveMutation.isPending}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/70 px-3 py-1.5 text-xs font-semibold text-white hover:bg-black/85 disabled:opacity-50"
          >
            <DoorOpen size={13} aria-hidden="true" />
            {t("game.dungeon.leave", { way: set.props[DUNGEON_EXIT_PROP] })}
          </button>
        )}
      </div>
    </div>
  );
}
