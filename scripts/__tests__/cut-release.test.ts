import { describe, expect, test } from 'bun:test';

import { bumpVersion, cutChangelog } from '../cut-release';

describe('bumpVersion', () => {
  test('bumps patch', () => {
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
  });

  test('bumps minor and resets patch', () => {
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
  });

  test('bumps major and resets minor and patch', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  test('throws on a non-semver version string', () => {
    expect(() => bumpVersion('1.2', 'patch')).toThrow('Invalid semver version');
  });

  test('throws on a version string with a prerelease suffix', () => {
    expect(() => bumpVersion('1.2.3-beta.1', 'patch')).toThrow('Invalid semver version');
  });
});

describe('cutChangelog', () => {
  test('throws when there is no Unreleased section', () => {
    expect(() => cutChangelog('# Changelog\n\nno sections here\n', '1.0.0', '2026-01-01')).toThrow(
      'no "## [Unreleased]" section',
    );
  });

  test('throws when the Unreleased section is empty', () => {
    const changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2025-01-01\n\nold stuff\n';
    expect(() => cutChangelog(changelog, '0.2.0', '2026-01-01')).toThrow('nothing to release');
  });

  test('cuts Unreleased into a versioned section when it is the last section in the file', () => {
    const changelog = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- new thing\n';
    const { updatedChangelog, releaseNotes } = cutChangelog(changelog, '0.2.0', '2026-07-07');

    expect(releaseNotes).toContain('- new thing');
    expect(updatedChangelog).toContain('## [Unreleased]');
    expect(updatedChangelog).toContain('## [0.2.0] - 2026-07-07');
    expect(updatedChangelog.indexOf('## [Unreleased]')).toBeLessThan(
      updatedChangelog.indexOf('## [0.2.0] - 2026-07-07'),
    );
    expect(updatedChangelog).toContain('- new thing');
  });

  test('stops at the next version section and leaves it untouched', () => {
    const changelog =
      '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- new thing\n\n## [0.1.0] - 2025-01-01\n\n- old thing\n';
    const { updatedChangelog, releaseNotes } = cutChangelog(changelog, '0.2.0', '2026-07-07');

    expect(releaseNotes).toContain('- new thing');
    expect(releaseNotes).not.toContain('- old thing');
    expect(updatedChangelog).toContain('## [0.1.0] - 2025-01-01');
    expect(updatedChangelog).toContain('- old thing');
  });
});
