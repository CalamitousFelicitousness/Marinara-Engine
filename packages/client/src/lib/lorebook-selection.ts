/**
 * Ids from a lorebook selection that an Enable (or Disable) action would flip.
 * Unknown ids are skipped so a stale selection never reaches the server.
 */
export function planLorebookSelectionEnable(
  selectedIds: Iterable<string>,
  enabledById: ReadonlyMap<string, boolean>,
  enable: boolean,
): string[] {
  const ids: string[] = [];
  for (const id of selectedIds) {
    if (!enabledById.has(id)) continue;
    if (enabledById.get(id) !== enable) ids.push(id);
  }
  return ids;
}
