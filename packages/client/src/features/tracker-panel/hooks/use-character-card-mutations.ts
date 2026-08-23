// ──────────────────────────────────────────────
// Character card mutations
// ──────────────────────────────────────────────
// Both card layouts edit the same PresentCharacter. Until this hook existed each
// carried its own copy of these handlers, and the copies had already drifted:
// the compact removeCustomField typed its working object Record<string, unknown>
// while the featured one cast at the onUpdate call, and the featured card had a
// thoughts-only specialisation of the compact card's generic hidden-field toggle.
//
// Lock and hidden-field updaters come from TrackerLockContext, not arguments.
// Both cards already consume that context, so taking them as parameters would
// re-drill what is in scope and let the two call sites pass different updaters.

import { useMemo } from "react";
import {
  characterCustomFieldTrackerLockKey,
  characterTrackerLockKey,
  isTrackerFieldHidden,
  normalizeTrackerFieldLocks,
  normalizeTrackerHiddenFields,
  readCharacterExtras,
  removeTrackerFieldLockPrefix,
  renameTrackerFieldLockPrefix,
  type PresentCharacter,
} from "@marinara-engine/shared";
import {
  makeUniqueCharacterCustomFieldName,
  normalizeCharacterCustomFieldName,
  resolveCharacterCustomFieldName,
} from "../lib/character-custom-field-names";
import { trackerEditableText } from "../lib/tracker-display";
import { useTrackerLockContext } from "../components/TrackerLockContext";

/** Flat character fields the hide control can retire. */
export type HideableCharacterField = "mood" | "appearance" | "outfit" | "thoughts";

/**
 * Clears a hidden field so it stops reaching the prompt. One entry per field
 * rather than a value lookup: `mood` is `string` while the rest are `string |
 * null`, and a computed-key spread (`{ ...c, [field]: value }`) widens, so the
 * compiler would not catch `mood: null`. Each literal key here is checked.
 */
const CLEAR_HIDDEN_FIELD: Record<HideableCharacterField, (character: PresentCharacter) => PresentCharacter> = {
  mood: (character) => ({ ...character, mood: "" }),
  appearance: (character) => ({ ...character, appearance: null }),
  outfit: (character) => ({ ...character, outfit: null }),
  thoughts: (character) => ({ ...character, thoughts: null }),
};

/** `[name, rawValue, editableText]` per custom field, in insertion order. */
export type CharacterCustomFieldEntry = readonly [string, unknown, string];

export function readCharacterCustomFieldEntries(character: PresentCharacter): CharacterCustomFieldEntry[] {
  return Object.entries((character.customFields ?? {}) as Record<string, unknown>).map(
    ([name, value]) => [name, value, trackerEditableText(value)] as const,
  );
}

/**
 * Lock keys are prefixed per custom field; the `.name` suffix is stripped to get
 * the prefix covering both the name and value keys.
 */
function customFieldLockPrefix(character: PresentCharacter, characterIndex: number, name: string) {
  return characterCustomFieldTrackerLockKey(character, characterIndex, name, "name").replace(/\.name$/u, "");
}

export interface CharacterCardMutations {
  /** Rename and/or re-value one custom field. A rename onto an existing name is a no-op. */
  updateCustomField: (oldName: string, nextName: string, nextValue: unknown) => void;
  addCustomField: () => void;
  removeCustomField: (name: string) => void;
  addCharacterStat: () => void;
  /** Whole-surface extras write. Keys dropped by the editor must not survive the spread. */
  replaceExtras: (nextExtras: Record<string, unknown>) => void;
  isFieldHidden: (field: HideableCharacterField) => boolean;
  /** Hides or reveals a field, and clears its value on hide so it stops reaching the prompt. */
  toggleFieldHidden: (field: HideableCharacterField) => void;
}

export function useCharacterCardMutations({
  character,
  characterIndex,
  onUpdate,
}: {
  character: PresentCharacter;
  characterIndex: number;
  onUpdate: (character: PresentCharacter) => void;
}): CharacterCardMutations {
  const { hiddenTrackerFields, onUpdateFieldLocks, onUpdateHiddenFields } = useTrackerLockContext();

  return useMemo(() => {
    // The declared type is Record<string, string>, but a tracker agent writes
    // arbitrary JSON here -- hence trackerEditableText on the read side. The cast
    // is the one place that mismatch is acknowledged.
    const writeCustomFields = (nextFields: Record<string, unknown>) =>
      onUpdate({ ...character, customFields: nextFields as Record<string, string> });

    return {
      updateCustomField(oldName, nextName, nextValue) {
        const nextFields: Record<string, unknown> = { ...(character.customFields ?? {}) };
        const trimmedName = resolveCharacterCustomFieldName(nextName, oldName);
        if (
          trimmedName !== oldName &&
          Object.keys(nextFields).some(
            (name) =>
              name !== oldName &&
              normalizeCharacterCustomFieldName(name) === normalizeCharacterCustomFieldName(trimmedName),
          )
        ) {
          return;
        }
        if (trimmedName !== oldName) {
          onUpdateFieldLocks?.((locks) =>
            renameTrackerFieldLockPrefix(
              locks,
              customFieldLockPrefix(character, characterIndex, oldName),
              customFieldLockPrefix(character, characterIndex, trimmedName),
            ),
          );
        }
        delete nextFields[oldName];
        nextFields[trimmedName] = nextValue;
        writeCustomFields(nextFields);
      },

      addCustomField() {
        const name = makeUniqueCharacterCustomFieldName(character.customFields);
        writeCustomFields({ ...(character.customFields ?? {}), [name]: "" });
      },

      removeCustomField(name) {
        const nextFields: Record<string, unknown> = { ...(character.customFields ?? {}) };
        delete nextFields[name];
        onUpdateFieldLocks?.((locks) =>
          removeTrackerFieldLockPrefix(locks, customFieldLockPrefix(character, characterIndex, name)),
        );
        writeCustomFields(nextFields);
      },

      addCharacterStat() {
        const stats = Array.isArray(character.stats) ? character.stats : [];
        onUpdate({
          ...character,
          stats: [...stats, { name: "New Stat", value: 0, max: 100, color: "var(--primary)" }],
        });
      },

      replaceExtras(nextExtras) {
        const base: Record<string, unknown> = { ...character };
        for (const key of Object.keys(readCharacterExtras(character))) delete base[key];
        onUpdate({ ...base, ...nextExtras } as unknown as PresentCharacter);
      },

      isFieldHidden(field) {
        return isTrackerFieldHidden(hiddenTrackerFields, characterTrackerLockKey(character, characterIndex, field));
      },

      toggleFieldHidden(field) {
        const key = characterTrackerLockKey(character, characterIndex, field);
        const nextHidden = !isTrackerFieldHidden(hiddenTrackerFields, key);
        onUpdateHiddenFields?.((hiddenFields) => {
          const next = normalizeTrackerHiddenFields(hiddenFields);
          if (nextHidden) next[key] = true;
          else delete next[key];
          return next;
        });
        // Hiding also locks: an unlocked hidden field is re-emitted by the next
        // tracker run and reappears the moment hide mode is turned off.
        onUpdateFieldLocks?.((locks) => {
          const next = normalizeTrackerFieldLocks(locks);
          if (nextHidden) next[key] = true;
          else delete next[key];
          return next;
        });
        if (nextHidden) onUpdate(CLEAR_HIDDEN_FIELD[field](character));
      },
    };
  }, [character, characterIndex, hiddenTrackerFields, onUpdate, onUpdateFieldLocks, onUpdateHiddenFields]);
}
