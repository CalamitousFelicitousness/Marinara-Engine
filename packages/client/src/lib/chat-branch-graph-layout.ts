import type { ChatBranchGraphEntry } from "@marinara-engine/shared";
import { parseChatMetadata } from "./chat-display";
import type { BranchTreeChat, BranchTreeRow } from "./chat-branch-tree";

/** Horizontal room per visible message, and for a collapsed run's "··· N ···" pill. */
export const BRANCH_GRAPH_STEP = 16;
export const BRANCH_GRAPH_GAP_WIDTH = 64;
export const BRANCH_GRAPH_LANE_HEIGHT = 28;
const PAD_X = 12;
/** Messages kept visible on each side of a fork, a lane's start and a tip. */
const CONTEXT = 3;
/** Shorter runs than this stay expanded: a pill that hides five dots saves nothing. */
const MIN_GAP = 10;

export type BranchGraphLane<T extends BranchTreeChat> = {
  chat: T;
  depth: number;
  entry: ChatBranchGraphEntry | null;
  /** Index of the lane's first own message; everything before it is history it shares with its anchor. */
  start: number;
  /** Index of its latest message, or -1 when it has none of its own. */
  tip: number;
  /** One role code per own message, `start..tip`. */
  roles: string;
  /** The lane this one branches off; null for the chat at the top. */
  anchorLane: number | null;
  /**
   * Where on the anchor lane it forks: a message index, or -1 for "before the first message". The top chat
   * has one only when it was branched from a chat that left the group; that fork sits on its own lane.
   */
  forkAt: number | null;
  /** False when the drawn fork is a best guess: an older branch, a deleted parent, or copies that disagree. */
  lineageKnown: boolean;
};

/** A run of message indices the reader unfolded; it stays open even if a new fork cuts it in two. */
export type BranchGraphSpan = { from: number; to: number };

export type BranchGraphColumn =
  { kind: "message"; index: number; x: number } | { kind: "gap"; from: number; to: number; x: number };

export type BranchGraphLayout<T extends BranchTreeChat> = {
  lanes: BranchGraphLane<T>[];
  columns: BranchGraphColumn[];
  /** Collapsed runs, by their first index. */
  gaps: Array<{ from: number; to: number }>;
  width: number;
  height: number;
  /** x of a message index; an index inside a collapsed run sits on its pill, -1 on the start column. */
  xOf: (index: number) => number;
  laneY: (lane: number) => number;
};

/**
 * Lanes in tree order (from `buildChatBranchRows`), one shared message axis, and the columns to draw.
 *
 * Branches copy their history, so each lane draws only its own messages and joins the lane that holds
 * the fork. Long runs collapse on the shared axis rather than per lane, so a fork still lines up with
 * the message it came from. A run never contains a lane's start or tip, so every lane either spans a
 * collapsed run completely or doesn't touch it.
 */
export function layoutChatBranchGraph<T extends BranchTreeChat>(
  rows: readonly BranchTreeRow<T>[],
  entries: ReadonlyMap<string, ChatBranchGraphEntry>,
  expanded: readonly BranchGraphSpan[] | "all",
): BranchGraphLayout<T> {
  const lanes: BranchGraphLane<T>[] = [];
  const lastAtDepth: number[] = [];
  for (const [laneIndex, row] of rows.entries()) {
    const entry = entries.get(row.chat.id) ?? null;
    lastAtDepth[row.depth] = laneIndex;
    lastAtDepth.length = row.depth + 1;
    const treeParent = row.depth > 0 ? (lastAtDepth[row.depth - 1] ?? null) : null;
    const messageCount = entry?.messageCount ?? 0;

    if (treeParent === null) {
      // The top chat owns its whole transcript. If it was itself branched from a chat that has left the
      // group, the server sent roles only after its fork: the copied part is drawn as unknown.
      const ownRoles = entry?.roles ?? "";
      const ownFork = entry?.forkIndex ?? null;
      lanes.push({
        chat: row.chat,
        depth: row.depth,
        entry,
        start: 0,
        tip: messageCount - 1,
        roles: "?".repeat(Math.max(0, messageCount - ownRoles.length)) + ownRoles,
        anchorLane: null,
        forkAt: ownFork !== null && ownFork >= 0 ? ownFork : null,
        lineageKnown: true,
      });
      continue;
    }

    // The tree flattens a branch whose parent is gone under the top chat; it is drawn there, dashed.
    const realParent = lanes[treeParent]!.chat.id === readParentChatId(row.chat);
    const forkIndex = entry?.forkIndex ?? null;
    // The branch's lane starts after its own copy of the fork, so that copy places it. The parent's index
    // for the same message only confirms it: a delete above the fork in either chat makes them disagree.
    const forkAt = forkIndex ?? -1;
    const lineageKnown = forkIndex !== null && realParent && entry?.parentForkIndex === forkIndex;
    // A fork inside history the parent copied belongs on the lane that actually holds that message.
    let anchorLane = treeParent;
    while (forkAt >= 0 && lanes[anchorLane]!.start > forkAt && lanes[anchorLane]!.anchorLane !== null) {
      anchorLane = lanes[anchorLane]!.anchorLane!;
    }
    const start = forkIndex === null ? 0 : forkIndex + 1;
    lanes.push({
      chat: row.chat,
      depth: row.depth,
      entry,
      start,
      tip: messageCount - 1,
      roles: entry?.roles ?? "",
      anchorLane,
      forkAt,
      lineageKnown,
    });
  }

  const maxIndex = Math.max(0, ...lanes.map((lane) => Math.max(lane.tip, lane.start)));
  const kept = new Set<number>();
  const keep = (index: number) => {
    for (let offset = -CONTEXT; offset <= CONTEXT; offset += 1) {
      const near = index + offset;
      if (near >= 0 && near <= maxIndex) kept.add(near);
    }
  };
  keep(0);
  for (const lane of lanes) {
    keep(lane.start);
    if (lane.tip >= 0) keep(lane.tip);
    if (lane.forkAt !== null && lane.forkAt >= 0) keep(lane.forkAt);
  }

  const columns: BranchGraphColumn[] = [];
  const gaps: Array<{ from: number; to: number }> = [];
  const positions = new Array<number>(maxIndex + 1);
  let x = PAD_X;
  const startColumn = lanes.some((lane) => lane.forkAt === -1);
  const startX = x + BRANCH_GRAPH_STEP / 2;
  if (startColumn) x += BRANCH_GRAPH_STEP;
  const pushMessage = (index: number) => {
    positions[index] = x + BRANCH_GRAPH_STEP / 2;
    columns.push({ kind: "message", index, x: positions[index]! });
    x += BRANCH_GRAPH_STEP;
  };
  for (let index = 0; index <= maxIndex;) {
    if (kept.has(index)) {
      pushMessage(index);
      index += 1;
      continue;
    }
    let to = index;
    while (to + 1 <= maxIndex && !kept.has(to + 1)) to += 1;
    const opened = expanded === "all" || expanded.some((span) => span.from <= to && span.to >= index);
    if (to - index + 1 < MIN_GAP || opened) {
      for (let run = index; run <= to; run += 1) pushMessage(run);
    } else {
      const center = x + BRANCH_GRAPH_GAP_WIDTH / 2;
      for (let run = index; run <= to; run += 1) positions[run] = center;
      columns.push({ kind: "gap", from: index, to, x: center });
      gaps.push({ from: index, to });
      x += BRANCH_GRAPH_GAP_WIDTH;
    }
    index = to + 1;
  }

  return {
    lanes,
    columns,
    gaps,
    width: x + PAD_X,
    height: lanes.length * BRANCH_GRAPH_LANE_HEIGHT,
    xOf: (index) => (index < 0 ? startX : (positions[Math.min(index, maxIndex)] ?? startX)),
    laneY: (lane) => lane * BRANCH_GRAPH_LANE_HEIGHT + BRANCH_GRAPH_LANE_HEIGHT / 2,
  };
}

/** Whether a lane draws a collapsed run's pill: runs never hold a lane's start or tip, so it's all or nothing. */
export function laneSpansGap(lane: { start: number; tip: number }, gap: { from: number; to: number }) {
  return lane.start <= gap.from && lane.tip >= gap.to;
}

function readParentChatId(chat: BranchTreeChat): string | null {
  const value = parseChatMetadata(chat.metadata).branchParentChatId;
  return typeof value === "string" && value.trim() ? value : null;
}
