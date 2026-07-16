import type { UpdatePhase } from '../lib/api';

export function shouldNotifyForUpdate(
  phase: UpdatePhase,
  latestVersion: string | null,
  notifiedVersions: Set<string>,
): string | null {
  if (phase !== 'ready' || !latestVersion) return null;
  if (notifiedVersions.has(latestVersion)) return null;
  return latestVersion;
}
