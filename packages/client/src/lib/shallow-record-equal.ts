// One-level structural comparison for plain records.
//
// Used where a value is rebuilt from scratch every render but its content
// usually has not changed: tracker lock maps (useStableRecord) and the
// rendered-vs-updated diff in use-tracker-mutations. Both had their own copy.
//
// One level only, deliberately. Callers compare flat maps whose values are
// primitives or references they already treat as identities, so a deep walk
// would cost more and change no answer.
export function shallowRecordEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  for (const key of keys) {
    if (!Object.is(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}
