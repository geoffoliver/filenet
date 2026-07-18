# GitHub Pages Site — Design

## Overview

Filenet's last open TODO item is a GitHub Pages site: a public-facing landing page plus a docs section (installation, configuration, scripting), with light/dark mode and real screenshots of the app. This closes out `TODO.md`'s Infrastructure section.

## Goals

- A landing page that explains what Filenet is and why it's architecturally different (no central server) in under a screenful, with real screenshots.
- A docs page covering installation, running (dev + standalone binary), configuration, port forwarding, and the scripting API — adapted from the README, not duplicated by hand.
- Auto light/dark mode (`prefers-color-scheme`), no manual toggle.
- Deployed automatically via GitHub Actions on push to `master`, matching the project's existing Actions-first pattern (`ci.yml`, `release.yml`).
- A distinctive visual identity grounded in what the product actually is (P2P, self-hosted, direct encrypted connections) rather than generic template defaults.

## Non-goals

- No JS framework, no build step, no client-side routing.
- No manual dark/light toggle — OS-level `prefers-color-scheme` only.
- No reusable "regenerate screenshots" tooling committed to the repo — the seed script is a one-time throwaway.
- No visual/interaction changes to the actual app — this is a separate static site.

## Architecture

- New top-level `site/` folder, sibling to `app/`, `server/`, `docs/`:
  - `index.html` — landing page
  - `docs.html` — docs/reference page
  - `style.css` — shared stylesheet (single file; site is two pages, doesn't need modules)
  - `screenshots/*.png` — captured app screenshots
- New `.github/workflows/pages.yml`:
  - Triggers: push to `master` touching `site/**` or the workflow file itself, plus `workflow_dispatch`.
  - Steps: `actions/configure-pages`, `actions/upload-pages-artifact` (uploading `site/`), `actions/deploy-pages`.
  - Uses the `github-pages` environment, no `gh-pages` branch involved.
- One-time manual step (or attempted via `gh api`): set the repo's Pages source to "GitHub Actions" in repo settings. If `gh api` lacks permission, this is called out as a manual step for Geoff.
- Site will be live at `https://geoffoliver.github.io/filenet/`. README gets a link near the top.

## Visual Design System

Grounded in what's distinctive about Filenet: no central server, direct encrypted node-to-node connections, self-hosted/homelab audience (same crowd as Sonarr/Radarr, which the TODO explicitly references for single-binary distribution).

**Palette** (light/dark pair, applied via `prefers-color-scheme`):

| Token               | Dark                          | Light                          | Use                                                      |
| ------------------- | ----------------------------- | ------------------------------ | -------------------------------------------------------- |
| `--ink` / `--paper` | `#10141c`                     | `#f2ede4`                      | page background                                          |
| `--paper` / `--ink` | `#eef0e9`                     | `#14181f`                      | primary text                                             |
| `--signal`          | `#ff8a4d`                     | `#d9591c`                      | links, CTA, the pulse animation on connection lines      |
| `--wire`            | `#4fc4bb`                     | `#1f7a72`                      | connection lines, secondary accent, code/mono highlights |
| `--surface`         | slightly lighter than `--ink` | slightly darker than `--paper` | cards, screenshot frames                                 |

Two accents working as a system (copper "signal" + teal "wire"), not a single neon pop — deliberately avoiding the generic near-black-plus-one-accent look.

**Type:**

- Display/headlines: monospace (IBM Plex Mono or system mono stack) — justified because the product's own vocabulary (node IDs, SHA-256 hashes, port numbers) is monospace-native; this isn't an arbitrary "techy font."
- Body: humanist sans (system-ui stack, consistent with the app's own `--font-sans`).
- Captions/labels: same mono family, small size, used for screenshot captions and the "wiring list" annotations.

**Signature element:** an animated hero node graph — "you" connected directly to 4-5 friend nodes by lines, with a subtle pulse traveling along each line, and deliberately _no central hub node_. This makes the core architectural fact ("no central server, direct connections") visible at a glance instead of requiring a sentence to explain. Implemented as inline SVG + a small CSS animation (`stroke-dashoffset` pulse) — no JS animation library.

**Layout motif:**

- Hero: signature node graph + mono headline/subhead/CTA.
- Features presented as a "wiring list" — label + one-line description + a small mono annotation (not numbered 01/02/03 markers, since features aren't a sequence).
- Screenshots presented as "inspection windows": framed panels with a thin `--wire`-colored border and a mono caption underneath (e.g. `// search — query fans out to your network`).
- `docs.html` reuses the same tokens but is quieter/document-like — headings, prose, code blocks — since its job is reference, not persuasion.

**Accessibility floor:** responsive down to mobile width, visible keyboard focus states on links/buttons, `prefers-reduced-motion` respected (pulse animation disabled/static when set).

## Page Content

**`index.html`:**

1. Nav: wordmark + links to Docs / GitHub / Releases.
2. Hero: node graph signature + headline ("No central server. Just you and your friends, talking directly.") + subhead + primary CTA ("Get Filenet" → docs install section).
3. Screenshots section: Home, Search, Chat, Friends, Transfers as "inspection windows" with mono captions.
4. Features ("wiring list"): Friends, Search, Transfers, Chat, Scripting, self-hosted/no-central-server — pulled from the README's feature list, rewritten in the plain-spoken, active-voice register the frontend-design skill calls for (what the person does, not how the system is built).
5. Footer: links to repo, releases, license.

**`docs.html`:**

1. Installation (`git clone` + `bun install`, and the standalone-binary path).
2. Running (dev mode with two processes; production `bun run server`).
3. Configuration (shared folders, download folder, port, auto-accept settings).
4. Networking / port forwarding (generic router instructions, as the app itself shows).
5. Scripting API (`{ file: BunFile; stats: TransferStats }` default export contract).

Content adapted from the current README rather than written from scratch, restructured for a browsable reference page.

## Screenshot Generation

No real network of peers or real files exists to screenshot, so screenshots are staged:

1. Seed the dev SQLite DB directly via Drizzle (bypassing the P2P layer entirely) with realistic fake data: 4-5 friends (varied friendship durations, one pending incoming request), ~12 shared files spanning audio/video/document/image types with real-looking metadata, two chat conversations (one DM, one group) with a handful of messages each, and 2-3 transfers in different states (in-progress, completed).
2. Run the app locally (`bun run server`).
3. Use Playwright (already a project dependency) to load each of the 5 core views (Home, Search, Chat, Friends, Transfers) at a fixed viewport (1440×900) in both light and dark color-scheme emulation, and save PNGs into `site/screenshots/`.
4. The seed script and capture script are written to the scratchpad, run once, and discarded — not committed to the repo. Only the resulting PNGs are committed.

## Deployment

- `.github/workflows/pages.yml` builds nothing (no build step) — it just uploads `site/` as-is and deploys it via the official Pages actions.
- Concurrency group set to avoid overlapping deploys.
- `permissions: pages: write, id-token: write` on the job, per GitHub's Pages-via-Actions requirements.

## Verification

No meaningful unit-test surface (static HTML/CSS, no logic). Verification is manual/visual:

- Serve `site/` locally (e.g. `bunx serve site` or Python's http.server) and check both pages.
- Check both light and dark rendering (OS color-scheme toggle or DevTools emulation).
- Check mobile width responsiveness and keyboard focus states.
- Confirm the deployed Pages URL renders correctly after the workflow runs.

## Risks / Open Questions

- Enabling "Pages via Actions" on the repo may require a manual one-click step in GitHub settings if `gh api` can't do it from here — flagged as a possible handoff to Geoff.
- Screenshot fidelity depends on how good the staged demo data looks; if it reads as obviously fake, may need a second pass on seed content.
