import { describe, expect, it } from 'bun:test';

import { compareVersions, isNewerVersion, targetName } from '../updater';

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
