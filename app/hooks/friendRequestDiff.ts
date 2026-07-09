export function getNewlyPendingIds(pendingIds: string[], notifiedIds: Set<string>): string[] {
  return pendingIds.filter((id) => !notifiedIds.has(id));
}

export function pruneStaleIds(notifiedIds: Set<string>, pendingIds: string[]): Set<string> {
  const pendingIdSet = new Set(pendingIds);
  return new Set([...notifiedIds].filter((id) => pendingIdSet.has(id)));
}
