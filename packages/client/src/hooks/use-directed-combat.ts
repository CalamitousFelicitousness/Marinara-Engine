import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { generateClientId } from "../lib/utils";
import type {
  Combatant,
  CombatItemEffect,
  CombatMechanic,
  TacticalBattlefieldBrief,
  DirectedCommand,
  DirectedCombatView,
  RulesetLiveStates,
} from "@marinara-engine/shared";
import { ApiError, api } from "../lib/api-client";
import { rulesetRefusalText } from "../lib/ruleset-combat-log";
import { chatKeys } from "./use-chats";
import { useGameStateStore } from "../stores/game-state.store";
import { useUIStore } from "../stores/ui.store";

/** How long the screen holds between two turns nobody human is playing, so the log reads turn by
 *  turn instead of the whole fight arriving in one frame. */
const RULESET_TURN_PAUSE_MS = 900;

export function useDirectedCombat(input: {
  chatId: string;
  anchor: string;
  style: "classic" | "tactical" | "ruleset";
  party: Combatant[];
  enemies: Combatant[];
  environment?: string;
  formation?: string;
  battlefield?: TacticalBattlefieldBrief;
  /** Whether a fight the ruleset resolves is fought on a board. Sent on the way in and never read
   *  back: what is on screen follows the grid the server sends, not what was asked for. */
  positioned?: boolean;
  mechanics?: CombatMechanic[];
  inventory?: Array<{ name: string; quantity: number }>;
  itemEffects?: CombatItemEffect[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const initial = useRef(input);
  initial.current = input;
  const key = ["directed-combat", input.chatId, input.anchor];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const result = await api.post<{ session: DirectedCombatView }>("/game/combat/director/start", initial.current);
      return result.session;
    },
    staleTime: 0,
    retry: false,
  });
  /** The revision a ruleset refusal was answered at, until the fight moves past it. */
  const refusedRevision = useRef<number | null>(null);
  const mutate = useMutation({
    mutationFn: async (command: DirectedCommand) => {
      const current = qc.getQueryData<DirectedCombatView>(key);
      if (!current) throw new Error("Battle has not loaded.");
      const result = await api.post<{
        session: DirectedCombatView;
        rulesetLive?: RulesetLiveStates;
        stale?: boolean;
      }>("/game/combat/director/command", {
        chatId: input.chatId,
        anchor: input.anchor,
        id: current.id,
        instanceId: current.instanceId,
        revision: current.revision,
        requestId: generateClientId(),
        command,
        debugMode: useUIStore.getState().debugMode,
      });
      return result;
    },
    onSuccess: ({ session, rulesetLive, stale }) => {
      void qc.invalidateQueries({ queryKey: chatKeys.detail(input.chatId) });
      // The server already wrote the party's sheets inside the step it accepted, so this is the
      // store catching up with what is on disk, never a second write: the in-game sheet is right
      // the moment the blow lands, with no refetch behind it.
      if (rulesetLive) {
        const store = useGameStateStore.getState();
        const current = store.current;
        if (current?.chatId === input.chatId) store.setGameState({ ...current, rulesetLive });
      }
      // The fight had moved on without this screen (a restart, another tab): what was sent did
      // nothing, so it is said, and the fight is shown as the server has it, older or not.
      if (stale) {
        toast.info(t("game.combat.staleCommand"));
        qc.setQueryData<DirectedCombatView>(key, session);
        return;
      }
      qc.setQueryData<DirectedCombatView>(key, (current) =>
        !current ||
        current.id !== session.id ||
        current.instanceId !== session.instanceId ||
        session.revision >= current.revision
          ? session
          : current,
      );
    },
    onError: (error) => {
      // A refusal is the rules saying no, not a broken battle: it changed nothing on the server, so
      // it is said once and the fight stays exactly where it was.
      if (!(error instanceof ApiError) || error.status !== 400) return;
      const payload = error.payload as { error?: unknown; code?: unknown } | undefined;
      const code = typeof payload?.code === "string" ? payload.code : undefined;
      if (!code?.startsWith("ruleset_combat_")) return;
      toast.warning(rulesetRefusalText(code, error.message, t));
      // Remember WHICH state was refused before the error is cleared: a refusal changes nothing, so
      // the revision stays where it was, and autoplay must not send the same thing at it again
      // every pause (a toast a second, for ever). It picks up once the fight has moved.
      refusedRevision.current = qc.getQueryData<DirectedCombatView>(key)?.revision ?? null;
      mutate.reset();
    },
  });
  const send = mutate.mutate;
  // A `continue` the screen sends by itself (a turn played, a Game Master's window driven) is not
  // the player being busy: a choice made while one is in flight waits for it and then goes, rather
  // than landing on a button that was disabled for the moment the poll took ("Let it go by" that
  // needed a second click).
  const polling = mutate.isPending && mutate.variables?.type === "continue";
  // Every choice waiting, in order: switching several companions to AI while a turn plays keeps each
  // switch (re-test 2026-10-23: all but the last were lost). A switch or an order sent while
  // anything is in flight waits too, so it goes out at the fight's newest revision.
  const queued = useRef<Array<Parameters<typeof send>[0]>>([]);
  const [waiting, setWaiting] = useState(0);
  const choose = useCallback(
    (command: Parameters<typeof send>[0]) => {
      const keeps = command.type === "control" || command.type === "orders";
      if ((polling && command.type !== "continue") || (keeps && (mutate.isPending || queued.current.length > 0))) {
        queued.current.push(command);
        setWaiting(queued.current.length);
        return;
      }
      send(command);
    },
    [polling, send, mutate.isPending],
  );
  useEffect(() => {
    if (mutate.isPending || queued.current.length === 0) return;
    const command = queued.current.shift()!;
    setWaiting(queued.current.length);
    send(command);
  }, [mutate.isPending, send, waiting]);
  useEffect(() => {
    if (queued.current.length) return;
    if (!query.data?.window || query.data.window.controller !== "gm" || mutate.isPending || mutate.isError) return;
    const timer = setTimeout(() => send({ type: "continue" }), query.data.window.requestedAt ? 1200 : 0);
    return () => clearTimeout(timer);
  }, [query.data, mutate.isPending, mutate.isError, send]);
  // A ruleset fight plays itself while nobody human holds the actor on turn: one `continue` is one
  // turn, and the pause between them is what makes the log readable. It stops the moment the turn
  // reaches a player, and it hands a boss over by opening its window, which the effect above then
  // drives exactly as it drives the other two styles.
  const ruleset = query.data?.style === "ruleset" ? query.data.ruleset : undefined;
  const autoplay = !!ruleset && !query.data?.window && !query.data?.outcome && ruleset.controller !== "manual";
  useEffect(() => {
    if (queued.current.length || !autoplay || mutate.isPending || mutate.isError) return;
    if (refusedRevision.current !== null && refusedRevision.current === query.data?.revision) return;
    refusedRevision.current = null;
    const timer = setTimeout(() => send({ type: "continue" }), RULESET_TURN_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [autoplay, query.data?.revision, mutate.isPending, mutate.isError, send]);
  // A switch or an order shows the moment it is made, while it waits its turn to be sent (re-test
  // 2026-10-23: "Heal first" took five seconds to tick).
  const pending = [...(mutate.isPending && mutate.variables ? [mutate.variables] : []), ...queued.current];
  const session =
    query.data && pending.some((command) => command.type === "control" || command.type === "orders")
      ? {
          ...query.data,
          party: query.data.party.map((unit) =>
            pending.reduce((member, command) => {
              if (command.type === "control" && command.unitId === member.id)
                return { ...member, controller: command.controller };
              if (command.type === "orders" && command.unitId === member.id) {
                const { orders: _orders, ...rest } = member;
                return command.orders ? { ...rest, orders: command.orders } : rest;
              }
              return member;
            }, unit),
          ),
        }
      : query.data;
  return {
    session,
    error: query.error ?? mutate.error,
    loading: query.isPending,
    busy: mutate.isPending && !polling,
    send: choose,
    refresh: () => {
      mutate.reset();
      return query.refetch();
    },
  };
}
