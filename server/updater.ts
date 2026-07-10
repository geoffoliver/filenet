export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

const TARGET_OS: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const TARGET_ARCH: Record<string, string> = { x64: 'x64', arm64: 'arm64' };

export function targetName(platform: string, arch: string): string {
  const os = TARGET_OS[platform];
  const a = TARGET_ARCH[arch];
  if (!os || !a) throw new Error(`Unsupported platform/arch for auto-update: ${platform}/${arch}`);
  return `bun-${os}-${a}`;
}
