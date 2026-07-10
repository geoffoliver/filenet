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

// Explicit whitelist of valid (platform, arch) → targetName mappings
// These are the only 5 targets built by scripts/build-binaries.sh
const VALID_TARGETS: Record<string, string> = {
  'darwin:x64': 'bun-darwin-x64',
  'darwin:arm64': 'bun-darwin-arm64',
  'linux:x64': 'bun-linux-x64',
  'linux:arm64': 'bun-linux-arm64',
  'win32:x64': 'bun-windows-x64',
};

export function targetName(platform: string, arch: string): string {
  const key = `${platform}:${arch}`;
  const target = VALID_TARGETS[key];
  if (!target) throw new Error(`Unsupported platform/arch for auto-update: ${platform}/${arch}`);
  return target;
}

export type ReleaseAsset = { name: string; url: string };
export type ReleaseInfo = { version: string; notesUrl: string; assets: ReleaseAsset[] };

export async function fetchLatestRelease(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReleaseInfo | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'filenet-updater' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error checking for updates: ${res.status}`);

  const data = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  if (!data.tag_name) throw new Error('Malformed GitHub release response: missing tag_name');

  return {
    version: data.tag_name.replace(/^v/, ''),
    notesUrl: data.html_url ?? '',
    assets: (data.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url })),
  };
}
