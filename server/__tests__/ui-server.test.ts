import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { basename, join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { type Db, applyMigrations, createDb } from '../db';
import { createUiServer, resolveStaticFile } from '../ui-server';
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

  it('rejects a raw pathname that would escape outDir via traversal', async () => {
    // The browser-facing handler never sees an unnormalized `..` in
    // practice (new URL() strips it before url.pathname is built), but
    // resolveStaticFile is exercised directly here with a raw string to
    // prove its own boundary check independently, in case some other
    // future caller passes an unnormalized path.
    const secretDir = await mkdtemp(join(tmpdir(), 'filenet-secret-'));
    await writeFile(join(secretDir, 'secret.txt'), 'top secret');
    const traversal = `/../${basename(secretDir)}/secret.txt`;

    expect(resolveStaticFile(outDir, traversal)).toBeNull();

    await rm(secretDir, { recursive: true, force: true });
  });
});
