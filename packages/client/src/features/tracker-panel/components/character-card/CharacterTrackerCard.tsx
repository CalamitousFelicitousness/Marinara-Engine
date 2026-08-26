import type { ReactNode } from "react";
import { ChevronDown, Eye, HeartPulse, Maximize2, Shirt, X } from "lucide-react";
import {
  characterStatTrackerLockKey,
  characterTrackerLockKey,
  isTrackerFieldLocked,
  type PresentCharacter,
} from "@marinara-engine/shared";
import type { TrackerPanelSizeProfile, TrackerStatDisplayMode } from "../../../../stores/ui.store";
import { cn } from "../../../../lib/utils";
import { useRenderTimer } from "../../../../lib/perf-diagnostics";
import type { StatIconLookup } from "../../hooks/use-stat-icons";
import { visibleText } from "../../lib/tracker-display";
import { TRACKER_DETAIL_TEXT_CLASS, TRACKER_DETAIL_VALUE_CLAMP_CLASS } from "../../lib/tracker-row-layout";
import {
  readCharacterCustomFieldEntries,
  useCharacterCardMutations,
  type HideableCharacterField,
} from "../../hooks/use-character-card-mutations";
import { getCharacterAmbienceStyle, type TrackerProfileColors } from "../../lib/tracker-profile-style";
import { InlineEdit } from "../controls/InlineControls";
import {
  TrackerProfileDisplayWash,
  TrackerProfileEdgeHighlight,
  TrackerReadabilityVeil,
} from "../controls/TrackerProfileChrome";
import { StatList } from "../controls/StatList";
import { useTrackerFieldLock, useTrackerLockContext } from "../TrackerLockContext";
import { CharacterCardSections } from "./CharacterCardSections";
import { CharacterTrackerAvatar } from "./CharacterTrackerAvatar";
import { COMPACT_CHARACTER_MOOD_EDIT_CLASS, CompactCharacterField } from "./CharacterTrackerField";
import { useTranslation as useUiTranslation } from "react-i18next";

const CHARACTER_CARD_CLASS =
  "group/character @container relative isolate h-full min-w-0 overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--tracker-profile-rule)_52%,transparent)] bg-[image:var(--tracker-profile-material)] p-0.5 shadow-[0_0_9px_color-mix(in_srgb,var(--tracker-profile-dialogue-glow)_13%,transparent),inset_0_1px_0_color-mix(in_srgb,var(--foreground)_4%,transparent),inset_0_-1px_0_color-mix(in_srgb,var(--background)_24%,transparent)] transition-colors duration-200 hover:border-[color-mix(in_srgb,var(--foreground)_18%,var(--tracker-profile-rule)_82%)] [background-blend-mode:var(--tracker-profile-material-blend)]";
const CHARACTER_CARD_TONE_OVERLAY_CLASS =
  "pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_22%_12%,color-mix(in_srgb,var(--tracker-profile-nameplate-glow)_10%,transparent),transparent_36%),linear-gradient(135deg,color-mix(in_srgb,var(--foreground)_2%,transparent),transparent_46%,color-mix(in_srgb,var(--tracker-profile-accent-solid)_4%,transparent))] opacity-[var(--tracker-profile-accent-wash-opacity,0)]";
const CHARACTER_CARD_TEXTURE_CLASS =
  "pointer-events-none absolute inset-0 z-0 bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,var(--tracker-profile-rule)_7%,transparent)_0_1px,transparent_1px_7px),repeating-linear-gradient(0deg,color-mix(in_srgb,var(--foreground)_2%,transparent)_0_1px,transparent_1px_5px)] opacity-[0.24] mix-blend-soft-light [mask-image:linear-gradient(180deg,transparent_0%,black_20%,black_100%)]";
const CHARACTER_CARD_BODY_MATERIAL_CLASS =
  "pointer-events-none absolute inset-x-0 bottom-0 top-[1.35rem] z-0 bg-[image:var(--tracker-profile-material)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_4%,transparent),inset_0_10px_18px_color-mix(in_srgb,var(--tracker-profile-accent-solid)_5%,transparent)] [background-blend-mode:var(--tracker-profile-material-blend)]";
const CHARACTER_AVATAR_CORNER_SHADE_CLASS =
  "pointer-events-none absolute left-0 top-[1.35rem] z-0 h-[3.1rem] w-[7.25rem] bg-[radial-gradient(ellipse_at_0%_0%,color-mix(in_srgb,var(--background)_48%,transparent)_0%,color-mix(in_srgb,var(--background)_24%,transparent)_34%,transparent_72%)] mix-blend-multiply [mask-image:linear-gradient(180deg,black_0%,black_60%,transparent_100%)]";
const CHARACTER_REMOVE_BUTTON_CLASS =
  "rounded p-1 text-[var(--destructive)] transition-all hover:bg-[var(--destructive)]/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border)] active:scale-90";
const CHARACTER_HEADER_CLASS = "relative -mt-2.5 flex items-start gap-1 px-0.5";
const CHARACTER_HEADER_COPY_CLASS = "relative z-[1] min-w-0 flex-1 pt-3";
const CHARACTER_HEADER_VOID_TEXTURE_CLASS =
  "pointer-events-none absolute inset-x-0 bottom-[-0.125rem] top-[2.05rem] z-0 rounded-b-[5px] bg-[radial-gradient(ellipse_at_48%_0%,color-mix(in_srgb,var(--tracker-profile-accent-solid)_11%,transparent)_0%,transparent_62%),repeating-linear-gradient(135deg,color-mix(in_srgb,var(--tracker-profile-rule)_18%,transparent)_0_1px,transparent_1px_7px),repeating-linear-gradient(0deg,color-mix(in_srgb,var(--foreground)_4%,transparent)_0_1px,transparent_1px_5px)] opacity-[0.56] mix-blend-soft-light [mask-image:linear-gradient(180deg,transparent_0%,black_22%,black_82%,transparent_100%)]";
const CHARACTER_FEATURE_BUTTON_CLASS =
  "absolute left-0 top-0 z-[6] flex h-[1.35rem] w-[1.35rem] items-center justify-center rounded-tl-[5px] rounded-br-[5px] bg-transparent text-[var(--tracker-profile-nameplate-text)]/42 transition-all hover:bg-[color-mix(in_srgb,var(--tracker-profile-nameplate-rule)_10%,transparent)] hover:text-[var(--tracker-profile-nameplate-text)]/74 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--border)] active:scale-95 [&>svg]:drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]";
/** Sits beside the feature button, so it never collides with delete-mode's corner. */
const CHARACTER_COLLAPSE_BUTTON_CLASS = cn(
  CHARACTER_FEATURE_BUTTON_CLASS,
  "left-[1.35rem] rounded-tl-none rounded-br-none",
);
const CHARACTER_NAMEPLATE_CLASS =
  "relative z-[3] -mx-0.5 -mt-0.5 mb-0.5 flex min-h-[1.35rem] min-w-0 items-center overflow-hidden rounded-t-[5px] border-x border-t border-[color-mix(in_srgb,var(--tracker-profile-nameplate-rule)_20%,transparent)] bg-[image:var(--tracker-profile-nameplate)] pl-[clamp(4.05rem,43cqw,4.85rem)] pr-1.5 shadow-[0_0_4px_color-mix(in_srgb,var(--tracker-profile-nameplate-glow)_9%,transparent),inset_0_-1px_0_color-mix(in_srgb,var(--background)_24%,transparent)] [background-blend-mode:normal]";
const CHARACTER_NAMEPLATE_GLEAM_CLASS =
  "pointer-events-none absolute inset-x-0 top-0 z-[2] h-px bg-[image:var(--tracker-profile-accent-layer)] opacity-[var(--tracker-profile-accent-highlight-opacity,0.32)] [mask-image:linear-gradient(90deg,transparent_0%,black_20%,black_82%,transparent_100%)]";
const CHARACTER_AVATAR_SOCKET_CLASS =
  "pointer-events-none absolute z-[2] rounded-full border border-[color-mix(in_srgb,var(--tracker-profile-nameplate-rule)_34%,transparent)] bg-[image:var(--tracker-profile-nameplate)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_4%,transparent),inset_0_-2px_4px_color-mix(in_srgb,var(--background)_24%,transparent)] [background-blend-mode:normal]";
const CHARACTER_AVATAR_SOCKET_SIZE_CLASS = {
  regular: "left-[0.32rem] top-[0.7rem] h-[clamp(3.06rem,35cqw,3.75rem)] w-[clamp(3.06rem,35cqw,3.75rem)]",
  dense: "left-[0.32rem] top-[0.7rem] h-[clamp(2.36rem,29cqw,3rem)] w-[clamp(2.36rem,29cqw,3rem)]",
} satisfies Record<"regular" | "dense", string>;
const CHARACTER_HEADER_FILLER_CLASS =
  "pointer-events-none mt-1 h-3 w-[86%] bg-[repeating-linear-gradient(180deg,color-mix(in_srgb,var(--tracker-profile-nameplate-rule)_16%,transparent)_0_1px,transparent_1px_6px)] opacity-45 [mask-image:linear-gradient(90deg,black_0%,transparent_100%)]";
const CHARACTER_NAME_EDIT_CLASS =
  "w-full min-w-0 px-0 py-0 text-[length:var(--tracker-fs-0-75)] font-bold leading-[1.25] text-[color:var(--tracker-profile-nameplate-text)] drop-shadow-[0_1px_2px_rgba(0,0,0,0.38)] hover:bg-transparent";
const CHARACTER_DETAIL_ROWS_CLASS = "relative z-[1] mt-0.5 grid grid-cols-1 gap-px px-px pb-px";
const CHARACTER_STAT_BLOCK_CLASS =
  "group/statbox relative z-[1] mt-1 border-t border-[color-mix(in_srgb,var(--tracker-profile-rule)_34%,transparent)] pt-1";
function CompactCharacterNameplate({ children }: { children: ReactNode }) {
  return (
    <div className={CHARACTER_NAMEPLATE_CLASS}>
      <div className={CHARACTER_NAMEPLATE_GLEAM_CLASS} />
      <div className="relative z-[1] min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function CompactThoughtBubble({
  value,
  onSave,
  lockKey,
  hidden = false,
  hideMode = false,
  onToggleHidden,
}: {
  value: string | null | undefined;
  onSave: (value: string) => void;
  lockKey?: string;
  hidden?: boolean;
  hideMode?: boolean;
  onToggleHidden: () => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const lock = useTrackerFieldLock(lockKey);
  if (hidden && !hideMode) return null;
  const thoughtText = visibleText(value, "Thoughts").replace(/\s+/g, " ");

  return (
    <div className="relative z-[1] mt-0.5 w-full max-w-full">
      <div className="relative z-[2] min-h-5 w-full min-w-0 rounded-[1.05rem] border border-[color-mix(in_srgb,var(--tracker-profile-dialogue-border)_24%,transparent)] bg-[linear-gradient(150deg,color-mix(in_srgb,var(--tracker-profile-surface-solid)_78%,var(--tracker-profile-display-solid)_12%)_0%,color-mix(in_srgb,var(--tracker-profile-surface-solid)_72%,var(--tracker-profile-accent-solid)_10%)_54%,color-mix(in_srgb,var(--background)_34%,var(--tracker-profile-surface-solid)_66%)_100%)] px-2.5 pb-px pt-0.5 text-[var(--tracker-profile-text)] shadow-[0_3px_8px_color-mix(in_srgb,var(--background)_22%,transparent),0_0_6px_color-mix(in_srgb,var(--tracker-profile-accent-solid)_7%,transparent),inset_0_1px_0_color-mix(in_srgb,var(--foreground)_4%,transparent)]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_18%,color-mix(in_srgb,var(--foreground)_7%,transparent),transparent_34%),radial-gradient(circle_at_88%_92%,color-mix(in_srgb,var(--tracker-profile-accent-solid)_9%,transparent),transparent_46%),linear-gradient(180deg,transparent_52%,color-mix(in_srgb,var(--background)_18%,transparent)_100%)]" />
        <div className="relative z-[1] flex w-full max-w-full items-center">
          {hideMode ? (
            <button
              type="button"
              onClick={onToggleHidden}
              title={
                hidden
                  ? localizeUi("ui.trackerPanel.thoughtbubble.showThoughts")
                  : localizeUi("ui.trackerPanel.thoughtbubble.hideThoughts")
              }
              aria-label={
                hidden
                  ? localizeUi("ui.trackerPanel.thoughtbubble.showThoughts")
                  : localizeUi("ui.trackerPanel.thoughtbubble.hideThoughts")
              }
              aria-pressed={hidden}
              className={cn(
                "min-h-4 w-full min-w-0 rounded px-0 py-0 text-left font-medium italic text-[color-mix(in_srgb,var(--tracker-profile-text)_72%,transparent)] transition-colors hover:bg-[var(--tracker-profile-accent-solid)]/10",
                TRACKER_DETAIL_TEXT_CLASS,
              )}
            >
              <span className={cn("break-words tracking-[0]", TRACKER_DETAIL_VALUE_CLAMP_CLASS)}>
                {hidden ? localizeUi("ui.trackerPanel.thoughtbubble.hidden") : thoughtText}
              </span>
            </button>
          ) : (
            <InlineEdit
              value={value ?? ""}
              onSave={onSave}
              placeholder={localizeUi("ui.trackerPanel.thoughtbubble.thoughts")}
              className={cn(
                "min-h-4 w-full min-w-0 px-0 py-0 font-medium italic [--foreground:color-mix(in_srgb,var(--tracker-profile-text)_90%,var(--tracker-profile-accent-solid)_10%)] [--muted-foreground:color-mix(in_srgb,var(--tracker-profile-muted-text)_82%,var(--tracker-profile-accent-solid)_18%)] hover:bg-[var(--tracker-profile-accent-solid)]/10",
                TRACKER_DETAIL_TEXT_CLASS,
              )}
              showEditHint={false}
              previewLineCount="full"
              previewClassName={cn("tracking-[0]", TRACKER_DETAIL_VALUE_CLAMP_CLASS)}
              {...lock}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function CharacterTrackerCard({
  character,
  characterPicture,
  profileColors,
  trackerPanelSizeProfile,
  statDisplayMode,
  resolveStatIcon,
  onUpdate,
  onRemove,
  characterIndex,
  deleteMode,
  addMode,
  onToggleFeatured,
  onToggleCollapsed,
  onUploadAvatar,
}: {
  character: PresentCharacter;
  characterPicture?: string | null;
  profileColors?: TrackerProfileColors | null;
  trackerPanelSizeProfile: TrackerPanelSizeProfile;
  statDisplayMode: TrackerStatDisplayMode;
  resolveStatIcon: StatIconLookup;
  onUpdate: (character: PresentCharacter) => void;
  onRemove: () => void;
  characterIndex: number;
  deleteMode: boolean;
  addMode: boolean;
  onToggleFeatured: () => void;
  onToggleCollapsed: () => void;
  onUploadAvatar: () => void;
}) {
  useRenderTimer(`tracker-card:${characterIndex}`); // [#3104 diagnostic]
  const { t: localizeUi } = useUiTranslation();
  const { fieldLocks, hideMode = false, lockMode, onToggleFieldLock } = useTrackerLockContext();
  const mutations = useCharacterCardMutations({ character, characterIndex, onUpdate });
  const customFields = readCharacterCustomFieldEntries(character);
  const characterStats = Array.isArray(character.stats) ? character.stats : [];
  const avatarMedia = characterPicture ?? character.avatarPath ?? null;
  const compactAvatarUpload = characterPicture ? undefined : onUploadAvatar;
  const fieldHidden = (field: HideableCharacterField) => mutations.isFieldHidden(field);
  const moodHidden = fieldHidden("mood");
  const appearanceHidden = fieldHidden("appearance");
  const outfitHidden = fieldHidden("outfit");
  const thoughtsHidden = fieldHidden("thoughts");
  const showAppearance = !appearanceHidden || hideMode;
  const showOutfit = !outfitHidden || hideMode;
  const showMood = !moodHidden || hideMode;
  const showThoughts = !thoughtsHidden || hideMode;
  const hasDetailRows = showMood || showAppearance || showOutfit;
  const hasDenseContent = characterStats.length > 0 || customFields.length > 0 || addMode;
  const readableCustomFields = trackerPanelSizeProfile === "expanded";
  const emojiLockKey = characterTrackerLockKey(character, characterIndex, "emoji");
  const avatarSize = hasDenseContent
    ? "z-[5] mt-0 w-[clamp(2.25rem,28%,3rem)] -translate-y-0.5"
    : "z-[5] mt-0 w-[clamp(3rem,36%,3.75rem)] -translate-y-0.5";
  const avatarSocketSize = hasDenseContent ? "dense" : "regular";
  return (
    <article className={CHARACTER_CARD_CLASS} style={getCharacterAmbienceStyle(character, profileColors)}>
      <div className={CHARACTER_CARD_TONE_OVERLAY_CLASS} />
      <TrackerReadabilityVeil strength={hasDenseContent || hasDetailRows ? "strong" : "soft"} />
      <div className={CHARACTER_CARD_BODY_MATERIAL_CLASS} />
      <div className={CHARACTER_AVATAR_CORNER_SHADE_CLASS} />
      <div className={CHARACTER_CARD_TEXTURE_CLASS} />
      <TrackerProfileDisplayWash className="z-[1]" />
      <TrackerProfileEdgeHighlight className="z-[2] opacity-[0.3]" showBottom={false} />
      <div className={cn(CHARACTER_AVATAR_SOCKET_CLASS, CHARACTER_AVATAR_SOCKET_SIZE_CLASS[avatarSocketSize])} />
      {deleteMode && (
        <div className="absolute right-1 top-1 z-10">
          <button
            type="button"
            onClick={onRemove}
            className={CHARACTER_REMOVE_BUTTON_CLASS}
            title={localizeUi("ui.trackerPanel.charactertrackercard.removeCharacter")}
            aria-label={localizeUi("ui.trackerPanel.charactertrackercard.removeValue1", {
              value1: visibleText(character.name, "character"),
            })}
          >
            <X size="0.6875rem" />
          </button>
        </div>
      )}

      <CompactCharacterNameplate>
        <InlineEdit
          value={character.name}
          onSave={(name) => onUpdate({ ...character, name: name || "Character" })}
          placeholder={localizeUi("ui.characters.cardlibrarydetailcard.character")}
          className={CHARACTER_NAME_EDIT_CLASS}
          showEditHint={false}
          fitPreview
          fitMinScale={0.58}
          locked={isTrackerFieldLocked(fieldLocks, characterTrackerLockKey(character, characterIndex, "name"))}
          lockMode={lockMode}
          onToggleLock={
            onToggleFieldLock
              ? () => onToggleFieldLock(characterTrackerLockKey(character, characterIndex, "name"))
              : undefined
          }
        />
      </CompactCharacterNameplate>
      <button
        type="button"
        onClick={onToggleFeatured}
        title={localizeUi("ui.trackerPanel.charactertrackercard.featureCharacterCard")}
        aria-label={localizeUi("ui.trackerPanel.charactertrackercard.featureCharacterCard")}
        aria-pressed={false}
        className={CHARACTER_FEATURE_BUTTON_CLASS}
      >
        <Maximize2 size="0.5625rem" />
      </button>
      <button
        type="button"
        onClick={onToggleCollapsed}
        title={localizeUi("ui.trackerPanel.charactertrackercard.collapseCharacterCard")}
        aria-label={localizeUi("ui.trackerPanel.charactertrackercard.collapseCharacterCard")}
        aria-expanded
        className={CHARACTER_COLLAPSE_BUTTON_CLASS}
      >
        <ChevronDown size="0.5625rem" />
      </button>

      <div className={cn(CHARACTER_HEADER_CLASS, deleteMode && "pr-7")}>
        <div className={CHARACTER_HEADER_VOID_TEXTURE_CLASS} />
        <CharacterTrackerAvatar
          character={character}
          avatarMedia={avatarMedia}
          avatarSize={avatarSize}
          onUploadAvatar={compactAvatarUpload}
          onSaveEmoji={(emoji) => onUpdate({ ...character, emoji })}
          emojiLocked={isTrackerFieldLocked(fieldLocks, emojiLockKey)}
          lockMode={lockMode}
          onToggleEmojiLock={onToggleFieldLock ? () => onToggleFieldLock(emojiLockKey) : undefined}
        />
        <div className={CHARACTER_HEADER_COPY_CLASS}>
          {showThoughts && (
            <CompactThoughtBubble
              value={character.thoughts}
              onSave={(thoughts) => onUpdate({ ...character, thoughts: thoughts || null })}
              lockKey={characterTrackerLockKey(character, characterIndex, "thoughts")}
              hidden={thoughtsHidden}
              hideMode={hideMode}
              onToggleHidden={() => mutations.toggleFieldHidden("thoughts")}
            />
          )}
          {!showThoughts && <div className={CHARACTER_HEADER_FILLER_CLASS} />}
        </div>
      </div>

      {hasDetailRows && (
        <div className={CHARACTER_DETAIL_ROWS_CLASS}>
          {showMood && (
            <CompactCharacterField
              icon={<HeartPulse size="0.6875rem" />}
              accessibleLabel="Mood"
              value={character.mood}
              placeholder={localizeUi("ui.trackerPanel.charactertrackercard.mood")}
              onSave={(mood) => onUpdate({ ...character, mood })}
              tone="mood"
              valueClassName={COMPACT_CHARACTER_MOOD_EDIT_CLASS}
              lockKey={characterTrackerLockKey(character, characterIndex, "mood")}
              hidden={moodHidden}
              hideMode={hideMode}
              onToggleHidden={() => mutations.toggleFieldHidden("mood")}
            />
          )}
          {showAppearance && (
            <CompactCharacterField
              icon={<Eye size="0.6875rem" />}
              accessibleLabel="Look"
              value={character.appearance}
              placeholder={localizeUi("chat.settings.inlineEditor.fields.appearance")}
              onSave={(appearance) => onUpdate({ ...character, appearance: appearance || null })}
              tone="appearance"
              lockKey={characterTrackerLockKey(character, characterIndex, "appearance")}
              hidden={appearanceHidden}
              hideMode={hideMode}
              onToggleHidden={() => mutations.toggleFieldHidden("appearance")}
            />
          )}
          {showOutfit && (
            <CompactCharacterField
              icon={<Shirt size="0.6875rem" />}
              accessibleLabel="Outfit"
              value={character.outfit}
              placeholder={localizeUi("ui.trackerPanel.charactertrackercard.outfit")}
              onSave={(outfit) => onUpdate({ ...character, outfit: outfit || null })}
              tone="outfit"
              lockKey={characterTrackerLockKey(character, characterIndex, "outfit")}
              hidden={outfitHidden}
              hideMode={hideMode}
              onToggleHidden={() => mutations.toggleFieldHidden("outfit")}
            />
          )}
        </div>
      )}

      {(characterStats.length > 0 || addMode) && (
        <div className={CHARACTER_STAT_BLOCK_CLASS}>
          <StatList
            stats={characterStats}
            onUpdate={(stats) => onUpdate({ ...character, stats })}
            onAdd={mutations.addCharacterStat}
            deleteMode={deleteMode}
            addMode={addMode}
            displayMode={statDisplayMode}
            resolveIcon={(stat, occurrence) =>
              resolveStatIcon.resolveCharacterStatIcon(character, characterIndex, stat.name, occurrence)
            }
            onSetIcon={(stat, occurrence, icon) =>
              resolveStatIcon.setCharacterStatIcon(character, characterIndex, stat.name, occurrence, icon)
            }
            onRemapIcons={(previousStats, nextStats, previousIndexForNext) =>
              resolveStatIcon.remapCharacterStatIcons(
                character,
                characterIndex,
                previousStats,
                nextStats,
                previousIndexForNext,
              )
            }
            getLockKey={(statIndex, field, stat) =>
              characterStatTrackerLockKey(character, characterIndex, stat ?? statIndex, field, statIndex)
            }
          />
        </div>
      )}

      <CharacterCardSections
        character={character}
        characterIndex={characterIndex}
        mutations={mutations}
        variant="compact"
        deleteMode={deleteMode}
        addMode={addMode}
        readable={readableCustomFields}
      />
    </article>
  );
}
