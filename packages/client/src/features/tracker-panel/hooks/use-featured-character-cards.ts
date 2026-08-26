import { TRACKER_FEATURED_CHARACTER_META_KEY } from "../lib/tracker-panel.constants";
import { useCharacterCardKeySet } from "./use-character-card-key-set";

export function useFeaturedCharacterCards({
  activeChatId,
  featuredCharacterCardKeys,
}: {
  activeChatId: string | null;
  featuredCharacterCardKeys: Set<string>;
}) {
  const { keys, toggle, remove } = useCharacterCardKeySet({
    activeChatId,
    metaKey: TRACKER_FEATURED_CHARACTER_META_KEY,
    persistedKeys: featuredCharacterCardKeys,
  });

  return {
    featuredCharacterCards: keys,
    removeFeaturedCharacterCard: remove,
    toggleFeaturedCharacterCard: toggle,
  };
}
