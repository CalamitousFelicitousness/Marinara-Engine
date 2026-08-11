export interface CapabilityConversationCommandRegistration {
  commandType: string;
  tags: string[];
  maxPayloadChars?: number;
  handler?: (action: CapabilityConversationAction) => void | Promise<void>;
}

export interface CapabilityConversationAction {
  type: "capability";
  commandType: string;
  payload: string | null;
  chatId: string;
  sourceMessageId: string;
  characterId: string | null;
}

const tagToCommandType = new Map<string, string>();
const handlersByCommandType = new Map<string, CapabilityConversationCommandRegistration["handler"]>();
const payloadLimitsByCommandType = new Map<string, number>();

export function registerCapabilityConversationCommand(
  registration: CapabilityConversationCommandRegistration,
): () => void {
  const commandType = registration.commandType.trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(commandType)) throw new Error("Capability command type is invalid");
  const tags = registration.tags.map((tag) => tag.trim().toLocaleLowerCase());
  if (tags.length === 0 || tags.some((tag) => !/^[a-z][a-z0-9_-]*$/.test(tag))) {
    throw new Error("Capability command tag is invalid");
  }
  for (const tag of tags) {
    if (tagToCommandType.has(tag)) throw new Error(`Conversation command tag ${tag} is already registered`);
    tagToCommandType.set(tag, commandType);
  }
  if (registration.handler) handlersByCommandType.set(commandType, registration.handler);
  payloadLimitsByCommandType.set(commandType, Math.max(0, Math.min(registration.maxPayloadChars ?? 2_000, 8_000)));
  return () => {
    for (const tag of tags) {
      if (tagToCommandType.get(tag) === commandType) tagToCommandType.delete(tag);
    }
    if (handlersByCommandType.get(commandType) === registration.handler) handlersByCommandType.delete(commandType);
    payloadLimitsByCommandType.delete(commandType);
  };
}

export function parseCapabilityConversationCommands(content: string) {
  const commands: Array<{ type: "capability"; commandType: string; payload: string | null }> = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/\[([a-z][a-z0-9_-]*)(?::([^\]\r\n]*))?\]/gi)) {
    const commandType = tagToCommandType.get(match[1]!.toLocaleLowerCase());
    if (!commandType || seen.has(commandType)) continue;
    seen.add(commandType);
    const rawPayload = match[2]?.trim() || null;
    const maxPayloadChars = payloadLimitsByCommandType.get(commandType) ?? 2_000;
    commands.push({
      type: "capability",
      commandType,
      payload: rawPayload && rawPayload.length <= maxPayloadChars ? rawPayload : null,
    });
  }
  return commands;
}

export async function dispatchCapabilityConversationAction(action: CapabilityConversationAction): Promise<boolean> {
  const handler = handlersByCommandType.get(action.commandType);
  if (!handler) return false;
  await handler(action);
  return true;
}

export function stripCapabilityConversationCommands(content: string) {
  return content.replace(/\[([a-z][a-z0-9_-]*)(?::[^\]\r\n]*)?\]/gi, (match, tag: string) =>
    tagToCommandType.has(tag.toLocaleLowerCase()) ? "" : match,
  );
}
