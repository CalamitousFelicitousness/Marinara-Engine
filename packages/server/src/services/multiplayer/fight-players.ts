import { normalizeCharacterLookupName, type DirectedRulesetPlayer } from "@marinara-engine/shared";
import { record } from "./room-projection.js";

/** Who plays another room player's own character as a fight begins (2026-10-26). The Engine, while the
 *  room protocol cannot carry a guest's fight commands: their character would otherwise stand waiting
 *  on a player who has no way to answer. Becomes "manual" once guests see and command their fights. */
export const ROOM_GUEST_FIGHT_CONTROLLER: "manual" | "ai" = "ai";

/**
 * The room player whose own character each name is, by the name's lookup key (2026-10-26), read from the
 * host's live room: a player's character is the game card bound to them, else their persona's name. A
 * room that has ended, or a chat that is no room, has no players, and the host commands the whole party
 * as in a solo game. Two players whose characters share a name are left out rather than guessed between.
 */
export function roomPlayersByName(
  metadata: Record<string, unknown>,
): Record<string, DirectedRulesetPlayer> | undefined {
  const room = record(metadata.multiplayer);
  if (room.version !== 1 || room.role !== "host" || room.status === "ended" || !Array.isArray(room.participants))
    return undefined;
  const cards = Array.isArray(metadata.gameCharacterCards) ? metadata.gameCharacterCards.map(record) : [];
  const players: Record<string, DirectedRulesetPlayer> = {};
  const shared = new Set<string>();
  for (const participant of room.participants.map(record)) {
    if (typeof participant.id !== "string" || !participant.id) continue;
    const bound = cards.find((card) => card.multiplayerParticipantId === participant.id);
    const name = typeof bound?.name === "string" ? bound.name : record(participant.persona).name;
    const key = typeof name === "string" ? normalizeCharacterLookupName(name) : "";
    if (!key) continue;
    if (players[key]) shared.add(key);
    const displayName =
      typeof participant.displayName === "string" && participant.displayName.trim()
        ? participant.displayName.trim().slice(0, 80)
        : String(name).slice(0, 80);
    players[key] = {
      participantId: participant.id,
      name: displayName,
      ...(participant.isHost === true ? { host: true as const } : {}),
    };
  }
  for (const key of shared) delete players[key];
  return Object.keys(players).length > 0 ? players : undefined;
}

/** The same, by party member id: the one member carrying each player's character's name, never a guess
 *  between two members of one name. */
export function roomFightPlayers(
  metadata: Record<string, unknown>,
  party: ReadonlyArray<{ id: string; name: string }>,
): Record<string, DirectedRulesetPlayer> | undefined {
  const byName = roomPlayersByName(metadata);
  if (!byName) return undefined;
  const players: Record<string, DirectedRulesetPlayer> = {};
  for (const [key, player] of Object.entries(byName)) {
    const matches = party.filter((member) => normalizeCharacterLookupName(member.name) === key);
    if (matches.length === 1) players[matches[0]!.id] = player;
  }
  return Object.keys(players).length > 0 ? players : undefined;
}
