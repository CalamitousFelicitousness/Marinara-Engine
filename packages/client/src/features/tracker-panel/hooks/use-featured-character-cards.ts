import { useCallback, useEffect, useRef, useState } from "react";
import { useUpdateChatMetadata } from "../../../hooks/use-chats";
import { TRACKER_FEATURED_CHARACTER_META_KEY } from "../lib/tracker-panel.constants";

export function useFeaturedCharacterCards({
  activeChatId,
  featuredCharacterCardKeys,
}: {
  activeChatId: string | null;
  featuredCharacterCardKeys: Set<string>;
}) {
  // `mutate` is referentially stable; the mutation object it hangs off is not,
  // and these callbacks reach every character card.
  const { mutate: mutateChatMetadata } = useUpdateChatMetadata();
  const [featuredCharacterCards, setFeaturedCharacterCards] = useState<Set<string>>(
    () => new Set(featuredCharacterCardKeys),
  );
  // Read at call time rather than closed over: in the deps, a refetch of chat
  // metadata rebuilds this Set and re-renders every card through these props.
  const featuredCharacterCardsRef = useRef(featuredCharacterCards);
  featuredCharacterCardsRef.current = featuredCharacterCards;

  useEffect(() => {
    setFeaturedCharacterCards(new Set(featuredCharacterCardKeys));
  }, [featuredCharacterCardKeys]);

  const persistFeaturedCharacterCards = useCallback(
    (next: Set<string>) => {
      setFeaturedCharacterCards(next);
      if (!activeChatId) return;
      mutateChatMetadata({
        id: activeChatId,
        [TRACKER_FEATURED_CHARACTER_META_KEY]: Array.from(next),
      });
    },
    [activeChatId, mutateChatMetadata],
  );

  const toggleFeaturedCharacterCard = useCallback(
    (key: string) => {
      const next = new Set(featuredCharacterCardsRef.current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      persistFeaturedCharacterCards(next);
    },
    [persistFeaturedCharacterCards],
  );

  const removeFeaturedCharacterCard = useCallback(
    (key: string) => {
      if (!featuredCharacterCardsRef.current.has(key)) return;
      const next = new Set(featuredCharacterCardsRef.current);
      next.delete(key);
      persistFeaturedCharacterCards(next);
    },
    [persistFeaturedCharacterCards],
  );

  return {
    featuredCharacterCards,
    removeFeaturedCharacterCard,
    toggleFeaturedCharacterCard,
  };
}
