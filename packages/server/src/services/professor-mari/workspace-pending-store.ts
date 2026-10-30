// ──────────────────────────────────────────────
// Professor Mari: messages queued while she works
// ──────────────────────────────────────────────
// One JSON file per chat under DATA_DIR/storage/mari-pending. Attachments can be 20 MB each, so this stays out
// of chat metadata (every chat load would pay for it) and out of a table. Her file tools and shell cannot reach
// the folder: workspacePathAccessPolicy calls it forbidden. Nothing here is a "held" flag; a pending message
// with no run going is held by definition, so a restart leaves them waiting and nothing auto-sends.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { MariPendingMessage, MariPendingMessageSummary } from "@marinara-engine/shared";
import { getFileStorageDir } from "../../config/runtime-config.js";
import { logger } from "../../lib/logger.js";

/** How a prompt() run ended. Only "finished" lets the next queued message go. */
export type MariPromptOutcome = "finished" | "stopped";

export const MAX_PENDING_MESSAGES_PER_CHAT = 20;

/** Chat ids go into a file path, so anything outside this shape is refused rather than cleaned. */
const SAFE_CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class MariPendingStoreError extends Error {
  constructor(
    readonly code: "bad_chat_id" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "MariPendingStoreError";
  }
}

/** The folder the queued messages live in. The file tools' access policy refuses everything under it. */
export function getMariPendingDir() {
  return resolve(getFileStorageDir(), "mari-pending");
}

export function isSafePendingChatId(chatId: string) {
  return SAFE_CHAT_ID.test(chatId);
}

function pendingFilePath(chatId: string) {
  if (!isSafePendingChatId(chatId)) {
    throw new MariPendingStoreError("bad_chat_id", "That chat id cannot be used for queued messages.");
  }
  // The id check already rules out a way out of the folder; this is the same rule in the shape scanners can follow.
  const folder = resolve(getMariPendingDir());
  const path = resolve(folder, `${chatId}.json`);
  if (!path.startsWith(`${folder}${sep}`)) {
    throw new MariPendingStoreError("bad_chat_id", "That chat id cannot be used for queued messages.");
  }
  return path;
}

// Writes for one chat run one at a time, so two quick adds never read the same list and drop one.
const chains = new Map<string, Promise<unknown>>();

function serialized<T>(chatId: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(chatId) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => undefined);
  chains.set(chatId, tail);
  void tail.then(() => {
    if (chains.get(chatId) === tail) chains.delete(chatId);
  });
  return run;
}

function isPendingMessage(value: unknown): value is MariPendingMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.text === "string" &&
    typeof record.createdAt === "string" &&
    Array.isArray(record.attachments) &&
    Array.isArray(record.references)
  );
}

async function readList(path: string): Promise<MariPendingMessage[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    // Not "empty": the next write would replace messages that are only briefly unreadable.
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPendingMessage) : [];
  } catch (err) {
    logger.warn(err, "[professor-mari] The queued messages at %s are unreadable; treating them as empty", path);
    return [];
  }
}

async function writeList(path: string, list: MariPendingMessage[]) {
  if (list.length === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(getMariPendingDir(), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(list), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (err) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function listPending(chatId: string): Promise<MariPendingMessage[]> {
  const path = pendingFilePath(chatId);
  return serialized(chatId, () => readList(path));
}

export async function addPending(
  chatId: string,
  input: Pick<MariPendingMessage, "text"> & Partial<Pick<MariPendingMessage, "attachments" | "references" | "context">>,
): Promise<MariPendingMessage> {
  const path = pendingFilePath(chatId);
  return serialized(chatId, async () => {
    const list = await readList(path);
    if (list.length >= MAX_PENDING_MESSAGES_PER_CHAT) {
      throw new MariPendingStoreError(
        "limit",
        `You can queue up to ${MAX_PENDING_MESSAGES_PER_CHAT} messages for Professor Mari. Send or remove one first.`,
      );
    }
    const message: MariPendingMessage = {
      id: randomUUID(),
      text: input.text,
      createdAt: new Date().toISOString(),
      attachments: input.attachments ?? [],
      references: input.references ?? [],
      ...(input.context ? { context: input.context } : {}),
    };
    await writeList(path, [...list, message]);
    return message;
  });
}

/** Removes one message by id; null when it is already gone. */
export async function removePending(chatId: string, id: string): Promise<MariPendingMessage | null> {
  return takePending(chatId, id);
}

/** Takes the oldest message that is not held out of the queue, or null when there is none. */
export async function takeNextPending(chatId: string): Promise<MariPendingMessage | null> {
  const path = pendingFilePath(chatId);
  return serialized(chatId, async () => {
    const list = await readList(path);
    const next = list.find((message) => !message.held);
    if (!next) return null;
    await writeList(
      path,
      list.filter((message) => message !== next),
    );
    return next;
  });
}

/**
 * A new send begins: what still waits was held back by something earlier, and stays until its own Send. `exceptIds`
 * is what the client queued after you pressed Send. Everything else is held, even a row the client never saw: the
 * safe side, since a held message only needs a click.
 */
export async function holdPending(chatId: string, exceptIds: readonly string[] = []): Promise<void> {
  const path = pendingFilePath(chatId);
  const covers = (message: MariPendingMessage) => !exceptIds.includes(message.id);
  return serialized(chatId, async () => {
    const list = await readList(path);
    if (!list.some((message) => !message.held && covers(message))) return;
    await writeList(
      path,
      list.map((message) => (covers(message) ? { ...message, held: true } : message)),
    );
  });
}

/** Takes one message by id, whatever its place in the queue; null when it is gone. */
export async function takePending(chatId: string, id: string): Promise<MariPendingMessage | null> {
  const path = pendingFilePath(chatId);
  return serialized(chatId, async () => {
    const list = await readList(path);
    const found = list.find((message) => message.id === id) ?? null;
    if (!found) return null;
    await writeList(
      path,
      list.filter((message) => message.id !== id),
    );
    return found;
  });
}

/** Puts a taken message back in its typed place: the drain lost the race for the slot and must not lose it. */
export async function restorePending(chatId: string, message: MariPendingMessage): Promise<void> {
  const path = pendingFilePath(chatId);
  return serialized(chatId, async () => {
    const list = await readList(path);
    const later = list.findIndex((other) => other.createdAt > message.createdAt);
    const at = later === -1 ? list.length : later;
    await writeList(path, [...list.slice(0, at), message, ...list.slice(at)]);
  });
}

/** Empties the queue and hands everything back, attachments included (Stop returns it to the composer). */
export async function clearPending(chatId: string): Promise<MariPendingMessage[]> {
  const path = pendingFilePath(chatId);
  return serialized(chatId, async () => {
    const list = await readList(path);
    await writeList(path, []);
    return list;
  });
}

// /status polls this. A queue with big attachments is not parsed again until its file changes.
const summaryCache = new Map<string, { mtimeMs: number; size: number; summaries: MariPendingMessageSummary[] }>();

/** The list as summaries for /status. An absent file costs one stat; an unchanged one costs a stat too. */
export async function listPendingSummaries(chatId: string): Promise<MariPendingMessageSummary[]> {
  const path = pendingFilePath(chatId);
  let stats;
  try {
    stats = await stat(path);
  } catch {
    summaryCache.delete(chatId);
    return [];
  }
  const cached = summaryCache.get(chatId);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.summaries;
  const summaries = (await listPending(chatId)).map(summarizePending);
  summaryCache.set(chatId, { mtimeMs: stats.mtimeMs, size: stats.size, summaries });
  return summaries;
}

/** Deletes a chat's file. Best effort for the caller: a chat delete never fails on this. */
export async function deletePendingForChat(chatId: string): Promise<void> {
  const path = pendingFilePath(chatId);
  return serialized(chatId, () => rm(path, { force: true }));
}

/** The shape /status and the pending routes send: no attachment data (a poll must stay small). */
export function summarizePending(message: MariPendingMessage): MariPendingMessageSummary {
  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({
      name: attachment.name ?? attachment.filename ?? "attachment",
      type: attachment.type,
    })),
  };
}

/**
 * After a run, sends queued messages one at a time on the same reply. It continues only while the last run
 * "finished" and nobody else holds the slot (Decision 18: a drain never aborts another run, in this chat or
 * another). A run that throws propagates to the caller; the message it took is already saved as a user row by
 * prompt(), so it stays in the transcript with the normal failure and Retry, and the later ones stay held.
 */
export async function drainPendingMessages(args: {
  chatId: string;
  outcome: MariPromptOutcome;
  isBusy: () => boolean;
  takeNext: () => Promise<MariPendingMessage | null>;
  runPrompt: (message: MariPendingMessage) => Promise<MariPromptOutcome>;
  onNext: (message: MariPendingMessage) => void;
  /** Called when a run took the slot while the next message was being read; it goes back to the front. */
  putBack?: (message: MariPendingMessage) => Promise<void>;
}) {
  let outcome = args.outcome;
  while (outcome === "finished") {
    if (args.isBusy()) return;
    const next = await args.takeNext();
    if (!next) return;
    if (args.isBusy()) {
      await args.putBack?.(next);
      return;
    }
    args.onNext(next);
    outcome = await args.runPrompt(next);
  }
}
