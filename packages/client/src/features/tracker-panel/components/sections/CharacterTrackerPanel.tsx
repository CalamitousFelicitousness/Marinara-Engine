import { memo, useCallback, type ReactNode } from "react";
import { Users } from "lucide-react";
import type { PresentCharacter } from "@marinara-engine/shared";
import type {
  TrackerPanelSide,
  TrackerPanelSizeProfile,
  TrackerStatDisplayMode,
  TrackerThoughtBubbleDisplay,
} from "../../../../stores/ui.store";
import { cn } from "../../../../lib/utils";
import type { StatIconLookup } from "../../hooks/use-stat-icons";
import { getCharacterFeatureKey } from "../../lib/character-tracker-data";
import { getSpriteExpressionForCharacter } from "../../lib/sprite-expressions";
import type { TrackerProfileColors } from "../../lib/tracker-profile-style";
import { AddRowButton, EmptySection, SectionHeader } from "../controls/SectionControls";
import { CharacterTrackerCard } from "../character-card/CharacterTrackerCard";
import { CollapsedCharacterRow } from "../character-card/CollapsedCharacterRow";
import { FeaturedCharacterTrackerCard } from "../character-card/FeaturedCharacterTrackerCard";
import { useTranslation as useUiTranslation } from "react-i18next";

const COMPACT_CHARACTER_GHOST_SLOT_CLASS =
  "pointer-events-none relative hidden min-h-0 self-stretch overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--border)_28%,transparent)] bg-[var(--tracker-panel-card-background,linear-gradient(135deg,color-mix(in_srgb,var(--card)_18%,transparent),color-mix(in_srgb,var(--background)_12%,transparent)_48%,transparent))] opacity-55 shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_3%,transparent),inset_0_-1px_0_color-mix(in_srgb,var(--background)_18%,transparent)] @min-[260px]:block before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0.5 before:h-5 before:rounded-l-[4px] before:rounded-r-[2px] before:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--background)_78%,var(--card)_22%),color-mix(in_srgb,var(--card)_42%,transparent))] before:opacity-65 after:pointer-events-none after:absolute after:inset-1 after:rounded-[4px] after:bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,var(--border)_12%,transparent)_0_1px,transparent_1px_7px)] after:opacity-35";
const COMPACT_CHARACTER_CARD_SLOT_CLASS = "min-h-0 h-full";
// `auto` keeps each card's last rendered height as its placeholder. A bare
// `10rem` is a fixed guess for a card whose height varies with its stats, custom
// fields and extras, so off-screen cards reserved the wrong space and the list
// jumped as they scrolled in.
const CHARACTER_CARD_RENDER_CONTAINMENT_CLASS = "[content-visibility:auto] [contain-intrinsic-size:auto_10rem]";

/**
 * Index-taking callbacks, shared by both slots.
 *
 * The card map used to build four closures per card per render, which made a
 * memo boundary on the card worthless: new identities every time, so every card
 * re-rendered on every patch. Holding the index in a memoized slot lets the
 * parent pass callbacks that stay stable across renders.
 */
type CharacterCardSlotCallbacks = {
  onUpdateCharacter: (index: number, character: PresentCharacter) => void;
  onRemoveCharacter: (index: number) => void;
  onToggleFeatured: (key: string) => void;
  onToggleCharacterCollapsed: (key: string) => void;
  onUploadAvatar: (index: number) => void;
};

function useCharacterSlotCallbacks(
  characterIndex: number,
  cardKey: string,
  {
    onUpdateCharacter,
    onRemoveCharacter,
    onToggleFeatured,
    onToggleCharacterCollapsed,
    onUploadAvatar,
  }: CharacterCardSlotCallbacks,
) {
  return {
    onUpdate: useCallback(
      (updated: PresentCharacter) => onUpdateCharacter(characterIndex, updated),
      [characterIndex, onUpdateCharacter],
    ),
    onRemove: useCallback(() => onRemoveCharacter(characterIndex), [characterIndex, onRemoveCharacter]),
    onToggleFeatured: useCallback(() => onToggleFeatured(cardKey), [cardKey, onToggleFeatured]),
    onToggleCollapsed: useCallback(() => onToggleCharacterCollapsed(cardKey), [cardKey, onToggleCharacterCollapsed]),
    onUploadAvatar: useCallback(() => onUploadAvatar(characterIndex), [characterIndex, onUploadAvatar]),
  };
}

const CompactCharacterCardSlot = memo(function CompactCharacterCardSlot({
  character,
  characterIndex,
  cardKey,
  characterPicture,
  profileColors,
  trackerPanelSizeProfile,
  statDisplayMode,
  resolveStatIcon,
  deleteMode,
  addMode,
  ...callbacks
}: {
  character: PresentCharacter;
  characterIndex: number;
  cardKey: string;
  characterPicture?: string;
  profileColors?: TrackerProfileColors;
  trackerPanelSizeProfile: TrackerPanelSizeProfile;
  statDisplayMode: TrackerStatDisplayMode;
  resolveStatIcon: StatIconLookup;
  deleteMode: boolean;
  addMode: boolean;
} & CharacterCardSlotCallbacks) {
  const slot = useCharacterSlotCallbacks(characterIndex, cardKey, callbacks);
  return (
    <div className={cn(COMPACT_CHARACTER_CARD_SLOT_CLASS, CHARACTER_CARD_RENDER_CONTAINMENT_CLASS)}>
      <CharacterTrackerCard
        character={character}
        characterPicture={characterPicture}
        profileColors={profileColors}
        trackerPanelSizeProfile={trackerPanelSizeProfile}
        statDisplayMode={statDisplayMode}
        resolveStatIcon={resolveStatIcon}
        characterIndex={characterIndex}
        deleteMode={deleteMode}
        addMode={addMode}
        {...slot}
      />
    </div>
  );
});

const CollapsedCharacterRowSlot = memo(function CollapsedCharacterRowSlot({
  character,
  characterIndex,
  cardKey,
  avatarMedia,
  deleteMode,
  ...callbacks
}: {
  character: PresentCharacter;
  characterIndex: number;
  cardKey: string;
  avatarMedia: string | null;
  deleteMode: boolean;
} & CharacterCardSlotCallbacks) {
  const slot = useCharacterSlotCallbacks(characterIndex, cardKey, callbacks);
  return (
    <CollapsedCharacterRow
      character={character}
      avatarMedia={avatarMedia}
      deleteMode={deleteMode}
      onToggleCollapsed={slot.onToggleCollapsed}
      onRemove={slot.onRemove}
    />
  );
});

const FeaturedCharacterCardSlot = memo(function FeaturedCharacterCardSlot({
  character,
  characterIndex,
  cardKey,
  spriteCharacterId,
  spriteExpression,
  expressionSpritesEnabled,
  characterPicture,
  profileColors,
  trackerPanelSide,
  trackerPanelSizeProfile,
  thoughtBubbleDisplay,
  statDisplayMode,
  resolveStatIcon,
  dockedThoughtsAlwaysVisible,
  deleteMode,
  addMode,
  ...callbacks
}: {
  character: PresentCharacter;
  characterIndex: number;
  cardKey: string;
  spriteCharacterId: string | null;
  spriteExpression?: string;
  expressionSpritesEnabled: boolean;
  characterPicture?: string;
  profileColors?: TrackerProfileColors;
  trackerPanelSide: TrackerPanelSide;
  trackerPanelSizeProfile: TrackerPanelSizeProfile;
  thoughtBubbleDisplay: TrackerThoughtBubbleDisplay;
  statDisplayMode: TrackerStatDisplayMode;
  resolveStatIcon: StatIconLookup;
  dockedThoughtsAlwaysVisible: boolean;
  deleteMode: boolean;
  addMode: boolean;
} & CharacterCardSlotCallbacks) {
  const slot = useCharacterSlotCallbacks(characterIndex, cardKey, callbacks);
  return (
    <div className={CHARACTER_CARD_RENDER_CONTAINMENT_CLASS}>
      <FeaturedCharacterTrackerCard
        character={character}
        spriteCharacterId={spriteCharacterId}
        spriteExpression={spriteExpression}
        expressionSpritesEnabled={expressionSpritesEnabled}
        characterPicture={characterPicture}
        profileColors={profileColors}
        trackerPanelSide={trackerPanelSide}
        trackerPanelSizeProfile={trackerPanelSizeProfile}
        thoughtBubbleDisplay={thoughtBubbleDisplay}
        statDisplayMode={statDisplayMode}
        resolveStatIcon={resolveStatIcon}
        dockedThoughtsAlwaysVisible={dockedThoughtsAlwaysVisible}
        characterIndex={characterIndex}
        deleteMode={deleteMode}
        addMode={addMode}
        {...slot}
      />
    </div>
  );
});

export function CharacterTrackerPanel({
  activeChatId,
  characters,
  featuredCharacterCards,
  collapsedCharacterCards,
  spriteExpressions,
  expressionSpritesEnabled,
  characterPictures,
  characterProfileColors,
  resolveSpriteCharacterId,
  trackerPanelSide,
  trackerPanelSizeProfile,
  thoughtBubbleDisplay,
  statDisplayMode,
  resolveStatIcon,
  dockedThoughtsAlwaysVisible,
  onUpdateCharacter,
  onRemoveCharacter,
  onAddCharacter,
  onToggleFeatured,
  onToggleCharacterCollapsed,
  onUploadAvatar,
  deleteMode,
  addMode,
  action,
  collapsed = false,
  onToggleCollapsed,
}: {
  activeChatId: string;
  characters: PresentCharacter[];
  featuredCharacterCards: Set<string>;
  collapsedCharacterCards: Set<string>;
  spriteExpressions: Record<string, string>;
  expressionSpritesEnabled: boolean;
  characterPictures: Record<string, string>;
  characterProfileColors: Record<string, TrackerProfileColors>;
  resolveSpriteCharacterId: (character: PresentCharacter) => string | null;
  trackerPanelSide: TrackerPanelSide;
  trackerPanelSizeProfile: TrackerPanelSizeProfile;
  thoughtBubbleDisplay: TrackerThoughtBubbleDisplay;
  statDisplayMode: TrackerStatDisplayMode;
  resolveStatIcon: StatIconLookup;
  dockedThoughtsAlwaysVisible: boolean;
  onUpdateCharacter: (index: number, character: PresentCharacter) => void;
  onRemoveCharacter: (index: number) => void;
  onAddCharacter: () => void;
  onToggleFeatured: (key: string) => void;
  onToggleCharacterCollapsed: (key: string) => void;
  onUploadAvatar: (index: number) => void;
  deleteMode: boolean;
  addMode: boolean;
  action?: ReactNode;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const renderCharacterCards = () => {
    if (characters.length === 0) {
      return (
        <div className="p-1">
          <EmptySection>{localizeUi("ui.trackerPanel.charactertrackerpanel.noCharactersTracked")}</EmptySection>
        </div>
      );
    }

    const characterEntries = characters.map((character, index) => {
      const cardKey = getCharacterFeatureKey(character, index);
      const spriteCharacterId = resolveSpriteCharacterId(character);
      return {
        character,
        cardKey,
        spriteCharacterId,
        characterPicture: spriteCharacterId ? characterPictures[spriteCharacterId] : undefined,
        profileColors: spriteCharacterId ? characterProfileColors[spriteCharacterId] : undefined,
        featured: featuredCharacterCards.has(cardKey),
        collapsed: collapsedCharacterCards.has(cardKey),
        index,
      };
    });
    // Collapsed wins over featured: a card asked to get out of the way should
    // not keep the top slot. The three groups are disjoint and render in
    // priority order, matching how featuring already reorders the list.
    const collapsedEntries = characterEntries.filter((entry) => entry.collapsed);
    const featuredEntries = characterEntries.filter((entry) => !entry.collapsed && entry.featured);
    const compactEntries = characterEntries.filter((entry) => !entry.collapsed && !entry.featured);
    const getCharacterEntryKey = (entry: (typeof characterEntries)[number]) =>
      `${activeChatId}-${entry.character.characterId}-${entry.index}`;
    const useCompactCardColumns = trackerPanelSizeProfile !== "compact";
    const shouldRenderCompactGhostSlot = useCompactCardColumns && compactEntries.length % 2 === 1;
    const renderCompactCharacterCard = (entry: (typeof characterEntries)[number]) => (
      <CompactCharacterCardSlot
        key={getCharacterEntryKey(entry)}
        character={entry.character}
        characterIndex={entry.index}
        cardKey={entry.cardKey}
        characterPicture={entry.characterPicture}
        profileColors={entry.profileColors}
        trackerPanelSizeProfile={trackerPanelSizeProfile}
        statDisplayMode={statDisplayMode}
        resolveStatIcon={resolveStatIcon}
        deleteMode={deleteMode}
        addMode={addMode}
        onUpdateCharacter={onUpdateCharacter}
        onRemoveCharacter={onRemoveCharacter}
        onToggleFeatured={onToggleFeatured}
        onToggleCharacterCollapsed={onToggleCharacterCollapsed}
        onUploadAvatar={onUploadAvatar}
      />
    );
    const renderCollapsedCharacterRow = (entry: (typeof characterEntries)[number]) => (
      <CollapsedCharacterRowSlot
        key={getCharacterEntryKey(entry)}
        character={entry.character}
        characterIndex={entry.index}
        cardKey={entry.cardKey}
        avatarMedia={entry.characterPicture ?? entry.character.avatarPath ?? null}
        deleteMode={deleteMode}
        onUpdateCharacter={onUpdateCharacter}
        onRemoveCharacter={onRemoveCharacter}
        onToggleFeatured={onToggleFeatured}
        onToggleCharacterCollapsed={onToggleCharacterCollapsed}
        onUploadAvatar={onUploadAvatar}
      />
    );
    const renderFeaturedCharacterCard = (entry: (typeof characterEntries)[number]) => (
      <FeaturedCharacterCardSlot
        key={getCharacterEntryKey(entry)}
        character={entry.character}
        characterIndex={entry.index}
        cardKey={entry.cardKey}
        spriteCharacterId={entry.spriteCharacterId}
        spriteExpression={
          expressionSpritesEnabled
            ? getSpriteExpressionForCharacter(spriteExpressions, entry.character, entry.spriteCharacterId)
            : undefined
        }
        expressionSpritesEnabled={expressionSpritesEnabled}
        characterPicture={entry.characterPicture}
        profileColors={entry.profileColors}
        trackerPanelSide={trackerPanelSide}
        trackerPanelSizeProfile={trackerPanelSizeProfile}
        thoughtBubbleDisplay={thoughtBubbleDisplay}
        statDisplayMode={statDisplayMode}
        resolveStatIcon={resolveStatIcon}
        dockedThoughtsAlwaysVisible={dockedThoughtsAlwaysVisible}
        deleteMode={deleteMode}
        addMode={addMode}
        onUpdateCharacter={onUpdateCharacter}
        onRemoveCharacter={onRemoveCharacter}
        onToggleFeatured={onToggleFeatured}
        onToggleCharacterCollapsed={onToggleCharacterCollapsed}
        onUploadAvatar={onUploadAvatar}
      />
    );

    return (
      <div className="space-y-1">
        {featuredEntries.map(renderFeaturedCharacterCard)}
        {compactEntries.length > 0 && (
          <div
            className={cn(
              "grid auto-rows-auto grid-cols-1 items-stretch gap-1 px-1 pb-1",
              useCompactCardColumns && "@min-[260px]:grid-cols-2",
              featuredEntries.length === 0 && "pt-1",
            )}
          >
            {compactEntries.map(renderCompactCharacterCard)}
            {shouldRenderCompactGhostSlot && <div aria-hidden="true" className={COMPACT_CHARACTER_GHOST_SLOT_CLASS} />}
          </div>
        )}
        {collapsedEntries.length > 0 && (
          <div className={cn("grid grid-cols-1 gap-0.5 px-1 pb-1", compactEntries.length === 0 && "pt-1")}>
            {collapsedEntries.map(renderCollapsedCharacterRow)}
          </div>
        )}
      </div>
    );
  };

  return (
    <section
      className="group/characters relative z-10 border-b border-[var(--border)] bg-[var(--tracker-panel-section-background,color-mix(in_srgb,var(--card)_5%,transparent))] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_5%,transparent)]"
      aria-label={localizeUi("navigation.topbar.characters")}
    >
      <SectionHeader
        icon={<Users size="0.6875rem" />}
        title={localizeUi("ui.trackerPanel.charactertrackerpanel.presentCharacters")}
        action={action}
        addAction={
          addMode ? (
            <AddRowButton
              title={localizeUi("ui.trackerPanel.charactertrackerpanel.addCharacter")}
              onClick={onAddCharacter}
              className="rounded-sm"
            />
          ) : undefined
        }
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
      />

      {!collapsed && renderCharacterCards()}
    </section>
  );
}
