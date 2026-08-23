// ──────────────────────────────────────────────
// Shared character card tail
// ──────────────────────────────────────────────
// Custom fields then nested extras, rendered identically by both card layouts.
// These two sections trail the card body in the compact and the featured card
// alike, so they belong to one component: a third trailing section can now only
// be added once.
//
// That is the fix for a shipped bug, not tidiness. CharacterTrackerExtras was
// mounted in the compact card only, so a featured card rendered none of the
// nested data the tracker agent had already stored.
//
// Stats deliberately stay out. The featured card places its StatList inside the
// portrait grid, beside the portrait, not after the body -- the position differs,
// so sharing it would mean parameterising layout rather than sharing it.

import { X } from "lucide-react";
import {
  characterCustomFieldTrackerLockKey,
  characterTrackerLockPrefix,
  isBlankTrackerValue,
  isTrackerFieldLocked,
  readCharacterExtras,
  type PresentCharacter,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../../../lib/utils";
import { TRACKER_ROW_CLASS, TRACKER_ROW_WITH_ACTION_CLASS } from "../../lib/tracker-row-layout";
import { readCharacterCustomFieldEntries, type CharacterCardMutations } from "../../hooks/use-character-card-mutations";
import { InlineAddRow, InlineEdit } from "../controls/InlineControls";
import { useTrackerLockContext } from "../TrackerLockContext";
import { useTrackerBlankValues } from "../../hooks/use-tracker-blank-values";
import { CharacterTrackerExtras } from "./CharacterTrackerExtras";

export type CharacterCardVariant = "compact" | "featured";

/**
 * Per-variant chrome, kept side by side so a change to one is visible against
 * the other. Font size lives on the list wrapper, never per row -- a per-row
 * override resolves `rem` against the app root and lands near 6px.
 */
const CUSTOM_FIELD_LIST_CLASS: Record<CharacterCardVariant, string> = {
  compact:
    "relative z-[1] mt-1 grid gap-px border-t border-[color-mix(in_srgb,var(--tracker-profile-rule)_34%,transparent)] pt-1 text-[length:var(--tracker-fs-0-5625)] @min-[176px]:text-[length:var(--tracker-fs-0-625)]",
  featured:
    "relative z-[1] mx-1 mb-1 mt-1 grid gap-px border-t border-[var(--tracker-profile-rule)] pt-0.5 text-[length:var(--tracker-fs-0-625)]",
};

const CUSTOM_FIELD_ROW_CLASS: Record<CharacterCardVariant, string> = {
  compact: TRACKER_ROW_CLASS,
  featured: cn(TRACKER_ROW_CLASS, "border-b border-[var(--tracker-profile-rule)] px-0.5 py-px last:border-b-0"),
};

const EXTRAS_WRAPPER_CLASS: Record<CharacterCardVariant, string | undefined> = {
  compact: undefined,
  featured: "mx-1 mb-1",
};

const REMOVE_FIELD_BUTTON_CLASS =
  "flex h-5 w-5 items-center justify-center justify-self-end rounded text-[var(--destructive)] transition-all hover:bg-[var(--destructive)]/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border)] active:scale-90 [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6";

export function CharacterCardSections({
  character,
  characterIndex,
  mutations,
  variant,
  deleteMode,
  addMode,
  readable,
}: {
  character: PresentCharacter;
  characterIndex: number;
  mutations: CharacterCardMutations;
  variant: CharacterCardVariant;
  deleteMode: boolean;
  addMode: boolean;
  /** Wrap values to two lines instead of scrolling one on hover. */
  readable: boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  const { fieldLocks, lockMode, onToggleFieldLock } = useTrackerLockContext();
  // A prompt-authored field that does not apply comes back as a placeholder
  // rather than absent. Edit mode still shows them so they can be typed over.
  const blanks = useTrackerBlankValues();
  const customFields = readCharacterCustomFieldEntries(character).filter(
    ([, rawValue]) => addMode || !isBlankTrackerValue(rawValue, blanks),
  );
  const characterExtras = readCharacterExtras(character);
  const extrasWrapperClass = EXTRAS_WRAPPER_CLASS[variant];

  const lockProps = (name: string, field: "name" | "value") => {
    const key = characterCustomFieldTrackerLockKey(character, characterIndex, name, field);
    return {
      locked: isTrackerFieldLocked(fieldLocks, key),
      lockMode,
      onToggleLock: onToggleFieldLock ? () => onToggleFieldLock(key) : undefined,
    };
  };

  const extras = (
    <CharacterTrackerExtras
      extras={characterExtras}
      lockPrefix={characterTrackerLockPrefix(character, characterIndex)}
      addMode={addMode}
      deleteMode={deleteMode}
      readable={readable}
      onChange={mutations.replaceExtras}
    />
  );

  return (
    <>
      {(customFields.length > 0 || addMode) && (
        <div className={CUSTOM_FIELD_LIST_CLASS[variant]}>
          {customFields.map(([name, rawValue, displayValue]) => (
            <div
              key={name}
              className={cn(CUSTOM_FIELD_ROW_CLASS[variant], deleteMode && TRACKER_ROW_WITH_ACTION_CLASS)}
            >
              <InlineEdit
                value={name}
                onSave={(nextName) => mutations.updateCustomField(name, nextName, rawValue)}
                placeholder={localizeUi("ui.trackerPanel.charactertrackercard.field")}
                ariaLabel={`${name} field name`}
                className="min-w-0 px-0.5 py-0 font-medium"
                scrollOnHover
                {...lockProps(name, "name")}
              />
              <InlineEdit
                value={displayValue}
                onSave={(nextValue) => mutations.updateCustomField(name, name, nextValue)}
                placeholder={localizeUi("ui.trackerPanel.charactertrackercard.value")}
                ariaLabel={`${name} value`}
                className="min-w-0 px-0.5 py-0"
                scrollOnHover={!readable}
                twoLinePreview={readable}
                {...lockProps(name, "value")}
              />
              {deleteMode && (
                <button
                  type="button"
                  onClick={() => mutations.removeCustomField(name)}
                  title={localizeUi("ui.trackerPanel.charactertrackercard.removeValue1", { value1: name })}
                  aria-label={localizeUi("ui.trackerPanel.charactertrackercard.removeValue1", { value1: name })}
                  className={REMOVE_FIELD_BUTTON_CLASS}
                >
                  <X size="0.625rem" />
                </button>
              )}
            </div>
          ))}
          {addMode && (
            <InlineAddRow
              title={localizeUi("ui.trackerPanel.charactertrackercard.addCustomField")}
              onClick={mutations.addCustomField}
              className="col-span-full"
            />
          )}
        </div>
      )}

      {extrasWrapperClass ? <div className={extrasWrapperClass}>{extras}</div> : extras}
    </>
  );
}
