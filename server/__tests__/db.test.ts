import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDb } from '../db';

describe('createDb', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('creates missing parent directories for the database path', () => {
    const root = mkdtempSync(join(tmpdir(), 'filenet-db-'));
    tmpDirs.push(root);
    const dbPath = join(root, 'nested', 'deep', 'filenet.db');

    const db = createDb(dbPath);
    db.$client.close();

    expect(existsSync(dbPath)).toBe(true);
  });
});
