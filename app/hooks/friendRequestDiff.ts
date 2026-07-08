export function getNewlyPendingIds(pendingIds: string[], notifiedIds: Set<string>): string[] {
  return pendingIds.filter((id) => !notifiedIds.has(id));
}
