import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { bumpVersion, cutChangelog, runCutRelease } from '../cut-release';

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

describe('runCutRelease', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cut-release-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('updates package.json, cuts CHANGELOG.md, and writes release notes to the given path', async () => {
    const packageJsonPath = join(dir, 'package.json');
    const changelogPath = join(dir, 'CHANGELOG.md');
    const notesOutPath = join(dir, 'notes.md');

    await writeFile(
      packageJsonPath,
      JSON.stringify({ name: 'filenet', version: '0.1.0' }, null, 2),
    );
    await writeFile(changelogPath, '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- new thing\n');

    const result = await runCutRelease({
      packageJsonPath,
      changelogPath,
      notesOutPath,
      bump: 'minor',
      date: '2026-07-07',
    });

    expect(result.version).toBe('0.2.0');

    const updatedPkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    expect(updatedPkg.version).toBe('0.2.0');
    expect(updatedPkg.name).toBe('filenet');

    const updatedChangelog = await readFile(changelogPath, 'utf8');
    expect(updatedChangelog).toContain('## [0.2.0] - 2026-07-07');

    const notes = await readFile(notesOutPath, 'utf8');
    expect(notes).toContain('- new thing');
  });

  test('rejects an empty Unreleased section without writing any files', async () => {
    const packageJsonPath = join(dir, 'package.json');
    const changelogPath = join(dir, 'CHANGELOG.md');
    const notesOutPath = join(dir, 'notes.md');

    await writeFile(
      packageJsonPath,
      JSON.stringify({ name: 'filenet', version: '0.1.0' }, null, 2),
    );
    await writeFile(
      changelogPath,
      '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2025-01-01\n\nold\n',
    );

    await expect(
      runCutRelease({
        packageJsonPath,
        changelogPath,
        notesOutPath,
        bump: 'patch',
        date: '2026-07-07',
      }),
    ).rejects.toThrow('nothing to release');

    const pkgAfter = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    expect(pkgAfter.version).toBe('0.1.0');
  });
});
