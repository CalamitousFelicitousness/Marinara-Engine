import { useCallback, useEffect, useRef, useState } from "react";
import { useUpdateChatMetadata } from "../../../hooks/use-chats";

/**
 * A per-chat set of character card keys, mirrored into chat metadata.
 *
 * Two panel behaviours key off the same card identity and want the same
 * persistence: which cards are featured, and which are collapsed to a header.
 * The set is held locally and written through, so a toggle paints on the click
 * rather than after the metadata mutation round-trips.
 *
 * `keysRef` is read at call time rather than closed over: putting the live Set
 * in the callback deps would rebuild every callback whenever a chat-metadata
 * refetch produced a new Set, and these callbacks reach every character card.
 */
export function useCharacterCardKeySet({
  activeChatId,
  metaKey,
  persistedKeys,
}: {
  activeChatId: string | null;
  metaKey: string;
  persistedKeys: Set<string>;
}) {
  const { mutate: mutateChatMetadata } = useUpdateChatMetadata();
  const [keys, setKeys] = useState<Set<string>>(() => new Set(persistedKeys));
  const keysRef = useRef(keys);
  keysRef.current = keys;

  useEffect(() => {
    setKeys(new Set(persistedKeys));
  }, [persistedKeys]);

  const replace = useCallback(
    (next: Set<string>) => {
      setKeys(next);
      if (!activeChatId) return;
      mutateChatMetadata({ id: activeChatId, [metaKey]: Array.from(next) });
    },
    [activeChatId, metaKey, mutateChatMetadata],
  );

  const toggle = useCallback(
    (key: string) => {
      const next = new Set(keysRef.current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      replace(next);
    },
    [replace],
  );

  const remove = useCallback(
    (key: string) => {
      if (!keysRef.current.has(key)) return;
      const next = new Set(keysRef.current);
      next.delete(key);
      replace(next);
    },
    [replace],
  );

  return { keys, replace, toggle, remove };
}
