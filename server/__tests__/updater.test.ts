import { describe, expect, it } from 'bun:test';

import { compareVersions, fetchLatestRelease, isNewerVersion, targetName } from '../updater';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns positive when the first version is newer', () => {
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('returns negative when the first version is older', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
  });
});

describe('isNewerVersion', () => {
  it('is true when the candidate is strictly greater', () => {
    expect(isNewerVersion('0.2.0', '0.1.1')).toBe(true);
  });

  it('is false when equal or older', () => {
    expect(isNewerVersion('0.1.1', '0.1.1')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false);
  });
});

describe('targetName', () => {
  it('maps darwin/x64 to bun-darwin-x64', () => {
    expect(targetName('darwin', 'x64')).toBe('bun-darwin-x64');
  });

  it('maps darwin/arm64 to bun-darwin-arm64', () => {
    expect(targetName('darwin', 'arm64')).toBe('bun-darwin-arm64');
  });

  it('maps linux/x64 to bun-linux-x64', () => {
    expect(targetName('linux', 'x64')).toBe('bun-linux-x64');
  });

  it('maps linux/arm64 to bun-linux-arm64', () => {
    expect(targetName('linux', 'arm64')).toBe('bun-linux-arm64');
  });

  it('maps win32/x64 to bun-windows-x64', () => {
    expect(targetName('win32', 'x64')).toBe('bun-windows-x64');
  });

  it('throws on an unsupported platform', () => {
    expect(() => targetName('freebsd', 'x64')).toThrow();
  });

  it('throws on an unsupported architecture', () => {
    expect(() => targetName('linux', 'ia32')).toThrow();
  });

  it('throws on invalid platform/arch combination (win32/arm64)', () => {
    expect(() => targetName('win32', 'arm64')).toThrow(
      /Unsupported platform\/arch for auto-update: win32\/arm64/,
    );
  });
});

describe('fetchLatestRelease', () => {
  function fakeFetch(response: unknown, status = 200): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(response), { status })) as unknown as typeof fetch;
  }

  it('parses tag_name, html_url, and assets from a real-shaped response', async () => {
    const release = await fetchLatestRelease(
      'geoffoliver/filenet',
      fakeFetch({
        tag_name: 'v0.2.0',
        html_url: 'https://github.com/geoffoliver/filenet/releases/tag/v0.2.0',
        assets: [
          {
            name: 'filenet-bun-linux-x64.zip',
            browser_download_url: 'https://example.com/filenet-bun-linux-x64.zip',
          },
          { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.com/SHA256SUMS.txt' },
        ],
      }),
    );

    expect(release).toEqual({
      version: '0.2.0',
      notesUrl: 'https://github.com/geoffoliver/filenet/releases/tag/v0.2.0',
      assets: [
        { name: 'filenet-bun-linux-x64.zip', url: 'https://example.com/filenet-bun-linux-x64.zip' },
        { name: 'SHA256SUMS.txt', url: 'https://example.com/SHA256SUMS.txt' },
      ],
    });
  });

  it('returns null when the repo has no releases (404)', async () => {
    const release = await fetchLatestRelease('geoffoliver/filenet', fakeFetch({}, 404));
    expect(release).toBeNull();
  });

  it('throws on a non-404 error status', async () => {
    await expect(fetchLatestRelease('geoffoliver/filenet', fakeFetch({}, 500))).rejects.toThrow();
  });

  it('throws when the response has no tag_name', async () => {
    await expect(
      fetchLatestRelease('geoffoliver/filenet', fakeFetch({ assets: [] })),
    ).rejects.toThrow();
  });
});
