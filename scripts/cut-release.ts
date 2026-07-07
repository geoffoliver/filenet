import { readFile, writeFile } from 'node:fs/promises';

export type Bump = 'patch' | 'minor' | 'major';

export function bumpVersion(current: string, bump: Bump): string {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid semver version: "${current}"`);

  let [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];

  if (bump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

export function cutChangelog(
  changelog: string,
  version: string,
  date: string,
): { updatedChangelog: string; releaseNotes: string } {
  const unreleasedHeader = '## [Unreleased]';
  const startIdx = changelog.indexOf(unreleasedHeader);
  if (startIdx === -1) {
    throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  }

  const afterHeaderIdx = startIdx + unreleasedHeader.length;
  const rest = changelog.slice(afterHeaderIdx);
  const nextHeaderMatch = rest.match(/\n## /);
  const bodyEnd = nextHeaderMatch ? afterHeaderIdx + nextHeaderMatch.index! : changelog.length;

  const body = changelog.slice(afterHeaderIdx, bodyEnd).trim();
  if (!body) {
    throw new Error('CHANGELOG.md "## [Unreleased]" section is empty — nothing to release');
  }

  const before = changelog.slice(0, startIdx);
  const after = changelog.slice(bodyEnd);
  const updatedChangelog = `${before}## [Unreleased]\n\n## [${version}] - ${date}\n\n${body}\n${after}`;

  return { updatedChangelog, releaseNotes: body };
}

export type CutReleaseOptions = {
  packageJsonPath: string;
  changelogPath: string;
  notesOutPath: string;
  bump: Bump;
  date: string;
};

export async function runCutRelease(opts: CutReleaseOptions): Promise<{ version: string }> {
  const packageJsonText = await readFile(opts.packageJsonPath, 'utf8');
  const pkg = JSON.parse(packageJsonText) as { version: string; [key: string]: unknown };

  const newVersion = bumpVersion(pkg.version, opts.bump);

  const changelogText = await readFile(opts.changelogPath, 'utf8');
  const { updatedChangelog, releaseNotes } = cutChangelog(changelogText, newVersion, opts.date);

  pkg.version = newVersion;
  await writeFile(opts.packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
  await writeFile(opts.changelogPath, updatedChangelog);
  await writeFile(opts.notesOutPath, releaseNotes);

  return { version: newVersion };
}

if (import.meta.main) {
  const bump = process.argv[2];
  const notesOutPath = process.argv[3];

  if (bump !== 'patch' && bump !== 'minor' && bump !== 'major') {
    console.error('Usage: bun scripts/cut-release.ts <patch|minor|major> <notes-out-path>');
    process.exit(1);
  }
  if (!notesOutPath) {
    console.error('Usage: bun scripts/cut-release.ts <patch|minor|major> <notes-out-path>');
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const { version } = await runCutRelease({
    packageJsonPath: 'package.json',
    changelogPath: 'CHANGELOG.md',
    notesOutPath,
    bump,
    date,
  });
  console.log(`Bumped to v${version}`);
}
