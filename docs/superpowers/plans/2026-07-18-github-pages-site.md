# GitHub Pages Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a static GitHub Pages site (`site/`) for Filenet — a landing page and a docs page, with auto light/dark mode and real screenshots of the running app — closing the last open TODO item.

**Architecture:** Two hand-written static HTML pages (`site/index.html`, `site/docs.html`) sharing one stylesheet (`site/style.css`), no build step, no JS framework. Screenshots are staged by seeding the dev SQLite DB with fake data and capturing the 5 core app views with Playwright. Deployment is a GitHub Actions workflow that uploads `site/` as a Pages artifact — no `gh-pages` branch.

**Tech Stack:** Plain HTML/CSS, inline SVG + CSS animation for the hero graphic, Playwright (already a dev dependency) for screenshot capture, GitHub Actions (`actions/configure-pages`, `actions/upload-pages-artifact`, `actions/deploy-pages`) for deployment.

## Global Constraints

- No JS framework, no build step for the site itself (spec: Non-goals).
- No manual dark/light toggle — `prefers-color-scheme` only (spec: Goals).
- Site source lives in `site/`, not `docs/` (spec: Architecture).
- Repo is `geoffoliver/filenet` → Pages URL is `https://geoffoliver.github.io/filenet/`.
- Screenshot files use exactly these names in `site/screenshots/`: `home-light.png`, `home-dark.png`, `search-light.png`, `search-dark.png`, `chat-light.png`, `chat-dark.png`, `friends-light.png`, `friends-dark.png`, `transfers-light.png`, `transfers-dark.png`.
- Color tokens (semantic names, resolving the spec's ink/paper naming into `--bg`/`--fg`):
  - Light (default): `--bg:#f2ede4; --fg:#14181f; --signal:#d9591c; --wire:#1f7a72; --surface:#e8e2d5;`
  - Dark (`prefers-color-scheme: dark`): `--bg:#10141c; --fg:#eef0e9; --signal:#ff8a4d; --wire:#4fc4bb; --surface:#1a1f2a;`
- Display font: IBM Plex Mono (headlines, captions, labels). Body font: system sans stack, matching the app's own `--font-sans` in `app/globals.css`.
- Accessibility floor: responsive to mobile width, visible `:focus-visible` states, `prefers-reduced-motion` respected on the hero animation.
- Seed/capture scripts used to generate screenshots are throwaway — written under `scripts/tmp-*.ts`, run once, then deleted before the final commit. Only the resulting PNGs are committed.
- Pre-commit hooks run Prettier on `*.{json,css,md}` — HTML isn't in that glob today, but CSS and Markdown changes must pass `bunx prettier --check` before committing (matches existing `lint-staged` config in `package.json`).

---

## File Structure

- `site/index.html` — landing page (nav, hero, screenshots, features, footer)
- `site/docs.html` — docs/reference page (install, run, configure, network, scripting)
- `site/style.css` — shared stylesheet for both pages
- `site/favicon.svg` — copy of `app/icon.svg` (📁 emoji favicon)
- `site/screenshots/*.png` — 10 captured screenshots (5 views × light/dark)
- `.github/workflows/pages.yml` — deploy workflow
- `README.md` — one new line linking to the deployed site

---

### Task 1: Shared stylesheet + page shells

**Files:**

- Create: `site/style.css`
- Create: `site/favicon.svg`
- Create: `site/index.html`
- Create: `site/docs.html`

**Interfaces:**

- Produces: CSS custom properties `--bg`, `--fg`, `--signal`, `--wire`, `--surface`, `--font-display`, `--font-body`, and classes `.site-nav`, `.site-footer`, `.btn`, `.btn-signal`, `.wrap` — all later tasks build inside the `<main>` these shells define and reuse these tokens/classes.
- Produces: page shell markup (`<nav class="site-nav">…</nav>` and `<footer class="site-footer">…</footer>`) identical on both pages except the active nav link.

- [ ] **Step 1: Copy the existing favicon**

```bash
cp /Users/geoff/Work/Websites/filez/app/icon.svg /Users/geoff/Work/Websites/filez/site/favicon.svg
```

- [ ] **Step 2: Write `site/style.css`**

```css
/* ── Tokens ─────────────────────────────────────────────────────────────── */
:root {
  --bg: #f2ede4;
  --fg: #14181f;
  --signal: #d9591c;
  --wire: #1f7a72;
  --surface: #e8e2d5;

  --font-display: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;

  --nav-height: 64px;
  --radius: 8px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #10141c;
    --fg: #eef0e9;
    --signal: #ff8a4d;
    --wire: #4fc4bb;
    --surface: #1a1f2a;
  }
}

/* ── Reset ──────────────────────────────────────────────────────────────── */
* {
  box-sizing: border-box;
}

html {
  color-scheme: light dark;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.55;
}

img {
  max-width: 100%;
  display: block;
}

a {
  color: var(--signal);
}

.wrap {
  max-width: 1040px;
  margin: 0 auto;
  padding: 0 24px;
}

:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 3px;
}

/* ── Nav ────────────────────────────────────────────────────────────────── */
.site-nav {
  height: var(--nav-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--surface);
}

.site-nav .wrap {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.wordmark {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 1.1rem;
  color: var(--fg);
  text-decoration: none;
  letter-spacing: -0.02em;
}

.nav-links {
  display: flex;
  gap: 24px;
  list-style: none;
  margin: 0;
  padding: 0;
  font-family: var(--font-display);
  font-size: 0.9rem;
}

.nav-links a {
  color: var(--fg);
  text-decoration: none;
}

.nav-links a:hover,
.nav-links a[aria-current='page'] {
  color: var(--signal);
}

/* ── Buttons ────────────────────────────────────────────────────────────── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-radius: var(--radius);
  font-family: var(--font-display);
  font-size: 0.95rem;
  text-decoration: none;
  border: 1px solid transparent;
}

.btn-signal {
  background: var(--signal);
  color: var(--bg);
}

.btn-outline {
  border-color: var(--wire);
  color: var(--fg);
}

/* ── Footer ─────────────────────────────────────────────────────────────── */
.site-footer {
  border-top: 1px solid var(--surface);
  margin-top: 96px;
  padding: 32px 0;
  font-family: var(--font-display);
  font-size: 0.85rem;
  color: var(--fg);
  opacity: 0.75;
}

.site-footer .wrap {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  justify-content: space-between;
}

.site-footer a {
  color: inherit;
}

@media (max-width: 640px) {
  .nav-links {
    gap: 14px;
    font-size: 0.8rem;
  }
}
```

- [ ] **Step 3: Write `site/index.html` shell**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Filenet — self-hosted, peer-to-peer file sharing and chat</title>
    <meta
      name="description"
      content="Filenet is a self-hosted, peer-to-peer file sharing and chat app. No central server — you connect directly and encrypted to your friends."
    />
    <link rel="icon" href="favicon.svg" type="image/svg+xml" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <nav class="site-nav">
      <div class="wrap">
        <a class="wordmark" href="index.html">filenet</a>
        <ul class="nav-links">
          <li><a href="docs.html">docs</a></li>
          <li><a href="https://github.com/geoffoliver/filenet">github</a></li>
          <li>
            <a href="https://github.com/geoffoliver/filenet/releases">releases</a>
          </li>
        </ul>
      </div>
    </nav>

    <main></main>

    <footer class="site-footer">
      <div class="wrap">
        <span>filenet — self-hosted, peer-to-peer, no central server</span>
        <span
          ><a href="https://github.com/geoffoliver/filenet/blob/master/LICENSE">license</a></span
        >
      </div>
    </footer>
  </body>
</html>
```

- [ ] **Step 4: Write `site/docs.html` shell**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Docs — Filenet</title>
    <meta
      name="description"
      content="Installing, running, and configuring Filenet, plus the post-download scripting API."
    />
    <link rel="icon" href="favicon.svg" type="image/svg+xml" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <nav class="site-nav">
      <div class="wrap">
        <a class="wordmark" href="index.html">filenet</a>
        <ul class="nav-links">
          <li><a href="docs.html" aria-current="page">docs</a></li>
          <li><a href="https://github.com/geoffoliver/filenet">github</a></li>
          <li>
            <a href="https://github.com/geoffoliver/filenet/releases">releases</a>
          </li>
        </ul>
      </div>
    </nav>

    <main></main>

    <footer class="site-footer">
      <div class="wrap">
        <span>filenet — self-hosted, peer-to-peer, no central server</span>
        <span
          ><a href="https://github.com/geoffoliver/filenet/blob/master/LICENSE">license</a></span
        >
      </div>
    </footer>
  </body>
</html>
```

- [ ] **Step 5: Verify formatting**

Run: `bunx prettier --check site/style.css`
Expected: `All matched files use Prettier code style!`

(HTML isn't in the project's Prettier glob — no check needed for the `.html` files themselves, but don't let that be an excuse for sloppy indentation.)

- [ ] **Step 6: Verify in browser**

Run: `bunx serve site` (or `python3 -m http.server 8080 --directory site`), then open `http://localhost:3000` (or `:8080`).
Expected: both `index.html` and `docs.html` load with the nav, empty body, and footer visible, styled with the ink/paper tokens. Toggle OS dark mode (or DevTools → Rendering → `prefers-color-scheme`) and confirm colors swap.

- [ ] **Step 7: Commit**

```bash
git add site/style.css site/favicon.svg site/index.html site/docs.html
git commit -m "site: add shared stylesheet and page shells"
```

---

### Task 2: Hero section with node-graph signature graphic

**Files:**

- Modify: `site/index.html` (fill `<main>`)
- Modify: `site/style.css` (append hero + node-graph rules)

**Interfaces:**

- Consumes: tokens/classes from Task 1 (`--signal`, `--wire`, `--surface`, `--font-display`, `.btn`, `.btn-signal`, `.wrap`).
- Produces: `.hero` section markup that Task 3's features section is appended after, inside the same `<main>`.

- [ ] **Step 1: Insert the hero markup into `site/index.html`**

Replace `<main></main>` with:

```html
<main>
  <section class="hero">
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <p class="eyebrow">peer-to-peer · self-hosted</p>
        <h1>No central server.<br />Just you and your friends,<br />talking directly.</h1>
        <p class="hero-sub">
          Filenet is a self-hosted file sharing and chat app. You keep a list of friends, connect
          straight to their machines over encrypted WebSockets, and search their shared files — and
          their friends', and theirs — without anyone's data passing through a company's servers.
        </p>
        <div class="hero-actions">
          <a class="btn btn-signal" href="docs.html#installation">Get Filenet →</a>
          <a class="btn btn-outline" href="https://github.com/geoffoliver/filenet">View source</a>
        </div>
      </div>
      <svg
        class="node-graph"
        viewBox="0 0 480 360"
        role="img"
        aria-label="Diagram showing you connected directly to four friends, with no central server in between"
      >
        <g class="ng-edges">
          <line class="ng-edge" x1="240" y1="300" x2="100" y2="200" />
          <line class="ng-edge" x1="240" y1="300" x2="380" y2="200" />
          <line class="ng-edge" x1="100" y1="200" x2="160" y2="60" />
          <line class="ng-edge" x1="380" y1="200" x2="320" y2="60" />
          <line class="ng-edge" x1="160" y1="60" x2="320" y2="60" />
        </g>
        <g class="ng-nodes">
          <circle class="ng-node ng-node-you" cx="240" cy="300" r="10" />
          <text class="ng-label" x="240" y="330">you</text>
          <circle class="ng-node" cx="100" cy="200" r="8" />
          <text class="ng-label" x="100" y="224">alex</text>
          <circle class="ng-node" cx="380" cy="200" r="8" />
          <text class="ng-label" x="380" y="224">sam</text>
          <circle class="ng-node" cx="160" cy="60" r="8" />
          <text class="ng-label" x="160" y="40">jordan</text>
          <circle class="ng-node" cx="320" cy="60" r="8" />
          <text class="ng-label" x="320" y="40">rae</text>
        </g>
      </svg>
    </div>
  </section>
</main>
```

- [ ] **Step 2: Append hero + node-graph CSS to `site/style.css`**

```css
/* ── Hero ───────────────────────────────────────────────────────────────── */
.hero {
  padding: 64px 0 48px;
}

.hero-grid {
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  gap: 48px;
  align-items: center;
}

.eyebrow {
  font-family: var(--font-display);
  font-size: 0.85rem;
  color: var(--wire);
  text-transform: lowercase;
  letter-spacing: 0.04em;
  margin: 0 0 12px;
}

.hero h1 {
  font-family: var(--font-display);
  font-size: clamp(1.8rem, 3.4vw, 2.6rem);
  line-height: 1.2;
  letter-spacing: -0.01em;
  margin: 0 0 20px;
}

.hero-sub {
  font-size: 1.05rem;
  max-width: 46ch;
  opacity: 0.9;
  margin: 0 0 28px;
}

.hero-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

/* ── Node graph ─────────────────────────────────────────────────────────── */
.node-graph {
  width: 100%;
  height: auto;
}

.ng-edge {
  stroke: var(--wire);
  stroke-width: 2;
  fill: none;
  stroke-dasharray: 6 10;
  animation: ng-pulse 3s linear infinite;
}

.ng-node {
  fill: var(--surface);
  stroke: var(--signal);
  stroke-width: 2;
}

.ng-node-you {
  fill: var(--signal);
}

.ng-label {
  font-family: var(--font-display);
  font-size: 13px;
  fill: var(--fg);
  text-anchor: middle;
}

@keyframes ng-pulse {
  to {
    stroke-dashoffset: -32;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ng-edge {
    animation: none;
  }
}

@media (max-width: 800px) {
  .hero-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 3: Verify formatting**

Run: `bunx prettier --check site/style.css`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 4: Verify in browser**

Reload `index.html` via the local server from Task 1. Confirm: headline + copy + two buttons render on the left, the node graph renders on the right with 5 labeled nodes and 5 connecting lines, and the lines visibly pulse (dashes animate). Confirm no node sits at the visual center connecting to all others — "you" only connects to alex and sam; jordan/rae connect to each other and to alex/sam independently. Resize to <800px width and confirm the graph stacks below the copy. Toggle `prefers-reduced-motion: reduce` in DevTools and confirm the pulse stops.

- [ ] **Step 5: Commit**

```bash
git add site/index.html site/style.css
git commit -m "site: add hero section with animated node-graph signature graphic"
```

---

### Task 3: Features "wiring list" section

**Files:**

- Modify: `site/index.html` (append section inside `<main>`, after `.hero`)
- Modify: `site/style.css` (append wiring-list rules)

**Interfaces:**

- Consumes: tokens from Task 1.
- Produces: `.wiring-list` section, appended before the screenshots section that Task 5 adds.

- [ ] **Step 1: Insert the features markup**

Add this `<section>` immediately after `</section>` (closing `.hero`) in `site/index.html`, still inside `<main>`:

```html
<section class="wiring">
  <div class="wrap">
    <h2 class="section-title">how it's wired</h2>
    <ul class="wiring-list">
      <li class="wiring-item">
        <span class="wiring-tag">friends</span>
        <div>
          <h3>Add people, not accounts</h3>
          <p>
            Add a friend by address and port. They stay pending until they accept — or skip the wait
            with a password they gave you.
          </p>
        </div>
        <span class="wiring-note">status: accepted / pending</span>
      </li>
      <li class="wiring-item">
        <span class="wiring-tag">search</span>
        <div>
          <h3>Search reaches your whole network</h3>
          <p>
            One query fans out to your friends, their friends, and so on. Every node that finds a
            match sends the result straight back to you.
          </p>
        </div>
        <span class="wiring-note">fanout · TTL-bounded</span>
      </li>
      <li class="wiring-item">
        <span class="wiring-tag">transfers</span>
        <div>
          <h3>Pull files from everyone who has them</h3>
          <p>
            Downloads run BitTorrent-style — chunked, multi-source, resumable, and SHA-256 verified
            end to end.
          </p>
        </div>
        <span class="wiring-note">1 MB chunks · 4 concurrent</span>
      </li>
      <li class="wiring-item">
        <span class="wiring-tag">chat</span>
        <div>
          <h3>Direct messages and group rooms</h3>
          <p>
            One-on-one chats and group rooms, encrypted over the same connection you use for search
            and transfers.
          </p>
        </div>
        <span class="wiring-note">DM + group</span>
      </li>
      <li class="wiring-item">
        <span class="wiring-tag">scripts</span>
        <div>
          <h3>Run your own code on every download</h3>
          <p>
            Write a script, point Filenet at it, and it runs automatically once a file finishes —
            move it, archive it, whatever you need.
          </p>
        </div>
        <span class="wiring-note">TS/JS · default export</span>
      </li>
      <li class="wiring-item">
        <span class="wiring-tag">no server</span>
        <div>
          <h3>Nothing to trust but each other</h3>
          <p>
            There's no company in the middle. You forward one port, share your address with people
            you know, and connect directly.
          </p>
        </div>
        <span class="wiring-note">Ed25519 + X25519 + AES-256-GCM</span>
      </li>
    </ul>
  </div>
</section>
```

- [ ] **Step 2: Append wiring-list CSS to `site/style.css`**

```css
/* ── Wiring list ────────────────────────────────────────────────────────── */
.wiring {
  padding: 48px 0;
}

.section-title {
  font-family: var(--font-display);
  font-size: 0.95rem;
  text-transform: lowercase;
  letter-spacing: 0.04em;
  color: var(--wire);
  margin: 0 0 24px;
}

.wiring-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--surface);
}

.wiring-item {
  display: grid;
  grid-template-columns: 110px 1fr 200px;
  gap: 20px;
  align-items: start;
  padding: 20px 0;
  border-bottom: 1px solid var(--surface);
}

.wiring-tag {
  font-family: var(--font-display);
  font-size: 0.8rem;
  color: var(--signal);
}

.wiring-item h3 {
  margin: 0 0 6px;
  font-size: 1.05rem;
}

.wiring-item p {
  margin: 0;
  opacity: 0.9;
}

.wiring-note {
  font-family: var(--font-display);
  font-size: 0.78rem;
  opacity: 0.65;
  text-align: right;
}

@media (max-width: 720px) {
  .wiring-item {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .wiring-note {
    text-align: left;
  }
}
```

- [ ] **Step 3: Verify formatting**

Run: `bunx prettier --check site/style.css`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 4: Verify in browser**

Reload `index.html`. Confirm six rows render below the hero, each with a tag / title+description / mono annotation, separated by hairline rules. Resize below 720px and confirm each row stacks vertically.

- [ ] **Step 5: Commit**

```bash
git add site/index.html site/style.css
git commit -m "site: add features wiring-list section"
```

---

### Task 4: Seed demo data and capture screenshots

**Files:**

- Create (throwaway, deleted at end of task): `scripts/tmp-seed-demo-data.ts`
- Create (throwaway, deleted at end of task): `scripts/tmp-capture-screenshots.ts`
- Create: `site/screenshots/home-light.png`, `home-dark.png`, `search-light.png`, `search-dark.png`, `chat-light.png`, `chat-dark.png`, `friends-light.png`, `friends-dark.png`, `transfers-light.png`, `transfers-dark.png`

**Interfaces:**

- Produces: the 10 PNG files above, at 1440×900, which Task 5 references by exact filename.

This task runs against an isolated demo database, not the real dev DB (`./data/filenet.db`), so it doesn't pollute any real local data.

- [ ] **Step 1: Build the app, then boot it once against a fresh demo database to generate an Identity row**

`bun run server` serves the pre-built static Next.js export (`out/`) — without a build it 404s. Build first:

```bash
cd /Users/geoff/Work/Websites/filez
bun run build
DATABASE_URL=./data/filenet-demo.db bun run server
```

Wait for the "listening" log line, then `Ctrl+C` to stop it. This creates `data/filenet-demo.db` with an `Identity` row (the server generates one on first boot). Confirm `http://localhost:3000` actually renders the app (not a 404) before moving on.

- [ ] **Step 2: Write `scripts/tmp-seed-demo-data.ts`**

```typescript
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, applyMigrations } from '../server/db';
import {
  friends,
  settings,
  sharedFiles,
  conversations,
  messages,
  downloads,
  identity,
} from '../server/schema';

function fakeNodeId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

function fakeSha256(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

const db = createDb('./data/filenet-demo.db');
applyMigrations(db);

const now = Date.now();
const day = 24 * 60 * 60 * 1000;

const [me] = await db.select().from(identity).limit(1);
if (!me) {
  throw new Error(
    'No Identity row found. Run `DATABASE_URL=./data/filenet-demo.db bun run server` once, ' +
      'Ctrl+C after it logs "listening", then re-run this script.',
  );
}

await db.update(settings).set({ name: 'Riley' }).where(eq(settings.id, 'singleton'));

const demoFriends: Array<{
  name: string;
  days: number;
  status?: 'ACCEPTED' | 'INCOMING_PENDING';
}> = [
  { name: 'Alex', days: 210 },
  { name: 'Sam', days: 140 },
  { name: 'Jordan', days: 40 },
  { name: 'Rae', days: 5, status: 'INCOMING_PENDING' },
];

for (const f of demoFriends) {
  const addedAt = now - f.days * day;
  await db.insert(friends).values({
    id: randomUUID(),
    name: f.name,
    nodeId: fakeNodeId(f.name),
    address: `${f.name.toLowerCase()}.demo.local`,
    port: 7734,
    publicKey: fakeNodeId(`${f.name}-pub`),
    status: f.status ?? 'ACCEPTED',
    addedAt,
    acceptedAt: f.status === 'INCOMING_PENDING' ? null : addedAt,
    updatedAt: addedAt,
    downloadCount: Math.floor(Math.random() * 40),
    downloadTotalBytes: BigInt(Math.floor(Math.random() * 4_000_000_000)),
    uploadCount: Math.floor(Math.random() * 25),
    uploadTotalBytes: BigInt(Math.floor(Math.random() * 2_500_000_000)),
  });
}

const demoFiles = [
  {
    filename: 'Radiohead - OK Computer/03 Subterranean Homesick Alien.flac',
    size: 32_400_000,
    mimeType: 'audio/flac',
    metadata: { artist: 'Radiohead', album: 'OK Computer', track: 3, duration: 267 },
  },
  {
    filename: 'Dune Part Two (2024) 1080p.mkv',
    size: 8_900_000_000,
    mimeType: 'video/x-matroska',
    metadata: { duration: 9840, codec: 'HEVC' },
  },
  {
    filename: 'The Pragmatic Programmer.epub',
    size: 4_200_000,
    mimeType: 'application/epub+zip',
    metadata: { title: 'The Pragmatic Programmer', author: 'David Thomas' },
  },
  {
    filename: 'tax-documents-2025.pdf',
    size: 1_100_000,
    mimeType: 'application/pdf',
    metadata: { title: 'Tax Documents 2025', pages: 14 },
  },
  {
    filename: 'vacation-photos/IMG_4821.jpg',
    size: 6_800_000,
    mimeType: 'image/jpeg',
    metadata: { camera: 'Canon EOS R6', width: 6000, height: 4000 },
  },
  {
    filename: 'Daft Punk - Discovery/01 One More Time.flac',
    size: 29_100_000,
    mimeType: 'audio/flac',
    metadata: { artist: 'Daft Punk', album: 'Discovery', track: 1, duration: 320 },
  },
  {
    filename: 'Severance S02E01.mkv',
    size: 2_300_000_000,
    mimeType: 'video/x-matroska',
    metadata: { duration: 3120, codec: 'HEVC' },
  },
  {
    filename: 'Sapiens - A Brief History of Humankind.epub',
    size: 3_600_000,
    mimeType: 'application/epub+zip',
    metadata: { title: 'Sapiens', author: 'Yuval Noah Harari' },
  },
  {
    filename: 'home-network-diagram.pdf',
    size: 540_000,
    mimeType: 'application/pdf',
    metadata: { title: 'Home Network Diagram', pages: 2 },
  },
  {
    filename: 'vacation-photos/IMG_4902.jpg',
    size: 7_200_000,
    mimeType: 'image/jpeg',
    metadata: { camera: 'Canon EOS R6', width: 6000, height: 4000 },
  },
  {
    filename: 'Boards of Canada - Music Has the Right to Children/05 Roygbiv.flac',
    size: 24_700_000,
    mimeType: 'audio/flac',
    metadata: {
      artist: 'Boards of Canada',
      album: 'Music Has the Right to Children',
      track: 5,
      duration: 235,
    },
  },
  {
    filename: 'The Expanse Season 1/S01E01 Dulcinea.mkv',
    size: 1_800_000_000,
    mimeType: 'video/x-matroska',
    metadata: { duration: 2640, codec: 'H264' },
  },
];

for (const f of demoFiles) {
  await db.insert(sharedFiles).values({
    id: randomUUID(),
    path: `/home/riley/shared/${f.filename}`,
    filename: f.filename.split('/').pop()!,
    size: BigInt(f.size),
    sha256: fakeSha256(`${f.filename}:${f.size}`),
    mimeType: f.mimeType,
    metadata: JSON.stringify(f.metadata),
    fileModifiedAt: now - Math.floor(Math.random() * 60) * day,
    lastSeenAt: now,
    indexedAt: now,
    updatedAt: now,
  });
}

const dm = {
  id: randomUUID(),
  type: 'DM' as const,
  name: null,
  createdAt: now - 90 * day,
  updatedAt: now - 2 * 60 * 60 * 1000,
};
await db.insert(conversations).values(dm);

const alexNodeId = fakeNodeId('Alex');
const dmMessages = [
  { from: alexNodeId, body: 'Hey, did you grab that Dune rip yet?', minsAgo: 180 },
  { from: me.nodeId, body: "Grabbing it now, 4 sources so it's flying", minsAgo: 175 },
  { from: alexNodeId, body: 'Nice, send it my way once post-processing runs', minsAgo: 170 },
  {
    from: me.nodeId,
    body: "Script'll drop it straight into /Movies, you're all set",
    minsAgo: 120,
  },
];
for (const m of dmMessages) {
  await db.insert(messages).values({
    id: randomUUID(),
    conversationId: dm.id,
    fromNodeId: m.from,
    body: m.body,
    sentAt: now - m.minsAgo * 60 * 1000,
  });
}

const group = {
  id: randomUUID(),
  type: 'GROUP' as const,
  name: 'homelab crew',
  createdAt: now - 200 * day,
  updatedAt: now - 30 * 60 * 1000,
};
await db.insert(conversations).values(group);

const samNodeId = fakeNodeId('Sam');
const jordanNodeId = fakeNodeId('Jordan');
const groupMessages = [
  {
    from: samNodeId,
    body: 'anyone else having their rescan hang on the media share?',
    minsAgo: 90,
  },
  { from: me.nodeId, body: "haven't seen that, what's the folder size?", minsAgo: 85 },
  { from: samNodeId, body: '~4TB, mostly video', minsAgo: 80 },
  {
    from: jordanNodeId,
    body: 'try bumping the rescan interval, mine chokes below 60m too',
    minsAgo: 60,
  },
  { from: samNodeId, body: 'that did it, thanks', minsAgo: 35 },
];
for (const m of groupMessages) {
  await db.insert(messages).values({
    id: randomUUID(),
    conversationId: group.id,
    fromNodeId: m.from,
    body: m.body,
    sentAt: now - m.minsAgo * 60 * 1000,
  });
}

const duneFile = demoFiles[1];
const severanceFile = demoFiles[6];

await db.insert(downloads).values({
  id: randomUUID(),
  sha256: fakeSha256(`${duneFile.filename}:${duneFile.size}`),
  filename: duneFile.filename.split('/').pop()!,
  size: BigInt(duneFile.size),
  mimeType: duneFile.mimeType,
  state: 'DOWNLOADING',
  bytesReceived: BigInt(Math.floor(duneFile.size * 0.42)),
  chunkSize: 1048576,
  completedChunks: '[]',
  sources: JSON.stringify([fakeNodeId('Alex'), fakeNodeId('Sam'), fakeNodeId('Jordan')]),
  downloadFolder: '/home/riley/downloads',
  createdAt: now - 6 * 60 * 1000,
  updatedAt: now,
});

await db.insert(downloads).values({
  id: randomUUID(),
  sha256: fakeSha256(`${severanceFile.filename}:${severanceFile.size}`),
  filename: severanceFile.filename.split('/').pop()!,
  size: BigInt(severanceFile.size),
  mimeType: severanceFile.mimeType,
  state: 'COMPLETED',
  bytesReceived: BigInt(severanceFile.size),
  chunkSize: 1048576,
  completedChunks: '[]',
  sources: JSON.stringify([fakeNodeId('Sam')]),
  downloadFolder: '/home/riley/downloads',
  finalPath: '/home/riley/downloads/Severance S02E01.mkv',
  createdAt: now - 2 * day,
  updatedAt: now - 2 * day + 20 * 60 * 1000,
  completedAt: now - 2 * day + 20 * 60 * 1000,
});

console.log('Demo data seeded into data/filenet-demo.db');
```

- [ ] **Step 3: Run the seed script**

```bash
DATABASE_URL=./data/filenet-demo.db bun run scripts/tmp-seed-demo-data.ts
```

Expected: `Demo data seeded into data/filenet-demo.db` with no errors.

- [ ] **Step 4: Start the server against the demo database**

Reuses the `out/` build from Step 1 — no need to rebuild unless source files changed since then.

```bash
DATABASE_URL=./data/filenet-demo.db bun run server
```

Leave it running in this terminal (or background it) — it must stay up for Step 6. Confirm `http://localhost:3000` shows the populated Home dashboard, not the setup wizard.

- [ ] **Step 5: Write `scripts/tmp-capture-screenshots.ts`**

```typescript
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const BASE_URL = process.env.FILENET_URL ?? 'http://localhost:3000';
const OUT_DIR = 'site/screenshots';
mkdirSync(OUT_DIR, { recursive: true });

const views: Array<{
  name: string;
  path: string;
  before?: (page: Page) => Promise<void>;
}> = [
  { name: 'home', path: '/' },
  {
    name: 'search',
    path: '/search',
    before: async (page) => {
      const input = page.getByRole('textbox').first();
      await input.fill('the');
      await input.press('Enter');
      await page.waitForTimeout(500);
    },
  },
  { name: 'chat', path: '/chat' },
  { name: 'friends', path: '/friends' },
  { name: 'transfers', path: '/transfers' },
];

for (const scheme of ['light', 'dark'] as const) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await context.newPage();
  for (const view of views) {
    await page.goto(`${BASE_URL}${view.path}`, { waitUntil: 'networkidle' });
    if (view.before) await view.before(page);
    await page.screenshot({ path: `${OUT_DIR}/${view.name}-${scheme}.png` });
    console.log(`captured ${view.name}-${scheme}.png`);
  }
  await browser.close();
}
```

- [ ] **Step 6: Run the capture script (in a second terminal, server still running from Step 4)**

```bash
bunx playwright install chromium  # first time only
bun run scripts/tmp-capture-screenshots.ts
```

Expected: 10 `captured <name>-<scheme>.png` lines, and 10 files present in `site/screenshots/`.

Run: `ls site/screenshots`
Expected: `chat-dark.png chat-light.png friends-dark.png friends-light.png home-dark.png home-light.png search-dark.png search-light.png transfers-dark.png transfers-light.png`

- [ ] **Step 7: Stop the server and clean up throwaway files**

Stop the Step 4 server (`Ctrl+C`), then:

```bash
rm scripts/tmp-seed-demo-data.ts scripts/tmp-capture-screenshots.ts
rm data/filenet-demo.db data/filenet-demo.db-shm data/filenet-demo.db-wal 2>/dev/null
```

- [ ] **Step 8: Open each screenshot and eyeball it**

Open the 10 files in `site/screenshots/` (e.g. `open site/screenshots/*.png` on macOS). Confirm each shows the right view, with the seeded demo data visible (friends named Alex/Sam/Jordan/Rae, the seeded files/messages/transfers) and no error states or blank screens. If a view looks broken (e.g. search returned nothing), fix the corresponding `before` step and re-run Steps 3-6 before proceeding — don't hand-edit the PNGs.

- [ ] **Step 9: Commit**

```bash
git add site/screenshots/
git commit -m "site: add staged screenshots of the 5 core app views"
```

---

### Task 5: Screenshots "inspection windows" section

**Files:**

- Modify: `site/index.html` (append section inside `<main>`, after `.wiring`)
- Modify: `site/style.css` (append inspection-window rules)

**Interfaces:**

- Consumes: the 10 PNGs from Task 4 by exact filename, and tokens from Task 1.

- [ ] **Step 1: Insert the screenshots markup**

The spec's page order is hero → screenshots → features, but Task 3 (which runs first) already appended `.wiring` right after `.hero`. Insert this `<section>` **between** them: immediately after the hero section's closing `</section>` tag and before `<section class="wiring">`, still inside `<main>`:

```html
<section class="screens">
  <div class="wrap">
    <h2 class="section-title">see it running</h2>
    <div class="screens-grid">
      <figure class="inspection-window">
        <picture>
          <source srcset="screenshots/home-dark.png" media="(prefers-color-scheme: dark)" />
          <img src="screenshots/home-light.png" alt="Filenet's Home dashboard" loading="lazy" />
        </picture>
        <figcaption>// home — network size, transfer stats, at a glance</figcaption>
      </figure>
      <figure class="inspection-window">
        <picture>
          <source srcset="screenshots/search-dark.png" media="(prefers-color-scheme: dark)" />
          <img src="screenshots/search-light.png" alt="Filenet's Search view" loading="lazy" />
        </picture>
        <figcaption>// search — query fans out to your network</figcaption>
      </figure>
      <figure class="inspection-window">
        <picture>
          <source srcset="screenshots/chat-dark.png" media="(prefers-color-scheme: dark)" />
          <img src="screenshots/chat-light.png" alt="Filenet's Chat view" loading="lazy" />
        </picture>
        <figcaption>// chat — DMs and group rooms, end to end</figcaption>
      </figure>
      <figure class="inspection-window">
        <picture>
          <source srcset="screenshots/friends-dark.png" media="(prefers-color-scheme: dark)" />
          <img src="screenshots/friends-light.png" alt="Filenet's Friends view" loading="lazy" />
        </picture>
        <figcaption>// friends — who you're connected to, directly</figcaption>
      </figure>
      <figure class="inspection-window">
        <picture>
          <source srcset="screenshots/transfers-dark.png" media="(prefers-color-scheme: dark)" />
          <img
            src="screenshots/transfers-light.png"
            alt="Filenet's Transfers view"
            loading="lazy"
          />
        </picture>
        <figcaption>// transfers — multi-source, resumable, verified</figcaption>
      </figure>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Append inspection-window CSS to `site/style.css`**

```css
/* ── Screenshots ────────────────────────────────────────────────────────── */
.screens {
  padding: 48px 0;
}

.screens-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 24px;
}

.inspection-window {
  margin: 0;
  border: 1px solid var(--wire);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--surface);
}

.inspection-window img {
  width: 100%;
  border-bottom: 1px solid var(--wire);
}

.inspection-window figcaption {
  padding: 10px 14px;
  font-family: var(--font-display);
  font-size: 0.78rem;
  color: var(--wire);
}
```

- [ ] **Step 3: Verify formatting**

Run: `bunx prettier --check site/style.css`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 4: Verify in browser**

Reload `index.html`. Confirm 5 framed screenshots render in a responsive grid with mono captions underneath. Toggle dark mode and confirm each image swaps to its `-dark` variant (DevTools → Rendering → emulate `prefers-color-scheme: dark`, then hard-reload — `<picture>` swaps don't require a JS re-render, but some browsers cache the initial choice).

- [ ] **Step 5: Commit**

```bash
git add site/index.html site/style.css
git commit -m "site: add screenshots section with light/dark-aware inspection windows"
```

---

### Task 6: Docs page content

**Files:**

- Modify: `site/docs.html` (fill `<main>`)
- Modify: `site/style.css` (append docs typography rules)

**Interfaces:**

- Consumes: tokens/classes from Task 1.

- [ ] **Step 1: Insert docs content into `site/docs.html`**

Replace `<main></main>` with:

```html
<main>
  <div class="wrap docs">
    <h1>docs</h1>

    <h2 id="installation">Installation</h2>
    <p>Filenet requires <a href="https://bun.sh">Bun</a> ≥ 1.0.</p>
    <pre><code>git clone https://github.com/geoffoliver/filenet.git
cd filenet
bun install</code></pre>

    <h2 id="running">Running</h2>
    <p>Build once, then run the server:</p>
    <pre><code>bun run build
bun run server</code></pre>
    <p>
      Open <a href="http://localhost:3000">http://localhost:3000</a>. On first launch, the setup
      wizard walks you through configuration.
    </p>
    <p>The app runs two listeners in a single process:</p>
    <table>
      <thead>
        <tr>
          <th>Listener</th>
          <th>Default</th>
          <th>Purpose</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>UI + API</td>
          <td><code>:3000</code></td>
          <td>Static web UI and management API (same process)</td>
        </tr>
        <tr>
          <td>P2P server</td>
          <td><code>:7734</code></td>
          <td>Encrypted WebSocket connections to peers</td>
        </tr>
      </tbody>
    </table>

    <h3>Standalone executable</h3>
    <p>
      Filenet also ships as a standalone executable with no separate Node/Bun install required.
      Download
      <code>filenet-bun-&lt;platform&gt;.zip</code> from the
      <a href="https://github.com/geoffoliver/filenet/releases">Releases</a>
      page, extract it, and run <code>./filenet</code> from that folder. Filenet checks for new
      releases automatically and shows a <strong>Restart to update</strong> button in Settings once
      one's ready.
    </p>

    <h2 id="configuration">Configuration</h2>
    <p>All settings live in the app's <strong>Settings</strong> page:</p>
    <ul>
      <li><strong>Name</strong> — your display name, shared with friends</li>
      <li><strong>Shared folders</strong> — directories that get indexed and shared</li>
      <li><strong>Download folder</strong> — where downloaded files land</li>
      <li>
        <strong>Auto-accept</strong> — accept friend requests from anyone, or require a password
      </li>
      <li><strong>Invite password</strong> — peers who supply this are auto-accepted</li>
      <li>
        <strong>Rescan interval</strong> — how often shared folders are re-indexed (0 = manual only)
      </li>
      <li>
        <strong>Port</strong> — the port peers connect to (default <code>7734</code>); you must
        forward this on your router
      </li>
      <li><strong>Auto-open browser</strong> — opens the app on server start (default: on)</li>
    </ul>

    <h2 id="networking">Networking / port forwarding</h2>
    <p>There's no automatic NAT traversal — you forward one port yourself:</p>
    <ol>
      <li>
        Find your router's admin interface (usually <code>192.168.1.1</code> or
        <code>192.168.0.1</code>)
      </li>
      <li>Look for "Port Forwarding" or "Virtual Server"</li>
      <li>
        Forward <strong>TCP port 7734</strong> (or your configured port) to your machine's local IP
      </li>
      <li>Share your public IP address (or a domain name pointing to it) with friends</li>
    </ol>
    <p>
      <strong>Forward only the P2P port.</strong> Never expose the web UI (port 3000) to the
      internet — it has no authentication and grants full control of the application to anyone who
      can reach it. It's meant for your home network only.
    </p>

    <h2 id="scripting">Post-download scripts</h2>
    <p>
      Scripts run in order after each download completes. Each one is a TypeScript/JavaScript file
      with a default export:
    </p>
    <pre><code>import type { BunFile } from 'bun';

interface TransferStats {
  downloadTimeMs: number;
  bytesTransferred: number;
  maxSources: number;
}

export default async function ({ file, stats }: { file: BunFile; stats: TransferStats }) {
  console.log(`Downloaded ${file.name} in ${stats.downloadTimeMs}ms`);
}</code></pre>
    <p>
      Add script paths in <strong>Settings → Scripts</strong> and reorder them. If a script moves or
      renames the file, later scripts in the chain receive the updated path.
    </p>
  </div>
</main>
```

- [ ] **Step 2: Append docs typography CSS to `site/style.css`**

```css
/* ── Docs page ──────────────────────────────────────────────────────────── */
.docs {
  padding: 48px 0 96px;
  max-width: 760px;
}

.docs h1 {
  font-family: var(--font-display);
  font-size: 2rem;
  margin: 0 0 32px;
}

.docs h2 {
  font-family: var(--font-display);
  font-size: 1.3rem;
  margin: 48px 0 16px;
  padding-top: 24px;
  border-top: 1px solid var(--surface);
}

.docs h3 {
  font-size: 1.05rem;
  margin: 24px 0 12px;
}

.docs p,
.docs li {
  opacity: 0.92;
}

.docs code {
  font-family: var(--font-display);
  font-size: 0.85em;
  background: var(--surface);
  padding: 2px 6px;
  border-radius: 4px;
}

.docs pre {
  background: var(--surface);
  border: 1px solid var(--wire);
  border-radius: var(--radius);
  padding: 16px;
  overflow-x: auto;
}

.docs pre code {
  background: none;
  padding: 0;
}

.docs table {
  border-collapse: collapse;
  width: 100%;
  margin: 16px 0;
}

.docs th,
.docs td {
  text-align: left;
  padding: 8px 12px;
  border: 1px solid var(--surface);
  font-size: 0.9rem;
}

.docs th {
  font-family: var(--font-display);
  color: var(--wire);
}
```

- [ ] **Step 3: Verify formatting**

Run: `bunx prettier --check site/style.css`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 4: Verify in browser**

Reload `docs.html`. Confirm all five headed sections render with working anchor IDs (`#installation`, `#running`, `#configuration`, `#networking`, `#scripting`), the table and code blocks are legible in both light and dark mode, and the "Get Filenet →" link on `index.html` (from Task 2) correctly jumps to `docs.html#installation`.

- [ ] **Step 5: Commit**

```bash
git add site/docs.html site/style.css
git commit -m "site: add docs page content"
```

---

### Task 7: Deploy workflow and README link

**Files:**

- Create: `.github/workflows/pages.yml`
- Modify: `README.md` (add a link near the top)

**Interfaces:**

- Produces: a `pages` GitHub Actions workflow, matching the existing `ci.yml`/`release.yml` pattern in `.github/workflows/`.

- [ ] **Step 1: Write `.github/workflows/pages.yml`**

```yaml
name: Deploy Pages

on:
  push:
    branches: [master]
    paths:
      - 'site/**'
      - '.github/workflows/pages.yml'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure Pages
        uses: actions/configure-pages@v5

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: site

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Add a README link**

Find the line in `README.md` right after the title/intro paragraph (`A self-hosted, peer-to-peer file sharing and chat application...`) and add, on the next line:

```markdown
**[Website & docs →](https://geoffoliver.github.io/filenet/)**
```

- [ ] **Step 3: Verify formatting**

Run: `bunx prettier --check README.md .github/workflows/pages.yml`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 4: Attempt to enable "Pages via Actions" on the repo**

```bash
gh api repos/geoffoliver/filenet/pages -X POST -f build_type=workflow
```

Expected: JSON response describing the new Pages site, or (if Pages is already configured some other way) an error — in which case retry with `-X PUT` instead of `-X POST`. If both fail with a permissions error, this needs a manual one-time step: repo Settings → Pages → Build and deployment → Source → "GitHub Actions". Tell the user this is needed if the API calls fail.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/pages.yml README.md
git commit -m "site: add GitHub Actions Pages deployment workflow"
```

- [ ] **Step 6: Push and confirm the workflow runs**

```bash
git push
gh run watch
```

Expected: the `Deploy Pages` workflow run completes successfully. Then run:

```bash
gh api repos/geoffoliver/filenet/pages --jq .html_url
```

Expected: `https://geoffoliver.github.io/filenet/`. Open it and confirm the live site matches what was verified locally.

---

### Task 8: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Serve the site locally one more time**

```bash
bunx serve site
```

- [ ] **Step 2: Check responsiveness**

In a browser, resize the window (or use DevTools device toolbar) down to 375px width on both `index.html` and `docs.html`. Expected: nav links wrap or stay usable, hero stacks vertically, wiring-list rows stack, screenshots grid drops to one column, docs table doesn't overflow the viewport (it may scroll horizontally within `.docs pre`/`table`, that's fine — the page itself must not scroll horizontally).

- [ ] **Step 3: Check keyboard focus**

Tab through both pages using only the keyboard. Expected: every link and button shows a visible focus ring (the `--signal`-colored outline from Task 1's `:focus-visible` rule), in a sensible tab order (nav → hero CTAs → screenshots links if any → footer).

- [ ] **Step 4: Check reduced motion**

In DevTools, enable "Emulate CSS prefers-reduced-motion: reduce". Expected: the node-graph pulse animation stops (confirmed already in Task 2, re-check here as a final gate).

- [ ] **Step 5: Check both color schemes end-to-end**

Toggle OS/DevTools color scheme between light and dark. Expected: every section (nav, hero, wiring list, screenshots incl. swapped images, docs page) uses the correct token set with no unreadable text (e.g. no dark text on dark background left over from a hardcoded color).

- [ ] **Step 6: Confirm deployed site matches**

Revisit `https://geoffoliver.github.io/filenet/` (from Task 7, Step 6) and spot-check the same things as Steps 2-5 on the live URL.

No commit for this task — it's a verification-only pass. If any check fails, fix it in the relevant earlier task's files and amend forward with a new commit (don't reopen closed tasks' history).
