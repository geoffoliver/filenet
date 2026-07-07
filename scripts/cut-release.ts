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
