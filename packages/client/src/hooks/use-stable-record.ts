// Keep a rebuilt record's previous reference when its content is unchanged.
//
// The tracker's lock and hidden-field records are rebuilt from scratch on every
// render -- normalizeTrackerFieldLocks always allocates -- so they changed
// identity even when no lock changed. They feed TrackerLockProvider's memo, and
// a context value that changes every render re-renders every consumer
// regardless of React.memo, because context updates bypass memo entirely.
//
// Shallow comparison is exact here: these are flat `Record<string, true>` maps
// with one entry per locked field, so the scan is small and cannot miss a
// nested change.

import { useRef } from "react";

import { shallowRecordEqual } from "../lib/shallow-record-equal";

export function useStableRecord<T extends Record<string, unknown> | null | undefined>(value: T): T {
  const previous = useRef<T>(value);
  // Read-and-write during render is safe: the ref only ever caches a value
  // derived from this render's own input, so a discarded render cannot leak a
  // reference the committed tree never saw.
  if (!shallowRecordEqual(previous.current, value)) previous.current = value;
  return previous.current;
}
