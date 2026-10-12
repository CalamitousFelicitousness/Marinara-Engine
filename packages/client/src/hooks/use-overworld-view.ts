// ──────────────────────────────────────────────
// What the overworld and the town views share (worldgen W8): the game's clock running in real time as
// Pixelforge's world does, and a setting family's tiles (its tile pack, W9a).
// ──────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OVERWORLD_SECONDS_PER_GAME_MINUTE, tilePackPixels, type TilePack } from "@marinara-engine/shared";
import { ApiError, api } from "../lib/api-client";
import { OVERWORLD_TILE } from "../lib/overworld-paint";
import { useAdvanceTime } from "./use-game";

/** Tiles to a row on the canvas a pack is laid out on. */
const ATLAS_COLUMNS = 8;

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

// ── Tile packs (worldgen W9a) ──

/** The stored tile packs, the families with a built-in pack, and the pack each family is drawn with. */
export interface TilePackLibrary {
  packs: Array<{ id: string; name: string; family: string; version: number }>;
  builtIn: string[];
  selection: Record<string, string>;
}

export const tilePackKeys = {
  library: ["game", "tile-packs"] as const,
  pack: (family: string, chosen: string | null, version: number | null) =>
    ["game", "tile-packs", "pack", family, chosen, version] as const,
};

export function useTilePackLibrary() {
  return useQuery({
    queryKey: tilePackKeys.library,
    queryFn: () => api.get<TilePackLibrary>("/game-tile-packs"),
    // Read again when a view opens: a pack may have been saved from Pixelforge meanwhile.
    staleTime: 0,
  });
}

/** Draws a family's tile at (x, y), the variant by `pick` (0..1); false while the tiles load, when the
 *  family has none, or when it lacks that tile, so the caller draws it plain. */
export type OverworldTileDrawer = (
  ctx: CanvasRenderingContext2D,
  id: string,
  x: number,
  y: number,
  pick?: number,
) => boolean;

/** The tiles a family is drawn with: the pack chosen for it, else the Engine's own for the family, laid
 *  out once on a canvas. A family with neither is drawn plain. */
export function useOverworldAtlas(family: string | undefined): OverworldTileDrawer {
  const { data: library } = useTilePackLibrary();
  const chosen = (family && library?.selection[family]) || null;
  // By version, so a pack saved again is drawn anew.
  const version = (chosen && library?.packs.find((pack) => pack.id === chosen)?.version) || null;
  const builtIn = Boolean(family && library?.builtIn.includes(family));
  const { data: pack } = useQuery({
    queryKey: tilePackKeys.pack(family ?? "", chosen, version),
    queryFn: async () => {
      if (chosen) {
        // A chosen pack that is gone or no longer reads (404) falls back to the built-in one; any other
        // failure is thrown, so the query retries rather than keeping the fallback under this pack's key.
        const stored = await api
          .get<{ pack: TilePack }>(`/game-tile-packs/pack?id=${encodeURIComponent(chosen)}`)
          .catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 404) return null;
            throw error;
          });
        if (stored) return stored.pack;
      }
      if (!builtIn) return null;
      return (await api.get<{ pack: TilePack }>(`/game-tile-packs/builtin/${encodeURIComponent(family!)}`)).pack;
    },
    enabled: Boolean(family && library),
    staleTime: Infinity,
  });
  const atlas = useMemo(() => {
    if (!pack) return null;
    const ids = Object.keys(pack.tiles);
    const total = ids.reduce((sum, id) => sum + pack.tiles[id]!.length, 0);
    const canvas = document.createElement("canvas");
    canvas.width = ATLAS_COLUMNS * OVERWORLD_TILE;
    canvas.height = Math.max(1, Math.ceil(total / ATLAS_COLUMNS)) * OVERWORLD_TILE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const index: Record<string, number[]> = {};
    let next = 0;
    for (const id of ids) {
      index[id] = pack.tiles[id]!.map((rows) => {
        const at = next++;
        const image = new ImageData(tilePackPixels(pack, rows), OVERWORLD_TILE, OVERWORLD_TILE);
        ctx.putImageData(image, (at % ATLAS_COLUMNS) * OVERWORLD_TILE, Math.floor(at / ATLAS_COLUMNS) * OVERWORLD_TILE);
        return at;
      });
    }
    return { canvas, index };
  }, [pack]);
  return useCallback(
    (ctx, id, x, y, pick = 0) => {
      const variants = atlas?.index[id];
      if (!atlas || !variants?.length) return false;
      const at = variants[Math.min(variants.length - 1, Math.floor(pick * variants.length))]!;
      const sx = (at % ATLAS_COLUMNS) * OVERWORLD_TILE;
      const sy = Math.floor(at / ATLAS_COLUMNS) * OVERWORLD_TILE;
      ctx.drawImage(atlas.canvas, sx, sy, OVERWORLD_TILE, OVERWORLD_TILE, x, y, OVERWORLD_TILE, OVERWORLD_TILE);
      return true;
    },
    [atlas],
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

/** Draws a family with a stored pack, or (null) with its own again. */
export function useChooseTilePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { family: string; packId: string | null }) =>
      api.put<{ selection: Record<string, string> }>("/game-tile-packs/selection", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: tilePackKeys.library }),
  });
}

/** Imports a tile pack file. */
export function useImportTilePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (definition: string) =>
      api.post<{ status: "added" | "unchanged"; pack: { id: string; name: string; version: number }; notes: string[] }>(
        "/game-tile-packs/import",
        { definition },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: tilePackKeys.library }),
  });
}

/** Removes every version of a stored pack. */
export function useRemoveTilePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (packId: string) =>
      api.delete<{ removed: number }>(`/game-tile-packs?id=${encodeURIComponent(packId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["game", "tile-packs"] }),
  });
}
