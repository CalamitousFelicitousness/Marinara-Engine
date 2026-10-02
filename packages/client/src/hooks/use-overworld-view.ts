// ──────────────────────────────────────────────
// What the overworld and the town views share (worldgen W8): the game's clock running in real time as
// Pixelforge's world does, and a setting family's tiles.
// ──────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { OVERWORLD_SECONDS_PER_GAME_MINUTE } from "@marinara-engine/shared";
import overworldAtlases from "../lib/overworld-atlases.json";
import { OVERWORLD_TILE } from "../lib/overworld-paint";
import { useAdvanceTime } from "./use-game";

/** What the game screen can ask of the view in front: send the real time it has passed so far. */
export interface OverworldClockHandle {
  flush: () => Promise<void>;
}

/** Real-time minutes sent together (Pixelforge saves its clock at most every thirty seconds). */
const FLUSH_MINUTES = 6;

/** The clock while a view is in front: a game minute every five real seconds while `running` and not
 *  `held()`, sent in batches, when the page hides, when the view closes, and when the game screen asks. */
export function useOverworldClock(
  chatId: string,
  running: boolean,
  held: () => boolean,
  handleRef?: MutableRefObject<OverworldClockHandle | null>,
) {
  const advance = useAdvanceTime();
  const advanceRef = useRef(advance.mutateAsync);
  advanceRef.current = advance.mutateAsync;
  const heldRef = useRef(held);
  heldRef.current = held;
  const [pendingMinutes, setPendingMinutes] = useState(0);
  const pendingRef = useRef(0);

  const flush = useCallback(
    async (keepalive = false) => {
      const minutes = pendingRef.current;
      if (minutes < 1) return;
      pendingRef.current = 0;
      setPendingMinutes(0);
      try {
        await advanceRef.current({ chatId, minutes, keepalive });
      } catch {
        // A minute the server did not take is a minute lost, never a broken game.
      }
    },
    [chatId],
  );
  useEffect(() => {
    if (handleRef) handleRef.current = { flush: () => flush() };
    return () => {
      if (handleRef) handleRef.current = null;
    };
  }, [flush, handleRef]);
  useEffect(() => {
    if (!running) return;
    let seconds = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || heldRef.current()) return;
      seconds += 1;
      if (seconds < OVERWORLD_SECONDS_PER_GAME_MINUTE) return;
      seconds = 0;
      pendingRef.current += 1;
      setPendingMinutes(pendingRef.current);
      if (pendingRef.current >= FLUSH_MINUTES) void flush();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, flush]);
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const onPageHide = () => void flush(true);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      void flush();
    };
  }, [flush]);
  return { pendingMinutes, flush };
}

// Each setting family's tiles, drawn in code by scripts/art/build-overworld-tiles.mjs: an image of 16 px
// tiles and a map of tile ids (ground looks, markers, ruins, the party, the town's pieces) to their
// variants. Community tile packs can use the same format later. A tile a family lacks is drawn plain.
const ATLASES = overworldAtlases as Record<string, { columns: number; tiles: Record<string, number[]> }>;

/** Draws a family's tile at (x, y), the variant by `pick` (0..1); false while the tiles load, when the
 *  family has none, or when it lacks that tile, so the caller draws it plain. */
export type OverworldTileDrawer = (
  ctx: CanvasRenderingContext2D,
  id: string,
  x: number,
  y: number,
  pick?: number,
) => boolean;

export function useOverworldAtlas(family: string | undefined): OverworldTileDrawer {
  const atlasMap = family ? ATLASES[family] : undefined;
  const [atlas, setAtlas] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    setAtlas(null);
    if (!atlasMap) return;
    const image = new Image();
    image.onload = () => setAtlas(image);
    image.src = `/overworld/${family}.png`;
    return () => {
      image.onload = null;
    };
  }, [atlasMap, family]);
  return useCallback(
    (ctx, id, x, y, pick = 0) => {
      const variants = atlas && atlasMap ? atlasMap.tiles[id] : undefined;
      if (!atlas || !atlasMap || !variants?.length) return false;
      const index = variants[Math.min(variants.length - 1, Math.floor(pick * variants.length))]!;
      const sx = (index % atlasMap.columns) * OVERWORLD_TILE;
      const sy = Math.floor(index / atlasMap.columns) * OVERWORLD_TILE;
      ctx.drawImage(atlas, sx, sy, OVERWORLD_TILE, OVERWORLD_TILE, x, y, OVERWORLD_TILE, OVERWORLD_TILE);
      return true;
    },
    [atlas, atlasMap],
  );
}

/** The view's offset in screen pixels so `at` (world pixels) sits at the middle across and a little above
 *  the middle down (the narration sits at the bottom), kept inside the map; the view may go past its
 *  bottom edge by almost half a screen so nothing on it is under the narration. */
export function overworldCamera(
  at: { x: number; y: number },
  map: { width: number; height: number },
  view: { width: number; height: number },
  scale: number,
) {
  const axis = (mapPx: number, viewPx: number, look: number, share: number, past: number) =>
    mapPx * scale <= viewPx
      ? Math.round((mapPx * scale - viewPx) / 2)
      : Math.round(Math.min(Math.max(0, look * scale - viewPx * share), mapPx * scale - viewPx + past));
  return {
    x: axis(map.width, view.width, at.x, 0.5, 0),
    y: axis(map.height, view.height, at.y, 0.4, view.height * 0.45),
  };
}
