export const UI_PERSISTENCE = { name: "marinara-engine-ui", version: 103 } as const;

// ponytail: older catalog packages bundle their own copy of the UI store (v74) and rewrite this key with only the
// settings that copy knows. The Engine cannot stop that write, so every save also goes to a host-only copy, and a
// load takes back from it what an older blob is missing. Ceiling: it repairs only blobs below the current version,
// keeps every value the older blob still holds, and needs a copy saved at the current version, so the first load
// after an Engine upgrade cannot repair yet. Remove it once no supported package bundles the UI store.
export const UI_PERSISTENCE_HOST_COPY = `${UI_PERSISTENCE.name}:host`;

type StoredUIState = { state: Record<string, unknown>; version: number };

function parseStoredUIState(raw: string | null): StoredUIState | null {
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredUIState> | null) : null;
    if (!parsed?.state || typeof parsed.state !== "object" || typeof parsed.version !== "number") return null;
    return parsed as StoredUIState;
  } catch {
    return null;
  }
}

/** The host copy's settings that an older stored blob lacks, or null when the blob needs no repair. */
export function readHostCopyRepair(stored: string | null, hostCopy: string | null): Record<string, unknown> | null {
  const blob = parseStoredUIState(stored);
  const copy = parseStoredUIState(hostCopy);
  if (!blob || !copy || blob.version >= UI_PERSISTENCE.version || copy.version !== UI_PERSISTENCE.version) return null;
  return Object.fromEntries(Object.entries(copy.state).filter(([key]) => !(key in blob.state)));
}
