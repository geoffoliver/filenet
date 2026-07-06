# Single-Binary Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Filenet as a standalone executable (`bun build --compile`, five platform targets) with no external runtime dependency, by switching the Next.js frontend to a static export and folding the management API into a single unified UI+API Bun server — while keeping Docker fully working as an equally-supported deployment path.

**Architecture:** `next build` (with `output: 'export'`) now only produces static files in `out/`. A new `server/ui-server.ts` serves those files and calls the existing `createManagementFetch` handler in-process for `/api/*` — no second process, no HTTP hop, no `127.0.0.1:7735`. The P2P `Bun.serve` is untouched. `server/index.ts` runs both listeners in one process, which is exactly what the compiled binary runs too.

**Tech Stack:** Bun, Next.js 16 (App Router, static export), Drizzle ORM/SQLite, Bun's `bun build --compile`.

## Global Constraints

- Docker remains a fully supported deployment path, unchanged in spirit — it keeps running from source (`bun server/index.ts`), not the compiled binary.
- The management API must never be reachable from the **P2P port** (the one users forward through their router). It only ever binds to the UI port.
- Release artifact shape is **binary + assets folder** (e.g. `filenet-linux-x64.tar.gz` containing the executable, `out/`, and `drizzle/migrations/`) — not a single embedded-everything file. Do not add codegen/embedding tooling to make it one literal file.
- Five compile targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`.
- Out of scope for this plan: wiring binary builds into CI/release automation (separate TODO item), and adding real authentication to the UI/management port (pre-existing gap, explicitly deferred).
- Spec: `docs/superpowers/specs/2026-07-05-single-binary-distribution-design.md`.

---

### Task 1: `resolveAssetPath` runtime-path utility

**Files:**

- Create: `server/runtime-paths.ts`
- Test: `server/__tests__/runtime-paths.test.ts`

**Interfaces:**

- Produces: `resolveAssetPath(repoRootRelativePath: string, callerDir: string, execPath?: string): string` — resolves the on-disk location of an asset that lives at the repo root, whether running from source or as a compiled executable. Used by Task 2 (`db.ts`) and Task 4 (`server/index.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// server/__tests__/runtime-paths.test.ts
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAssetPath } from '../runtime-paths';

describe('resolveAssetPath', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves relative to the repo root when running from source', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'filenet-paths-'));
    tmpDirs.push(repoRoot);
    const serverDir = join(repoRoot, 'server');
    mkdirSync(serverDir, { recursive: true });
    mkdirSync(join(repoRoot, 'drizzle', 'migrations'), { recursive: true });

    const resolved = resolveAssetPath('drizzle/migrations', serverDir, '/unused/exec');

    expect(resolved).toBe(join(repoRoot, 'drizzle', 'migrations'));
  });

  it('falls back to the executable directory when the source-relative path does not exist', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'filenet-paths-'));
    tmpDirs.push(repoRoot);
    const serverDir = join(repoRoot, 'server');
    mkdirSync(serverDir, { recursive: true });
    // No drizzle/migrations created here — simulates the compiled-binary
    // case where import.meta.dir is a synthetic path with nothing on disk.

    const execDir = mkdtempSync(join(tmpdir(), 'filenet-exec-'));
    tmpDirs.push(execDir);
    const execPath = join(execDir, 'filenet');

    const resolved = resolveAssetPath('drizzle/migrations', serverDir, execPath);

    expect(resolved).toBe(join(execDir, 'drizzle', 'migrations'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/__tests__/runtime-paths.test.ts`
Expected: FAIL — `Cannot find module '../runtime-paths'` (file doesn't exist yet)

- [ ] **Step 3: Write minimal implementation**

```ts
// server/runtime-paths.ts
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Resolves the on-disk location of an asset (Drizzle migrations, the
 * exported static UI, etc.) that lives at the repo root.
 *
 * Two shapes are supported:
 * - Running from source (`bun server/index.ts`, dev or Docker): the asset
 *   sits at `<repo root>/<repoRootRelativePath>`, found relative to the
 *   calling module's directory.
 * - Running as a `bun build --compile` executable: `import.meta.dir`
 *   resolves to a synthetic path inside the binary, not a real directory,
 *   so the source-relative candidate won't exist. In that case the asset
 *   ships in a folder next to the compiled executable instead.
 */
export function resolveAssetPath(
  repoRootRelativePath: string,
  callerDir: string,
  execPath: string = process.execPath,
): string {
  const sourceCandidate = join(callerDir, '..', repoRootRelativePath);
  if (existsSync(sourceCandidate)) return sourceCandidate;
  return join(dirname(execPath), repoRootRelativePath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test server/__tests__/runtime-paths.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add server/runtime-paths.ts server/__tests__/runtime-paths.test.ts
git commit -m "feat(server): add resolveAssetPath for source vs compiled-binary paths"
```

---

### Task 2: Wire `db.ts` migrations to `resolveAssetPath`

**Files:**

- Modify: `server/db.ts`

**Interfaces:**

- Consumes: `resolveAssetPath` from Task 1.
- No change to `applyMigrations(db: Db): void` or `createDb(path?: string)` signatures — every existing caller (every test file's `beforeAll`) is unaffected.

- [ ] **Step 1: Modify `server/db.ts`**

```ts
// server/db.ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

import * as schema from './schema';
import { resolveAssetPath } from './runtime-paths';

export type Db = ReturnType<typeof createDb>;

export function createDb(path?: string): ReturnType<typeof drizzle<typeof schema>> {
  const raw = path ?? process.env.DATABASE_URL ?? './data/filenet.db';
  const dbPath = raw.startsWith('file:') ? raw.slice(5) : raw;
  const sqlite = new Database(dbPath, { create: true });
  sqlite.exec('PRAGMA journal_mode=WAL;');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  return drizzle(sqlite, { schema });
}

export function applyMigrations(db: Db): void {
  migrate(db, { migrationsFolder: resolveAssetPath('drizzle/migrations', import.meta.dir) });
}
```

Note: the `join` import from `node:path` is no longer used directly in this file and must be removed (was only used to build the old inline migrations path).

- [ ] **Step 2: Run the full backend suite to confirm no regression**

Run: `bun test server/__tests__`
Expected: PASS — every test file (`management.test.ts`, `chat.test.ts`, etc.) calls `applyMigrations(db)` in its `beforeAll`, so this is the regression check for this change; no new test file is needed for a pure path-resolution swap already covered by every other suite.

- [ ] **Step 3: Commit**

```bash
git add server/db.ts
git commit -m "refactor(db): resolve migrations folder via resolveAssetPath"
```

---

### Task 3: `createUiServer` — static file + in-process API server

**Files:**

- Create: `server/ui-server.ts`
- Test: `server/__tests__/ui-server.test.ts`

**Interfaces:**

- Consumes: `createManagementFetch`, `type ManagementDeps` from `server/management.ts` (existing, unchanged).
- Produces: `createUiServer(deps: UiServerDeps): (req: Request) => Promise<Response>` where `UiServerDeps = ManagementDeps & { outDir: string; devOrigin?: string; isDev?: boolean }`. Used by Task 4 (`server/index.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// server/__tests__/ui-server.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Db, applyMigrations, createDb } from '../db';
import { createUiServer } from '../ui-server';
import { generateIdentity } from '../identity';

const TEST_DB_PATH = './data/test-ui-server.db';
let db: Db;
let outDir: string;

const identity = generateIdentity();
const neverConnect = async (): Promise<never> => {
  throw new Error('no real connections in tests');
};

function req(path: string, options?: RequestInit) {
  return new Request(`http://localhost${path}`, options);
}

function makeHandler(overrides?: Partial<{ isDev: boolean; devOrigin: string }>) {
  return createUiServer({ identity, db, connectPeer: neverConnect, outDir, ...overrides });
}

beforeAll(async () => {
  db = createDb(TEST_DB_PATH);
  applyMigrations(db);

  outDir = await mkdtemp(join(tmpdir(), 'filenet-ui-server-'));
  await writeFile(join(outDir, 'index.html'), '<html>home</html>');
  await writeFile(join(outDir, 'settings.html'), '<html>settings</html>');
  await writeFile(join(outDir, '404.html'), '<html>not found</html>');
  await mkdir(join(outDir, '_next', 'static'), { recursive: true });
  await writeFile(join(outDir, '_next', 'static', 'app.js'), 'console.log(1);');
});

afterAll(async () => {
  db.$client.close();
  await rm(outDir, { recursive: true, force: true });
  await Promise.all(
    [TEST_DB_PATH, `${TEST_DB_PATH}-shm`, `${TEST_DB_PATH}-wal`].map((p) => rm(p, { force: true })),
  );
});

describe('createUiServer', () => {
  it('serves the root static file for /', async () => {
    const res = await makeHandler()(req('/'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>home</html>');
  });

  it('serves a named route by appending .html', async () => {
    const res = await makeHandler()(req('/settings'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>settings</html>');
  });

  it('serves an exact static asset path', async () => {
    const res = await makeHandler()(req('/_next/static/app.js'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1);');
  });

  it('falls back to 404.html for unknown routes', async () => {
    const res = await makeHandler()(req('/does-not-exist'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('<html>not found</html>');
  });

  it('routes /api/* to the management handler in-process', async () => {
    const res = await makeHandler()(req('/api/me'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodeId: identity.nodeId });
  });

  it('adds CORS headers to /api/* responses in dev mode', async () => {
    const res = await makeHandler({ isDev: true, devOrigin: 'http://localhost:3001' })(
      req('/api/me'),
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3001');
  });

  it('omits CORS headers from /api/* responses in production mode', async () => {
    const res = await makeHandler({ isDev: false })(req('/api/me'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers OPTIONS preflight for /api/* in dev mode', async () => {
    const res = await makeHandler({ isDev: true, devOrigin: 'http://localhost:3001' })(
      req('/api/me', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3001');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/__tests__/ui-server.test.ts`
Expected: FAIL — `Cannot find module '../ui-server'`

- [ ] **Step 3: Write minimal implementation**

```ts
// server/ui-server.ts
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createManagementFetch, type ManagementDeps } from './management';

export type UiServerDeps = ManagementDeps & {
  outDir: string;
  devOrigin?: string;
  isDev?: boolean;
};

export function createUiServer(deps: UiServerDeps): (req: Request) => Promise<Response> {
  const {
    outDir,
    devOrigin = 'http://localhost:3001',
    isDev = process.env.NODE_ENV !== 'production',
    ...managementDeps
  } = deps;
  const managementFetch = createManagementFetch(managementDeps);

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/')) {
      if (isDev && req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(devOrigin) });
      }
      const res = await managementFetch(req);
      if (!isDev) return res;
      const headers = new Headers(res.headers);
      for (const [key, value] of Object.entries(corsHeaders(devOrigin))) headers.set(key, value);
      return new Response(res.body, { status: res.status, headers });
    }

    const filePath = resolveStaticFile(outDir, url.pathname);
    if (filePath) return new Response(Bun.file(filePath));

    const notFoundPath = resolveStaticFile(outDir, '/404');
    return new Response(notFoundPath ? Bun.file(notFoundPath) : '404 Not Found', { status: 404 });
  };
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function resolveStaticFile(outDir: string, pathname: string): string | null {
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const candidates = [
    join(outDir, normalized),
    join(outDir, `${normalized}.html`),
    join(outDir, normalized, 'index.html'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test server/__tests__/ui-server.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add server/ui-server.ts server/__tests__/ui-server.test.ts
git commit -m "feat(server): add createUiServer serving static files + in-process API"
```

---

### Task 4: Rewire `server/index.ts` — drop standalone management server

**Files:**

- Modify: `server/index.ts`

**Interfaces:**

- Consumes: `createUiServer` (Task 3), `resolveAssetPath` (Task 1).
- Renames internal variable `PORT` (P2P port) to `P2P_PORT` to free up `PORT` for the new UI port — `PORT` env var now means "UI+API port" (default `3000`), matching Docker's existing `ENV PORT=3000` convention that previously fed Next.js.
- `MGMT_PORT` env var and its validation are removed entirely.

- [ ] **Step 1: Replace `server/index.ts`**

```ts
// server/index.ts
import {
  type PeerData,
  dispatchSearchMessage,
  dispatchVouchMessage,
  handleMessage,
  handleOpen,
} from './peer';
import { applyMigrations, createDb } from './db';
import { clearActiveUploadSessionsForPeer, dispatchTransferMessage } from './transfer-protocol';
import { connectToPeer, getConnectedPeer, unregisterPeer } from './connections';
import { getOrCreateSettings, parseSharedFolders } from './config';
import { createUiServer } from './ui-server';
import { resolveAssetPath } from './runtime-paths';
import { getOrCreateIdentity } from './identity';
import { pauseAllActiveDownloads } from './download-manager';
import { startPeriodicRescan } from './indexer';
import { startReconnectLoop } from './reconnect';

const db = createDb();
applyMigrations(db);

const identity = await getOrCreateIdentity(db);
const startupSettings = await getOrCreateSettings(db);

const P2P_PORT = parseInt(process.env.P2P_PORT ?? String(startupSettings.listenPort), 10);
if (isNaN(P2P_PORT) || P2P_PORT < 1 || P2P_PORT > 65535)
  throw new Error(
    process.env.P2P_PORT !== undefined
      ? `Invalid P2P_PORT env var: "${process.env.P2P_PORT}"`
      : `Invalid listenPort in settings: ${startupSettings.listenPort}`,
  );

const UI_PORT = parseInt(process.env.PORT ?? '3000', 10);
if (isNaN(UI_PORT) || UI_PORT < 1 || UI_PORT > 65535)
  throw new Error(`Invalid PORT env var: "${process.env.PORT ?? ''}"`);

if (P2P_PORT === UI_PORT)
  throw new Error(
    `P2P port and UI port must be different — both resolved to ${P2P_PORT}` +
      ` (P2P from ${process.env.P2P_PORT !== undefined ? 'P2P_PORT env var' : 'listenPort in settings'},` +
      ` UI from ${process.env.PORT !== undefined ? 'PORT env var' : 'default 3000'})`,
  );

console.log(`Node ID:  ${identity.nodeId}`);
console.log(`P2P port: ${P2P_PORT}`);
console.log(`UI port:  ${UI_PORT}`);

const stopRescan = startPeriodicRescan(
  db,
  async () => {
    const s = await getOrCreateSettings(db);
    return parseSharedFolders(s.sharedFolders);
  },
  async () => {
    const s = await getOrCreateSettings(db);
    return s.rescanIntervalMinutes;
  },
);

const connectPeerFn = (
  address: string,
  port: number,
  friendRequest?: { name: string; password?: string },
) =>
  connectToPeer(identity, db, address, port, P2P_PORT, friendRequest, async (nodeId, msg) => {
    await dispatchSearchMessage(msg, nodeId, db, identity);
    await dispatchTransferMessage(msg, nodeId, db);
    await dispatchVouchMessage(msg, nodeId, db);
  });

const stopReconnect = startReconnectLoop(db, identity, connectPeerFn);

const shutdown = () => {
  stopRescan();
  stopReconnect();
  pauseAllActiveDownloads(db)
    .catch(() => {})
    .finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

Bun.serve({
  port: UI_PORT,
  fetch: createUiServer({
    identity,
    db,
    connectPeer: connectPeerFn,
    outDir: resolveAssetPath('out', import.meta.dir),
  }),
});

Bun.serve<PeerData>({
  port: P2P_PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/pubkey') {
      return Response.json({
        nodeId: identity.nodeId,
        publicKey: identity.publicKey.toString('base64'),
      });
    }

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', nodeId: identity.nodeId });
    }

    if (
      server.upgrade(req, {
        data: {
          identity,
          db,
          localPort: P2P_PORT,
          state: { phase: 'pending' },
        },
      })
    ) {
      return undefined;
    }

    return new Response('Not Found', { status: 404 });
  },
  websocket: {
    open(ws) {
      handleOpen(ws);
    },
    message(ws, raw) {
      handleMessage(ws, raw);
    },
    close(ws) {
      const state = ws.data.state;
      if (state.phase === 'authenticated') {
        const current = getConnectedPeer(state.peerNodeId);
        if (current && (current.ws as unknown) === ws) {
          unregisterPeer(state.peerNodeId);
          clearActiveUploadSessionsForPeer(state.peerNodeId);
        }
      }
    },
  },
});
```

- [ ] **Step 2: Run the full backend suite to confirm no regression**

Run: `bun test server/__tests__`
Expected: PASS — nothing in the suite imports `server/index.ts` directly (it's an entrypoint with top-level side effects), so this checks that Tasks 1–3's building blocks are all still green.

- [ ] **Step 3: Manually verify both listeners start correctly**

Run (in a scratch dir so it doesn't touch real data):

```bash
DATABASE_URL=file:./data/manual-verify.db P2P_PORT=7734 PORT=3000 bun server/index.ts &
sleep 1
curl -s http://localhost:7734/health
curl -s http://localhost:3000/api/me
kill %1
rm -f data/manual-verify.db data/manual-verify.db-shm data/manual-verify.db-wal
```

Expected: `/health` returns `{"status":"ok","nodeId":"..."}`; `/api/me` returns `{"nodeId":"..."}` (same nodeId). Requests to the UI port for non-`/api` paths will 404 at this point — `out/` doesn't exist yet until Task 5's `next build` runs; that's expected and gets exercised in Task 9.

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "refactor(server): serve UI+API from one process, drop standalone mgmt server"
```

---

### Task 5: Static export — `next.config.ts` + remove the API proxy route

**Files:**

- Modify: `next.config.ts`
- Delete: `app/api/[...path]/route.ts`

**Interfaces:** none — this task has no consumers in later tasks beyond "the build now produces `out/`", which Task 9 verifies end-to-end.

- [ ] **Step 1: Delete the proxy route**

```bash
git rm "app/api/[...path]/route.ts"
rmdir "app/api/[...path]" app/api 2>/dev/null || true
```

This file relies on `Request` (headers/body) to blindly forward requests, which Next's static-export docs (`node_modules/next/dist/docs/01-app/02-guides/static-exports.md`) list as explicitly unsupported — and note that attempting to use it errors even under `next dev`, not just `next build`. It cannot be kept around for dev-only use; Task 6 replaces its purpose with a configurable API base URL.

- [ ] **Step 2: Enable static export in `next.config.ts`**

```ts
// next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
};

export default nextConfig;
```

- [ ] **Step 3: Run the production build to verify it succeeds**

Run: `bun run build`
Expected: exits 0, prints something like `Exporting (3/3)`, and creates `out/index.html`. (Since `app/lib/api.ts` still does relative `fetch('/api/...')` calls at this point, the app will 404 on those calls if actually loaded in a browser right now — that's fine, this step only checks the build itself succeeds. Task 6 fixes the runtime fetch behavior.)

- [ ] **Step 4: Commit**

```bash
git add next.config.ts
git commit -m "feat(web): switch to static export, remove API proxy route"
```

---

### Task 6: Configurable API base URL — keep dev and e2e working

**Files:**

- Modify: `app/lib/api.ts`
- Modify: `playwright.config.ts`
- Create: `.env.development`

**Interfaces:**

- Produces: `NEXT_PUBLIC_API_BASE_URL` env var convention — empty/unset means same-origin (production static build, served by the unified server), set to an absolute origin for cross-origin local dev.
- No changes to any exported function signature or return type in `app/lib/api.ts` — every caller in `app/(shell)/**` keeps working unchanged.

- [ ] **Step 1: Add `.env.development`**

```bash
# .env.development
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
```

This is picked up automatically by `next dev` (Next's built-in dev-env-file convention) so a developer running `bun run dev` (Next on :3001) alongside `bun run server` (the unified UI+API+P2P server, defaulting to :3000) gets full-stack local dev with HMR, same as the two-process setup that existed before this change — just cross-origin instead of same-origin.

- [ ] **Step 2: Pin `playwright.config.ts` to same-origin for e2e**

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:3001',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // e2e tests mock /api/* via page.route('/api/...'), which Playwright
      // resolves relative to `baseURL`. Keep API calls same-origin during
      // e2e runs regardless of what .env.development sets for real
      // full-stack local dev, so those mocks keep matching.
      NEXT_PUBLIC_API_BASE_URL: '',
    },
  },
});
```

- [ ] **Step 3: Add the `apiUrl` helper and wrap every fetch call in `app/lib/api.ts`**

```ts
// app/lib/api.ts
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export function formatSpeed(bps: number): string {
  if (bps === 0) return '–';
  return `${formatBytes(bps)}/s`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '–';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatBytes(s: string | number): string {
  let n: bigint;
  try {
    n = BigInt(typeof s === 'number' ? Math.trunc(s) : s);
  } catch {
    return '0 B';
  }
  if (n === 0n) return '0 B';
  const KB = 1024n;
  const MB = KB * 1024n;
  const GB = MB * 1024n;
  const TB = GB * 1024n;
  // For KB–GB, n is small enough that Number() is exact (all < 2^40 < MAX_SAFE_INTEGER).
  // For TB+, divide BigInt first so the Number() operand stays in safe-integer range.
  if (n < KB) return `${n} B`;
  if (n < MB) return `${(Number(n) / Number(KB)).toFixed(1)} KB`;
  if (n < GB) return `${(Number(n) / Number(MB)).toFixed(1)} MB`;
  if (n < TB) return `${(Number(n) / Number(GB)).toFixed(2)} GB`;
  return `${(Number(n / GB) / 1024).toFixed(2)} TB`;
}

export type Settings = {
  id: string;
  name: string;
  hasInvitePassword: boolean;
  autoAcceptFromAnyone: boolean;
  autoAcceptFromFriendsOfFriends: boolean;
  sharedFolders: string[];
  downloadFolder: string | null;
  rescanIntervalMinutes: number;
  listenPort: number;
};

export type EnvConfig = {
  sharedFolders: string[];
  downloadFolder: string | null;
};

export type SettingsPatch = {
  name?: string;
  invitePassword?: string | null;
  autoAcceptFromAnyone?: boolean;
  autoAcceptFromFriendsOfFriends?: boolean;
  sharedFolders?: string[];
  downloadFolder?: string | null;
  rescanIntervalMinutes?: number;
  listenPort?: number;
};

export async function getMyInfo(): Promise<{ nodeId: string }> {
  const res = await fetch(apiUrl('/api/me'));
  if (!res.ok) throw new Error('Failed to load identity');
  return res.json();
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch(apiUrl('/api/settings'));
  if (!res.ok) throw new Error('Failed to load settings');
  return res.json();
}

export async function getEnvConfig(): Promise<EnvConfig> {
  const res = await fetch(apiUrl('/api/settings/env'));
  if (!res.ok) return { sharedFolders: [], downloadFolder: null };
  return res.json();
}

export async function patchSettings(patch: SettingsPatch): Promise<Settings> {
  const res = await fetch(apiUrl('/api/settings'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to save settings');
  }
  return res.json();
}

export type FriendStatus = 'OUTGOING_PENDING' | 'INCOMING_PENDING' | 'ACCEPTED' | 'BLOCKED';

export type Friend = {
  id: string;
  name: string;
  nodeId: string | null;
  address: string;
  port: number;
  status: FriendStatus;
  addedAt: string;
  acceptedAt: string | null;
  updatedAt: string;
  online: boolean;
  downloads: { count: number; totalSize: string };
  uploads: { count: number; totalSize: string };
};

export type AddFriendParams = {
  name: string;
  address: string;
  port: number;
  password?: string;
};

export async function getFriends(): Promise<Friend[]> {
  const res = await fetch(apiUrl('/api/friends'));
  if (!res.ok) throw new Error('Failed to load friends');
  return res.json();
}

export async function addFriend(params: AddFriendParams): Promise<Friend> {
  const res = await fetch(apiUrl('/api/friends'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to add friend');
  }
  return res.json();
}

export async function acceptFriend(id: string): Promise<Friend> {
  const res = await fetch(apiUrl(`/api/friends/${id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'accept' }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to accept friend request');
  }
  return res.json();
}

export async function rejectFriend(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/friends/${id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reject' }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to reject friend request');
  }
}

export async function removeFriend(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/friends/${id}`), { method: 'DELETE' });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to remove friend');
  }
}

export type Stats = {
  sharedFiles: { count: number; totalSize: string };
  friends: { total: number; online: number };
  downloads: { count: number; totalSize: string };
};

export async function getStats(): Promise<Stats> {
  const res = await fetch(apiUrl('/api/stats'));
  if (!res.ok) throw new Error('Failed to load stats');
  return res.json();
}

export type TransferState =
  | 'PENDING'
  | 'DOWNLOADING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type Transfer = {
  id: string;
  sha256: string;
  filename: string;
  size: string;
  mimeType: string | null;
  state: TransferState;
  bytesReceived: string;
  progress: number;
  speedBps: number;
  etaSeconds: number | null;
  sources: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export async function getTransfers(): Promise<Transfer[]> {
  const res = await fetch(apiUrl('/api/transfers'));
  if (!res.ok) throw new Error('Failed to load transfers');
  return res.json();
}

export async function startDownload(params: {
  sha256: string;
  filename: string;
  size: string;
  mimeType?: string | null;
  sources: string[];
}): Promise<{ id: string }> {
  const res = await fetch(apiUrl('/api/transfers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to start download');
  }
  return res.json();
}

export async function controlTransfer(
  id: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<void> {
  const res = await fetch(apiUrl(`/api/transfers/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || `Failed to ${action} transfer`);
  }
}

export type Upload = {
  id: string;
  sha256: string;
  filename: string;
  size: string;
  peerNodeId: string;
  bytesServed: string;
  speedBps: number;
};

export async function getUploads(): Promise<Upload[]> {
  const res = await fetch(apiUrl('/api/uploads'));
  if (!res.ok) throw new Error('Failed to load uploads');
  return res.json();
}

export async function dismissTransfer(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/transfers/${id}`), { method: 'DELETE' });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to dismiss transfer');
  }
}

export type PostDownloadScript = {
  id: string;
  path: string;
  order: number;
  createdAt: string;
};

export async function getScripts(): Promise<PostDownloadScript[]> {
  const res = await fetch(apiUrl('/api/scripts'));
  if (!res.ok) throw new Error('Failed to load scripts');
  return res.json();
}

export async function addScript(path: string): Promise<PostDownloadScript> {
  const res = await fetch(apiUrl('/api/scripts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to add script');
  }
  return res.json();
}

export async function reorderScript(
  id: string,
  direction: 'up' | 'down',
): Promise<PostDownloadScript[]> {
  const res = await fetch(apiUrl(`/api/scripts/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to reorder script');
  }
  if (res.status === 204) return getScripts();
  return res.json();
}

export async function removeScript(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/scripts/${id}`), { method: 'DELETE' });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to remove script');
  }
}

export type FsEntry = { name: string; path: string };

export type FsListing = {
  path: string;
  parent: string | null;
  home: string; // always present — the server falls back to homedir()
  entries: FsEntry[];
};

export async function listDirectory(path?: string, signal?: AbortSignal): Promise<FsListing> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await fetch(apiUrl(`/api/fs${qs}`), { signal });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Cannot read directory');
  }
  return res.json();
}

export async function triggerRescan(): Promise<{ indexed: number; removed: number }> {
  const res = await fetch(apiUrl('/api/rescan'), { method: 'POST' });
  if (!res.ok) throw new Error('Rescan failed');
  return res.json();
}

export type FileType = 'all' | 'audio' | 'video' | 'image' | 'document' | 'ebook';

export type LocalFile = {
  id: string;
  filename: string;
  size: string;
  sha256: string;
  mimeType: string | null;
  metadata: string | null;
  fileModifiedAt: string | null;
  indexedAt: string;
};

export type NetworkFile = {
  filename: string;
  size: string;
  sha256: string;
  mimeType: string | null;
  metadata: string | null;
  nodeId: string;
  viaNodeId?: string;
};

export type SearchResponse = {
  files: LocalFile[];
  total: number;
  network?: NetworkFile[];
};

export type SearchParams = {
  q: string;
  type?: FileType;
  limit?: number;
  offset?: number;
  network?: boolean;
};

// ── Chat ──────────────────────────────────────────────────────────────────────

export type ConvType = 'DM' | 'GROUP';

export type Message = {
  id: string;
  conversationId: string;
  fromNodeId: string;
  body: string;
  sentAt: string;
};

export type Conversation = {
  id: string;
  type: ConvType;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
};

export async function getConversations(): Promise<Conversation[]> {
  const res = await fetch(apiUrl('/api/conversations'));
  if (!res.ok) throw new Error('Failed to load conversations');
  return res.json();
}

export async function openDmConversation(peerNodeId: string): Promise<Conversation> {
  const res = await fetch(apiUrl('/api/conversations'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerNodeId }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to open DM');
  }
  return res.json();
}

export async function createGroupConversation(name: string): Promise<Conversation> {
  const res = await fetch(apiUrl('/api/conversations'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to create group');
  }
  return res.json();
}

export async function getMessages(
  convId: string,
  opts?: { limit?: number; before?: string },
): Promise<Message[]> {
  const qs = new URLSearchParams();
  if (opts?.limit != null) qs.set('limit', String(opts.limit));
  if (opts?.before) qs.set('before', opts.before);
  const res = await fetch(apiUrl(`/api/conversations/${convId}/messages?${qs}`));
  if (!res.ok) throw new Error('Failed to load messages');
  return res.json();
}

export async function sendMessage(convId: string, body: string): Promise<Message> {
  const res = await fetch(apiUrl(`/api/conversations/${convId}/messages`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to send message');
  }
  return res.json();
}

export async function deleteConversation(convId: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/conversations/${convId}`), {
    method: 'DELETE',
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to delete conversation');
  }
}

export async function searchFiles(
  params: SearchParams,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.type && params.type !== 'all') qs.set('type', params.type);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  if (params.network) qs.set('network', 'true');
  const res = await fetch(apiUrl(`/api/search?${qs}`), { signal });
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}
```

- [ ] **Step 4: Run the existing Playwright suite to confirm it's still green**

Run: `bun run test:e2e`
Expected: PASS — all 54 existing tests, unchanged. This is the regression check for this task: every one of `app/lib/api.ts`'s functions is already exercised by the UI flows these tests drive, with `/api/*` mocked via `page.route()`.

- [ ] **Step 5: Commit**

```bash
git add app/lib/api.ts playwright.config.ts .env.development
git commit -m "feat(web): configurable API base URL, keep e2e mocks same-origin"
```

---

### Task 7: Docker — serve the export, simplify the entrypoint

**Files:**

- Modify: `Dockerfile`
- Modify: `docker-entrypoint.sh`

**Interfaces:** none — consumes nothing from earlier tasks beyond "the app now builds to `out/` and runs as one process", both already true after Tasks 4–5.

- [ ] **Step 1: Modify `Dockerfile`**

```dockerfile
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM oven/bun:1
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/out ./out
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/server ./server
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /app/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# UI + management API
EXPOSE 3000
# P2P WebSocket (matches Settings.listenPort default)
EXPOSE 7734

ENV PORT=3000
ENV DATABASE_URL=file:./data/filenet.db

ENTRYPOINT ["docker-entrypoint.sh"]
```

`public/` is no longer copied separately — Next's static export already copies its contents into `out/` at build time. `MGMT_PORT`/its `EXPOSE` are gone — there is no second port anymore.

- [ ] **Step 2: Modify `docker-entrypoint.sh`**

```sh
#!/bin/sh
set -e

# One process now serves the UI, the management API, and the P2P protocol —
# no backgrounding/signal-forwarding dance needed for a second process.
exec bun server/index.ts
```

- [ ] **Step 3: Manually verify the image builds and runs**

Run:

```bash
docker build -t filenet-test .
docker run --rm -d --name filenet-test -p 3000:3000 -p 7734:7734 filenet-test
sleep 2
curl -s http://localhost:3000/          # expect HTML (the exported index page)
curl -s http://localhost:3000/api/me    # expect {"nodeId":"..."}
curl -s http://localhost:7734/health    # expect {"status":"ok","nodeId":"..."}
docker stop filenet-test
```

Expected: all three curls succeed with the responses noted above.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-entrypoint.sh
git commit -m "fix(docker): serve static export, collapse to a single process"
```

---

### Task 8: Compile-and-package script for the five binary targets

**Files:**

- Create: `scripts/build-binaries.sh`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**

- Produces: `bun run build:binaries` — compiles all five targets and writes `dist/filenet-<target>.tar.gz` (or `.zip` for Windows), each containing the executable, `out/`, and `drizzle/migrations/`.

- [ ] **Step 1: Create `scripts/build-binaries.sh`**

```bash
#!/bin/bash
set -euo pipefail

TARGETS=(bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64 bun-windows-x64)

rm -rf dist
bun run build

for target in "${TARGETS[@]}"; do
  outdir="dist/${target}"
  mkdir -p "$outdir"

  binary_name="filenet"
  if [[ "$target" == *windows* ]]; then
    binary_name="filenet.exe"
  fi

  echo "Compiling ${target}..."
  bun build --compile --target="$target" --outfile "${outdir}/${binary_name}" server/index.ts

  cp -r out "${outdir}/out"
  mkdir -p "${outdir}/drizzle"
  cp -r drizzle/migrations "${outdir}/drizzle/migrations"

  if [[ "$target" == *windows* ]]; then
    (cd dist && zip -r "filenet-${target}.zip" "${target}")
  else
    tar -czf "dist/filenet-${target}.tar.gz" -C dist "${target}"
  fi

  echo "Packaged dist/filenet-${target}.*"
done
```

- [ ] **Step 2: Make it executable and add the `package.json` script**

```bash
chmod +x scripts/build-binaries.sh
```

```json
{
  "scripts": {
    "build:binaries": "bash scripts/build-binaries.sh"
  }
}
```

(Add this key alongside the existing scripts — leave every other script untouched.)

- [ ] **Step 3: Add `dist/` to `.gitignore`**

```
# compiled single-binary releases
dist/
```

(Append to the existing `# production` section, next to `build/`.)

- [ ] **Step 4: Compile the host platform target and run it standalone**

Run (adjust the target name to match your machine, e.g. `bun-darwin-arm64` on Apple Silicon):

```bash
bun run build:binaries
cd dist/bun-darwin-arm64
DATABASE_URL=file:./manual-verify.db P2P_PORT=7734 PORT=3000 ./filenet &
sleep 1
curl -s http://localhost:3000/
curl -s http://localhost:3000/api/me
curl -s http://localhost:7734/health
kill %1
rm -f manual-verify.db manual-verify.db-shm manual-verify.db-wal
cd ../..
```

Expected: the root `/` request returns the exported `index.html`, `/api/me` returns `{"nodeId":"..."}`, `/health` returns `{"status":"ok",...}` — all from a single compiled executable with no `bun`/`node`/`npm` install required to run it, confirming `resolveAssetPath`'s compiled-binary fallback (Task 1) resolves `out/` and `drizzle/migrations/` correctly relative to the executable.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-binaries.sh package.json .gitignore
git commit -m "feat(build): add bun build --compile packaging for 5 platform targets"
```

---

### Task 9: End-to-end browser verification + docs

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `TODO.md`

**Interfaces:** none — this is the final verification + documentation pass tying Tasks 1–8 together.

- [ ] **Step 1: Full manual browser verification of the static export + unified server**

```bash
bun run build
DATABASE_URL=file:./data/manual-verify.db P2P_PORT=7734 PORT=3000 bun server/index.ts
```

In a browser, visit `http://localhost:3000/`. Confirm:

- The setup wizard (or Home if already configured) loads with no console errors.
- Settings loads and a save round-trips (Settings → change name → Save → reload → name persisted).
- Search runs a local search and returns results (or an empty state) without a network error.

Stop the server (Ctrl-C) and remove the scratch DB: `rm -f data/manual-verify.db data/manual-verify.db-shm data/manual-verify.db-wal`.

- [ ] **Step 2: Update `README.md`**

Add a new "Running as a standalone executable" section (placed alongside the existing Docker instructions), e.g.:

````markdown
## Running as a standalone executable

If you don't want to run Docker, Filenet also ships as a standalone
executable with no external runtime dependency — no separate Node/Bun/npm
install required.

1. Download `filenet-<platform>.tar.gz` (or `.zip` for Windows) from the
   Releases page for your platform (`linux-x64`, `linux-arm64`,
   `darwin-x64`, `darwin-arm64`, `windows-x64`).
2. Extract it — you'll get `filenet` (the executable), an `out/` folder
   (the UI), and a `drizzle/migrations/` folder. Keep these three together.
3. Run the executable from that folder:

   ```bash
   ./filenet
   ```
````

4. Open `http://localhost:3000` in a browser to finish setup.

Configuration is via environment variables, same as Docker:
`PORT` (UI + management API, default `3000`), `P2P_PORT` (default: the
listening port configured in Settings), `DATABASE_URL` (default:
`./data/filenet.db`, relative to wherever you run the executable from).

To build these yourself: `bun run build:binaries` (requires Bun installed).

````

- [ ] **Step 3: Update `CHANGELOG.md`**

Add under `## [Unreleased]` → `### Added` (as the first/most recent entry):

```markdown
- **Single-binary distribution** — the app now builds and runs as a standalone executable via `bun build --compile`, with no external Node/Bun/npm dependency required at runtime
  - Next.js switched to `output: 'export'`; the UI is now static files served directly by the Bun server
  - The management API (`/api/*`) is now handled in-process by the same server that serves the UI, instead of a separate `127.0.0.1:7735` process — removes the `MGMT_PORT` env var entirely
  - `bun run build:binaries` compiles and packages all five targets (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`) as `dist/filenet-<target>.tar.gz`/`.zip`, each containing the executable alongside its `out/` and `drizzle/migrations/` folders
  - Docker continues to run from source, now serving the static export instead of a Next.js server; `docker-entrypoint.sh` simplified to a single process
````

- [ ] **Step 4: Update `TODO.md`**

Check off the single-binary item and refresh the stale catch-all-proxy line to reflect the new architecture:

```diff
- - [ ] Single-binary distribution (à la Sonarr/Radarr) — now that Prisma is gone, only one blocker remains: switch Next.js to `output: 'export'` so the frontend becomes static files the Bun server can serve directly. Once done, `bun build --compile` produces a single platform executable with no external dependencies. Cross-compile targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`.
+ - [x] Single-binary distribution (à la Sonarr/Radarr) — Next.js builds via `output: 'export'`; `bun build --compile` packages the app + `out/` + `drizzle/migrations/` for all 5 targets via `bun run build:binaries`
```

```diff
- - [x] Next.js catch-all proxy (`/api/[...path]`) forwarding UI requests to P2P server
+ - [x] Management API served in-process by the unified UI server (`server/ui-server.ts`) — replaced the earlier Next.js catch-all proxy now that the UI is a static export
```

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md TODO.md
git commit -m "docs: document single-binary distribution"
```

---

## Self-Review Notes

- **Spec coverage:** every section of the design spec maps to a task — architecture (3, 4), security note / port separation (4, 7 — UI and P2P ports never merge), frontend changes (5, 6), server changes (1–4), Docker (7), packaging (8), testing/verification (woven through every task + 9), scope boundary (Global Constraints — CI/release automation and auth explicitly excluded, no task implements them).
- **Type consistency checked:** `UiServerDeps = ManagementDeps & { outDir, devOrigin?, isDev? }` (Task 3) is exactly what Task 4 constructs (`createUiServer({ identity, db, connectPeer: connectPeerFn, outDir: resolveAssetPath(...) })`); `resolveAssetPath(repoRootRelativePath, callerDir, execPath?)` (Task 1) is called identically in Task 2 (`'drizzle/migrations'`) and Task 4 (`'out'`).
- **No placeholders:** every step has complete, runnable code; no "similar to Task N" shorthand — Task 6 repeats the full `app/lib/api.ts` file rather than describing the transform, since the engineer may work the tasks out of order.
