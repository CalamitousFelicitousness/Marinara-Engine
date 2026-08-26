import { ChevronRight, X } from "lucide-react";
import type { AvatarCrop, PresentCharacter } from "@marinara-engine/shared";
import { cn, getAvatarCropStyle } from "../../../../lib/utils";
import { visibleText } from "../../lib/tracker-display";
import { TRACKER_DETAIL_TEXT_CLASS } from "../../lib/tracker-row-layout";
import { useTranslation as useUiTranslation } from "react-i18next";

/**
 * One character reduced to a scannable line.
 *
 * Deliberately inert apart from expanding and deleting: the name, emoji, mood
 * and avatar are all editable on the expanded card, and duplicating those
 * controls here would put four nested buttons inside the row's own toggle.
 */
const ROW_CLASS =
  "group/collapsed relative flex min-h-7 w-full items-center gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--tracker-profile-dialogue-border)_30%,transparent)] bg-[image:var(--tracker-profile-field-material)] pl-1 pr-1 shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_4%,transparent)] transition-colors [background-blend-mode:var(--tracker-profile-field-material-blend)] hover:border-[color-mix(in_srgb,var(--tracker-profile-dialogue-border)_46%,transparent)]";
const TOGGLE_CLASS =
  "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border)]";
const CHEVRON_CLASS =
  "shrink-0 text-[color:color-mix(in_srgb,var(--tracker-profile-rule)_45%,var(--tracker-profile-text)_55%)] transition-transform group-hover/collapsed:translate-x-px";
const AVATAR_CLASS =
  "relative flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[color-mix(in_srgb,var(--tracker-profile-nameplate-rule)_34%,transparent)] bg-[var(--muted)] shadow-[0_2px_5px_rgba(0,0,0,0.22)]";
const NAME_CLASS =
  "min-w-0 flex-1 truncate font-semibold text-[color:var(--tracker-profile-text)] text-[length:var(--tracker-fs-0-6875)] leading-[1.3]";
// Mood gives up its width first: a name that cannot be read identifies nobody.
const MOOD_CLASS = cn(
  "min-w-0 shrink truncate text-right text-[color:var(--tracker-profile-muted-text)]",
  TRACKER_DETAIL_TEXT_CLASS,
);
const REMOVE_BUTTON_CLASS =
  "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border)]";

export function CollapsedCharacterRow({
  character,
  avatarMedia,
  onToggleCollapsed,
  onRemove,
  deleteMode = false,
}: {
  character: PresentCharacter;
  avatarMedia: string | null;
  onToggleCollapsed: () => void;
  onRemove: () => void;
  deleteMode?: boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  const name = visibleText(character.name, "character");
  const mood = typeof character.mood === "string" ? character.mood.trim() : "";
  const expandLabel = localizeUi("ui.trackerPanel.charactertrackerpanel.expandValue1", { value1: name });

  return (
    <div className={ROW_CLASS}>
      <button
        type="button"
        onClick={onToggleCollapsed}
        title={expandLabel}
        aria-label={expandLabel}
        aria-expanded={false}
        className={TOGGLE_CLASS}
      >
        <ChevronRight size="0.6875rem" className={CHEVRON_CLASS} aria-hidden="true" />
        <span className={AVATAR_CLASS} aria-hidden="true">
          {avatarMedia ? (
            <img
              src={avatarMedia}
              alt=""
              className="h-full w-full object-cover"
              style={getAvatarCropStyle(character.avatarCrop as AvatarCrop | null | undefined)}
              draggable={false}
            />
          ) : (
            <span className="text-[length:var(--tracker-fs-0-625)] leading-[1.15]">{character.emoji || "?"}</span>
          )}
        </span>
        {/* Shown beside the avatar too: the avatar is usually a portrait, so the
            emoji is the only per-turn signal of state in the row. */}
        <span className="shrink-0 text-[length:var(--tracker-fs-0-6875)] leading-[1.15]" aria-hidden="true">
          {character.emoji || "?"}
        </span>
        <span className={NAME_CLASS}>{name}</span>
        {mood && <span className={MOOD_CLASS}>{mood}</span>}
      </button>
      {deleteMode && (
        <button
          type="button"
          onClick={onRemove}
          title={localizeUi("ui.trackerPanel.charactertrackercard.removeValue1", { value1: name })}
          aria-label={localizeUi("ui.trackerPanel.charactertrackercard.removeValue1", { value1: name })}
          className={REMOVE_BUTTON_CLASS}
        >
          <X size="0.65rem" />
        </button>
      )}
    </div>
  );
}
