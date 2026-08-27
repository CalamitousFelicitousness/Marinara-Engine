import { characterDataSchema, resolveChatPersonaCandidate } from "@marinara-engine/shared";
import type { createCharactersStorage } from "./storage/characters.storage.js";

type CharactersStorage = ReturnType<typeof createCharactersStorage>;

export type ChatUserIdentity = {
  source: "persona" | "character";
  id: string;
  name: string;
  phoneticName: string;
  description: string;
  personality: string;
  scenario: string;
  backstory: string;
  appearance: string;
  avatarPath: string | null;
  avatarCrop: unknown;
  nameColor: string | null;
  dialogueColor: string | null;
  boxColor: string | null;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function resolveChatUserIdentity(
  storage: CharactersStorage,
  chat: {
    personaId?: string | null;
    personaCharacterId?: string | null;
    mode?: string | null;
  },
): Promise<ChatUserIdentity | null> {
  if (chat.personaCharacterId) {
    const row = await storage.getById(chat.personaCharacterId);
    if (!row) return null;
    let rawData: unknown = row.data;
    if (typeof rawData === "string") {
      try {
        rawData = JSON.parse(rawData);
      } catch {
        return null;
      }
    }
    const parsed = characterDataSchema.safeParse(rawData);
    if (!parsed.success) return null;
    const data = parsed.data;
    const extensions = data.extensions ?? {};
    return {
      source: "character",
      id: row.id,
      name: data.name,
      phoneticName: stringValue(data.phoneticName),
      description: data.description,
      personality: data.personality,
      scenario: data.scenario,
      backstory: stringValue(extensions.backstory),
      appearance: stringValue(extensions.appearance),
      avatarPath: row.avatarPath ?? null,
      avatarCrop: extensions.avatarCrop ?? null,
      nameColor: stringValue(extensions.nameColor) || null,
      dialogueColor: stringValue(extensions.dialogueColor) || null,
      boxColor: stringValue(extensions.boxColor) || null,
    };
  }

  const personas = await storage.listPersonas();
  const persona = resolveChatPersonaCandidate(personas, chat.personaId, chat.mode);
  if (!persona) return null;
  return {
    source: "persona",
    id: persona.id,
    name: persona.name,
    phoneticName: persona.phoneticName ?? "",
    description: persona.description ?? "",
    personality: persona.personality ?? "",
    scenario: persona.scenario ?? "",
    backstory: persona.backstory ?? "",
    appearance: persona.appearance ?? "",
    avatarPath: persona.avatarPath ?? null,
    avatarCrop: persona.avatarCrop ?? null,
    nameColor: persona.nameColor ?? null,
    dialogueColor: persona.dialogueColor ?? null,
    boxColor: persona.boxColor ?? null,
  };
}
