# GitHub Actions Release Workflow — Design

## Goal

Automate cutting a release: bump `package.json`'s version, cut the
CHANGELOG's `[Unreleased]` section into a versioned one, tag it, build all
five platform binaries (already scripted via `bun run build:binaries`), and
publish a GitHub Release with those binaries attached. Triggered by hand,
from the Actions tab, when the maintainer decides a release is ready — not
on every push.

## Current state

- `.github/workflows/ci.yml` — lint, format check, `bun test` on every push/PR
  to `master`/`main`. No release automation exists.
- `package.json` version is `0.1.0`. No git tags exist yet.
- `scripts/build-binaries.sh` (via `bun run build:binaries`) already builds
  and packages all 5 targets (`linux-x64`, `linux-arm64`, `darwin-x64`,
  `darwin-arm64`, `windows-x64`) as `dist/filenet-<target>.tar.gz`/`.zip`,
  cross-compiled from a single machine — no matrix of OS runners needed.
- `CHANGELOG.md` is hand-written prose (Keep a Changelog style), with a
  `## [Unreleased]` section at the top holding un-released entries. No
  compare-link footer to maintain — just `##` headers.
- `README.md` already tells binary users to "Download
  `filenet-<platform>.tar.gz`... from the Releases page" — so the Releases
  page is an existing user-facing promise this workflow fulfills.
- Docker builds from source locally (`build: .` in `docker-compose.yml`); no
  registry image is published today. Out of scope for this workflow.

## Trigger & guard rails

New `.github/workflows/release.yml`:

- `workflow_dispatch` with one required input: `bump`, a choice of
  `patch` / `minor` / `major`.
- First step asserts `github.ref == 'refs/heads/master'`, failing fast
  otherwise — the workflow pushes a commit and tag to master, so it must
  only ever run from there, even though `workflow_dispatch` technically
  allows picking any ref.
- `concurrency: { group: release, cancel-in-progress: false }` so a second
  dispatch while one is in-flight queues instead of racing it (racing could
  double-bump the version).
- `permissions: contents: write` (needed to push the commit/tag and create
  the Release).

## Pre-flight (fail before mutating anything)

Same steps as `ci.yml`, run first in this workflow too: checkout,
`oven-sh/setup-bun` (pinned version matching `ci.yml`), `bun install
--frozen-lockfile`, `eslint --max-warnings=0`, `prettier --check .`,
`bun test server/__tests__`. If any fail, the workflow stops — never tag or
publish a build that doesn't pass CI.

## Version + changelog step

A small script (inline shell or a `scripts/cut-release.ts` run via `bun`)
that:

1. Reads `package.json`'s current `"version"`, computes the new version
   from the `bump` input using standard semver rules.
2. Reads `CHANGELOG.md`, locates `## [Unreleased]`. If there is no
   non-empty content between that header and the next `## ` header (or EOF),
   **fail the workflow** with a clear error — there's nothing to release.
3. Rewrites that section's header to `## [x.y.z] - YYYY-MM-DD` (UTC date of
   the run) and inserts a fresh, empty `## [Unreleased]` above it.
4. Writes the moved section's body (everything between the new
   `## [x.y.z] ...` header and the next `## ` header) to a temp file — this
   becomes the GitHub Release notes body, used verbatim in the publish step.
5. Updates `package.json`'s `"version"` to the new value.

## Commit, tag, push

- `git commit -am "chore: release vX.Y.Z"` (bot identity — same
  `github-actions[bot]` user/email convention GitHub Actions commits
  typically use).
- `git tag -a vX.Y.Z -m "vX.Y.Z"`.
- `git push origin master --follow-tags` (pushes the commit and the tag
  together).

## Build & publish

- `bun run build:binaries` — produces `dist/filenet-<target>.tar.gz`/`.zip`
  for all 5 targets, as it does locally today.
- `gh release create vX.Y.Z dist/*.tar.gz dist/*.zip --title vX.Y.Z
--notes-file <temp file from the changelog step>` — creates the Release and
  uploads all 5 archives in one call. `gh` is preinstalled on GitHub-hosted
  runners and authenticates via the default `GITHUB_TOKEN`.

## Testing & verification

- This is CI/CD glue, not application code — no Bun/Playwright tests apply.
  Verification is: run the workflow for real (`workflow_dispatch` with
  `bump: patch`) after merging, confirm:
  - `package.json` version and `CHANGELOG.md` update correctly on master
  - the new tag exists and points at that commit
  - the GitHub Release is created with the correct notes and all 5 archives
    attached
  - a second, immediate dispatch while the first is still running queues
    rather than racing (can verify by triggering twice back-to-back once)
- Before the first real release, do a dry run of just the changelog-cutting
  script logic locally against the current `CHANGELOG.md`/`package.json` to
  confirm the parsing handles the real file, not a synthetic fixture.

## Scope

**In scope:** manual-dispatch release workflow — version bump, changelog
cut, tag, build all 5 binaries, publish GitHub Release with those binaries
attached.

**Out of scope (explicitly deferred):**

- Docker image publishing to any registry — Docker continues to build from
  source locally; nothing in README or `docker-compose.yml` promises a
  pre-built image today.
- Auto-update mechanism (detecting/installing new releases from within the
  running app) — separate TODO item, depends on releases existing first.
- Release notes for anything other than the cut CHANGELOG section (no
  GitHub auto-generated "What's Changed" PR list).
