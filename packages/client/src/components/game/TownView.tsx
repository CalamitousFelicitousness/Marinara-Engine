// ──────────────────────────────────────────────
// Game: the town (worldgen W8b)
// The settlement the party is in, laid out from the world: its streets and square, its buildings (the
// places in it, its hall, its workplaces, its homes) and its people where the hour has them. The party
// walks to a building or the square, the minutes pass on the clock, and the next turn tells the Game
// Master. The clock runs here as it does on the overworld.
// ──────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ArrowLeft, Footprints, MapPin, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  worldTownDoor,
  worldTownMinutes,
  worldTownPeopleAt,
  type GameWorld,
  type TilePack,
  type WorldPerson,
  type WorldTownBuilding,
} from "@marinara-engine/shared";
import { useTown, useTownVisit } from "../../hooks/use-game";
import {
  overworldCamera,
  useOverworldAtlas,
  useOverworldClock,
  type OverworldClockHandle,
} from "../../hooks/use-overworld-view";
import { useGameStateStore } from "../../stores/game-state.store";
import { OVERWORLD_TILE, cellNoise, overworldDarkness, paintParty } from "../../lib/overworld-paint";
import { cn } from "../../lib/utils";
import { GAME_SECTION_CLASS } from "../../lib/chat-widget-colors";

interface TownViewProps {
  chatId: string;
  game: GameWorld;
  turnKey: string | null;
  time: { day: number; hour: number; minute: number } | null;
  clockRunning: boolean;
  canWalk: boolean;
  family?: string;
  /** The game's own tiles (an Experience's map pack), drawn before the setting family's. */
  tilePack?: TilePack | null | "loading";
  handleRef?: MutableRefObject<OverworldClockHandle | null>;
  onLeave: () => void;
}

type Point = { x: number; y: number };
const T = OVERWORLD_TILE;
/** How long a walk across town is shown for, at most. */
const WALK_MS_PER_CELL = 60;
const WALK_LONGEST_MS = 2500;
const PLAIN = {
  ground: "#6aa84f",
  street: "#8f8a80",
  square: "#b3ada2",
  roof: "#b5523b",
  hall: "#7c776b",
  wall: "#efe2c2",
  door: "#5a3b22",
};

const centreOf = (cell: Point): Point => ({ x: cell.x * T + T / 2, y: cell.y * T + T / 2 });
const hash = (text: string) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

export function TownView({
  chatId,
  game,
  turnKey,
  time,
  clockRunning,
  canWalk,
  family,
  tilePack,
  handleRef,
  onLeave,
}: TownViewProps) {
  const { t } = useTranslation();
  const { data: town } = useTown(chatId, turnKey, true);
  const visitMutation = useTownVisit();
  const drawTile = useOverworldAtlas(family, tilePack);
  const walkingRef = useRef(false);
  const [walking, setWalking] = useState(false);
  const { pendingMinutes, flush } = useOverworldClock(chatId, clockRunning, () => walkingRef.current, handleRef);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selected, setSelectedState] = useState<string | null>(null);
  /** Where the view looks, in town pixels; none: at the party. */
  const [lookAt, setLookAt] = useState<Point | null>(null);
  const [placesOpen, setPlacesOpen] = useState(false);
  const scale = Math.max(2, Math.min(4, Math.floor(Math.min(size.width / 360, size.height / 240))));

  const clockMinutes = time ? (time.day * 24 + time.hour) * 60 + time.minute + pendingMinutes : null;
  const hour = clockMinutes === null ? 12 : Math.floor(clockMinutes / 60) % 24;
  const darkness = clockMinutes === null ? 0 : overworldDarkness(hour, clockMinutes % 60);
  const settlement = town ? game.world.places.find((place) => place.id === town.settlementId) : undefined;
  const peopleById = useMemo(() => new Map((town?.people ?? []).map((person) => [person.id, person])), [town]);

  // ── What the town is drawn from, once: its ground, streets, square, buildings and stalls ──
  const base = useMemo(() => {
    const canvas = document.createElement("canvas");
    if (!town) return canvas;
    canvas.width = town.width * T;
    canvas.height = town.height * T;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;
    const plain = (colour: string, x: number, y: number) => {
      ctx.fillStyle = colour;
      ctx.fillRect(x, y, T, T);
    };
    for (let y = 0; y < town.height; y++) {
      for (let x = 0; x < town.width; x++) {
        const cell = town.ground[y * town.width + x];
        const pick = cellNoise(x, y)(5);
        const [id, colour] =
          cell === "s"
            ? ["street", PLAIN.street]
            : cell === "q"
              ? ["square", PLAIN.square]
              : ["town_ground", PLAIN.ground];
        if (!drawTile(ctx, id, x * T, y * T, pick)) plain(colour, x * T, y * T);
        // A tree here and there on the open ground away from the streets, and where a hand layout
        // (worldgen W9h) planted one or dug a well; "o" is open ground kept clear.
        if (cell === "t" || (cell === "." && pick > 0.86)) drawTile(ctx, "tree", x * T, y * T);
        if (cell === "w") drawTile(ctx, "well", x * T, y * T);
      }
    }
    for (const building of town.buildings) {
      const roof = building.kind === "home" ? "roof" : "hall";
      const roofRows = building.h - 1;
      for (let row = 0; row < building.h; row++) {
        for (let col = 0; col < building.w; col++) {
          const [x, y] = [(building.x + col) * T, (building.y + row) * T];
          if (row < roofRows) {
            const v = roofRows === 1 ? "n" : row === 0 ? "n" : row === roofRows - 1 ? "s" : "";
            const h = col === 0 ? "w" : col === building.w - 1 ? "e" : "";
            const at = v + h || "c";
            if (!drawTile(ctx, `${roof}_${at}`, x, y)) plain(roof === "roof" ? PLAIN.roof : PLAIN.hall, x, y);
          } else {
            // The front: the door on the side of its street, windows between.
            const doorCol =
              building.door.x < building.x
                ? 0
                : building.door.x >= building.x + building.w
                  ? building.w - 1
                  : building.door.x - building.x;
            const id = col === doorCol ? "wall_door" : col % 2 ? "wall_window" : "wall";
            if (!drawTile(ctx, id, x, y)) plain(col === doorCol ? PLAIN.door : PLAIN.wall, x, y);
          }
        }
      }
    }
    for (const stall of town.stalls) drawTile(ctx, "stall", stall.x * T, stall.y * T);
    const well = worldTownDoor(town, "square");
    if (well && town.stalls.every((stall) => stall.x !== well.x || stall.y !== well.y))
      drawTile(ctx, "well", well.x * T, well.y * T);
    return canvas;
  }, [drawTile, town]);

  // ── Where people are at the hour: one at each place of work's door, the rest of the square's around it ──
  const crowd = useMemo(() => {
    if (!town) return [] as Array<{ person: WorldPerson; at: Point }>;
    const out: Array<{ person: WorldPerson; at: Point }> = [];
    const squareFolk = worldTownPeopleAt(town, "square", hour);
    squareFolk.forEach((person, index) => {
      const cells = town.square.w * town.square.h;
      const spot = (hash(person.id) + index * 7) % cells;
      out.push({
        person,
        at: { x: town.square.x + (spot % town.square.w), y: town.square.y + Math.floor(spot / town.square.w) },
      });
    });
    for (const building of town.buildings) {
      if (building.kind === "home") continue;
      const here = worldTownPeopleAt(town, building.id, hour)[0];
      if (here) out.push({ person: here, at: building.door });
    }
    return out;
  }, [hour, town]);

  // ── The party, and the view ──
  const partyRef = useRef<Point | null>(null);
  const restingSpot = town ? worldTownDoor(town, town.at) : null;
  if (!walkingRef.current) partyRef.current = restingSpot ? centreOf(restingSpot) : null;
  const camera = useCallback(
    (at: Point) => overworldCamera(at, { width: base.width, height: base.height }, size, scale),
    [base, scale, size],
  );
  const resting = camera(lookAt ?? partyRef.current ?? { x: base.width / 2, y: base.height / 2 });
  /** Chooses a spot, and brings it into view. */
  const setSelected = (next: string | null) => {
    setSelectedState(next);
    const door = next && town ? worldTownDoor(town, next) : null;
    if (door) setLookAt(centreOf(door));
  };
  // When the party is somewhere new, the view goes with it.
  useEffect(() => setLookAt(null), [town?.at]);

  const draw = useCallback(
    (cam: Point, step = false) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx || size.width === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const [width, height] = [Math.round(size.width * dpr), Math.round(size.height * dpr)];
      if (canvas.width !== width || canvas.height !== height) [canvas.width, canvas.height] = [width, height];
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#05060a";
      ctx.fillRect(0, 0, width, height);
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, -cam.x * dpr, -cam.y * dpr);
      ctx.drawImage(base, 0, 0);
      for (const { person, at } of crowd) {
        const pick = (hash(person.id) % 100) / 100;
        if (!drawTile(ctx, "folk", at.x * T, at.y * T - 4, pick)) paintParty(ctx, at.x * T + 1, at.y * T - 3, false);
      }
      const party = partyRef.current;
      if (party) {
        const [x, y] = [Math.round(party.x) - 8, Math.round(party.y) - 14 - (step ? 1 : 0)];
        if (!drawTile(ctx, "party", x, y)) paintParty(ctx, x + 1, y + 1, step);
      }
      if (darkness > 0) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = `rgba(40, 52, 120, ${Math.min(0.85, darkness * 1.5)})`;
        ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = "source-over";
      }
    },
    [base, crowd, darkness, drawTile, scale, size.height, size.width],
  );
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  // Watched once the town is there: until then the view is an empty placeholder with nothing to measure.
  const hasTown = Boolean(town);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasTown]);
  useEffect(() => {
    if (!walkingRef.current) draw({ x: resting.x, y: resting.y });
  }, [draw, resting.x, resting.y]);

  // ── Walking across town ──
  const frameRef = useRef<number | null>(null);
  const arrivalRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      arrivalRef.current?.();
    },
    [],
  );
  const startVisit = useCallback(
    async (to: string) => {
      if (!town || !canWalk || walkingRef.current) return;
      // Under way from the first click, so a second one while the clock is sent starts nothing.
      walkingRef.current = true;
      const from = worldTownDoor(town, town.at);
      const target = worldTownDoor(town, to);
      // The real time so far goes on the clock before the walk's minutes.
      await flush();
      let result;
      try {
        result = await visitMutation.mutateAsync({ chatId, to });
      } catch (error) {
        walkingRef.current = false;
        toast.error(error instanceof Error && error.message ? error.message : t("game.town.walkFailed"));
        return;
      }
      setSelectedState(null);
      setLookAt(null);
      if (!from || !target) {
        walkingRef.current = false;
        return;
      }
      // Along the street the party is on, then the one it turns into.
      const corner = { x: target.x, y: from.y };
      const points = [centreOf(from), centreOf(corner), centreOf(target)];
      const cells = Math.abs(target.x - from.x) + Math.abs(target.y - from.y);
      const duration = Math.min(WALK_LONGEST_MS, Math.max(400, cells * WALK_MS_PER_CELL));
      walkingRef.current = true;
      setWalking(true);
      arrivalRef.current = () => {
        arrivalRef.current = null;
        const snapshot = useGameStateStore.getState().current;
        if (snapshot?.chatId === chatId)
          useGameStateStore.getState().setGameState({ ...snapshot, time: result.formatted });
      };
      const started = performance.now();
      const firstLeg = Math.abs(corner.x - from.x) / Math.max(1, cells);
      const frame = (now: number) => {
        const progress = Math.min(1, (now - started) / duration);
        const [a, b, c] = points as [Point, Point, Point];
        partyRef.current =
          progress < firstLeg
            ? { x: a.x + (b.x - a.x) * (progress / firstLeg), y: a.y }
            : { x: b.x, y: b.y + (c.y - b.y) * ((progress - firstLeg) / Math.max(0.0001, 1 - firstLeg)) };
        drawRef.current(cameraRef.current(partyRef.current), Math.floor(now / 180) % 2 === 0);
        if (progress < 1) {
          frameRef.current = requestAnimationFrame(frame);
          return;
        }
        frameRef.current = null;
        walkingRef.current = false;
        setWalking(false);
        arrivalRef.current?.();
      };
      frameRef.current = requestAnimationFrame(frame);
    },
    [canWalk, chatId, flush, t, town, visitMutation],
  );

  if (!town) {
    return <div className="absolute inset-0 z-0 bg-black" role="region" aria-label={t("game.town.region")} />;
  }

  // ── Words for a spot ──
  const nameOf = (id: string) => peopleById.get(id)?.name ?? "";
  const spotTitle = (at: string): string => {
    if (at === "square") return t("game.town.square");
    const building = town.buildings.find((each) => each.id === at);
    if (!building) return t("game.town.square");
    if (building.name) return building.name;
    if (building.kind === "landmark") return t("game.town.landmark");
    if (building.kind === "work") return t("game.town.workplace", { role: building.role ?? "" });
    const residents = building.people.filter((id) => peopleById.get(id)?.named).map(nameOf);
    return residents.length ? t("game.town.homeOf", { names: residents.join(", ") }) : t("game.town.home");
  };
  const cell = T * scale;
  const listed: Array<{ at: string; title: string }> = [
    { at: "square", title: spotTitle("square") },
    ...town.buildings
      .filter(
        (building: WorldTownBuilding) =>
          building.kind !== "home" || building.people.some((id) => peopleById.get(id)?.named),
      )
      .map((building) => ({ at: building.id, title: spotTitle(building.id) })),
  ];
  const chosenDoor = selected ? worldTownDoor(town, selected) : null;
  const chosenPeople = selected ? worldTownPeopleAt(town, selected, hour).filter((person) => person.named) : [];
  const visited = town.visit ? spotTitle(town.visit.to) : null;
  const cardAt = chosenDoor
    ? (() => {
        const x = Math.min(Math.max(chosenDoor.x * cell + cell / 2 - resting.x, 130), size.width - 130);
        const y = chosenDoor.y * cell - resting.y;
        return { left: x, top: y < 200 ? y + cell + 12 : y - 8, below: y < 200 };
      })()
    : null;

  return (
    <>
      <div
        ref={containerRef}
        className="absolute inset-0 z-0 overflow-clip bg-black"
        role="region"
        aria-label={t("game.town.region")}
        data-component="TownView"
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full [image-rendering:pixelated]" />
        <div className="absolute left-0 top-0" style={{ transform: `translate(${-resting.x}px, ${-resting.y}px)` }}>
          {[{ id: "square", ...town.square }, ...town.buildings].map((spot) => (
            <button
              key={spot.id}
              type="button"
              onClick={() => setSelected(selected === spot.id ? null : spot.id)}
              className={cn(
                "absolute rounded-sm outline-none transition-shadow hover:ring-2 hover:ring-white/50 focus-visible:ring-2 focus-visible:ring-white",
                selected === spot.id && "ring-2 ring-[var(--primary)]",
              )}
              style={{ left: spot.x * cell, top: spot.y * cell, width: spot.w * cell, height: spot.h * cell }}
              aria-label={
                spot.id === town.at ? t("game.town.spotHere", { name: spotTitle(spot.id) }) : spotTitle(spot.id)
              }
              aria-pressed={selected === spot.id}
            />
          ))}
        </div>
      </div>

      {/* Above the narration: the card, the places, leaving, and what the walk is doing. */}
      <div className="pointer-events-none absolute inset-0 z-[25] overflow-clip" data-component="TownView.Chrome">
        {selected && cardAt && (
          <div
            data-game-section="town-card"
            className={cn(
              GAME_SECTION_CLASS,
              "pointer-events-auto absolute z-10 w-60 -translate-x-1/2 rounded-xl border border-white/15 bg-black/80 p-3 text-xs text-white/85 shadow-xl backdrop-blur-md",
              !cardAt.below && "-translate-y-full",
            )}
            style={{ left: cardAt.left, top: cardAt.top }}
            data-component="TownView.Card"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 truncate text-sm font-semibold text-white">{spotTitle(selected)}</div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded p-0.5 text-white/50 hover:text-white"
                aria-label={t("game.overworld.close")}
              >
                <X size={12} />
              </button>
            </div>
            <div className="mt-2 text-[0.625rem] font-semibold uppercase tracking-wide text-white/45">
              {t("game.town.hereNow")}
            </div>
            {chosenPeople.length ? (
              <ul className="mt-1 space-y-0.5">
                {chosenPeople.slice(0, 6).map((person) => (
                  <li key={person.id}>
                    <span className="text-white">{person.name}</span>
                    <span className="text-white/50"> · {person.role}</span>
                  </li>
                ))}
                {chosenPeople.length > 6 && (
                  <li className="text-white/50">{t("game.town.more", { count: chosenPeople.length - 6 })}</li>
                )}
              </ul>
            ) : (
              <div className="mt-1 text-white/50">{t("game.town.nobody")}</div>
            )}
            {selected === town.at ? (
              <div className="mt-2 text-white/60">{t("game.town.partyHere")}</div>
            ) : (
              <>
                <div className="mt-2 text-white/60">
                  {t("game.town.minutes", { count: worldTownMinutes(town, town.at, selected) })}
                </div>
                <button
                  type="button"
                  disabled={!canWalk || walking || visitMutation.isPending}
                  onClick={() => void startVisit(selected)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  <Footprints size={13} />
                  {t("game.town.walk")}
                </button>
              </>
            )}
          </div>
        )}

        <div className="pointer-events-auto absolute right-3 top-14 z-10 flex flex-col items-end gap-1.5">
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={onLeave}
              className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/65 px-3 py-1.5 text-xs font-semibold text-white/85 shadow-lg backdrop-blur-md transition-colors hover:bg-black/80 hover:text-white"
            >
              <ArrowLeft size={13} />
              {t("game.town.leave")}
            </button>
            <button
              type="button"
              onClick={() => setPlacesOpen((open) => !open)}
              className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/65 px-3 py-1.5 text-xs font-semibold text-white/85 shadow-lg backdrop-blur-md transition-colors hover:bg-black/80 hover:text-white"
              aria-expanded={placesOpen}
            >
              <MapPin size={13} />
              {t("game.town.places")}
            </button>
          </div>
          {placesOpen && (
            <ul
              className="max-h-[45vh] w-60 overflow-y-auto rounded-xl border border-white/15 bg-black/80 p-1 text-xs text-white/85 shadow-xl backdrop-blur-md"
              aria-label={t("game.town.places")}
            >
              {listed.map(({ at, title }) => (
                <li key={at}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(at);
                      setPlacesOpen(false);
                    }}
                    className="flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/10"
                  >
                    <span className="min-w-0 truncate font-medium text-white">{title}</span>
                    <span className="shrink-0 text-[0.625rem] text-white/50">
                      {at === town.at
                        ? t("game.overworld.youAreHere")
                        : t("game.town.minutes", { count: worldTownMinutes(town, town.at, at) })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="pointer-events-none absolute left-1/2 top-16 z-10 max-w-[60%] -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-center text-xs font-semibold text-white shadow-lg">
          {settlement?.name}
        </div>
        {!walking && visited && (
          <div
            className="pointer-events-none absolute left-1/2 top-24 z-10 max-w-[60%] -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-center text-xs text-white/85 shadow-lg"
            role="status"
          >
            {t("game.town.walked", { name: visited })}
          </div>
        )}
      </div>
    </>
  );
}
