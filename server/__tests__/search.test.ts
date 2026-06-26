import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import { searchFiles } from '../search';
import { sharedFiles } from '../schema';

const TEST_DB_URL = 'file:./data/test-search.db';
let db: Db;

const now = new Date();

function makeFile(overrides: Partial<typeof sharedFiles.$inferInsert>) {
  return {
    id: randomUUID(),
    path: `/test/${randomUUID()}`,
    filename: 'file.txt',
    size: 100n,
    sha256: 'a'.repeat(64),
    mimeType: 'text/plain',
    metadata: null,
    fileModifiedAt: null,
    lastSeenAt: now,
    indexedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const FIXTURES = [
  makeFile({
    path: '/music/hey_jude.mp3',
    filename: 'hey_jude.mp3',
    size: 5000n,
    sha256: 'a'.repeat(64),
    mimeType: 'audio/mpeg',
    metadata: JSON.stringify({ title: 'Hey Jude', artist: 'The Beatles', album: 'Let It Be' }),
  }),
  makeFile({
    path: '/music/bohemian.flac',
    filename: 'bohemian.flac',
    size: 8000n,
    sha256: 'b'.repeat(64),
    mimeType: 'audio/flac',
  }),
  makeFile({
    path: '/videos/movie.mp4',
    filename: 'movie.mp4',
    size: 100000n,
    sha256: 'c'.repeat(64),
    mimeType: 'video/mp4',
  }),
  makeFile({
    path: '/docs/readme.txt',
    filename: 'readme.txt',
    size: 500n,
    sha256: 'd'.repeat(64),
    mimeType: 'text/plain',
  }),
  makeFile({
    path: '/docs/report.pdf',
    filename: 'report.pdf',
    size: 2000n,
    sha256: 'e'.repeat(64),
    mimeType: 'application/pdf',
  }),
  makeFile({
    path: '/images/photo.jpg',
    filename: 'photo.jpg',
    size: 300n,
    sha256: 'f'.repeat(64),
    mimeType: 'image/jpeg',
  }),
  makeFile({
    path: '/ebooks/novel.epub',
    filename: 'novel.epub',
    size: 1500n,
    sha256: 'g'.repeat(64),
    mimeType: 'application/epub+zip',
  }),
];

beforeAll(() => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
});

afterAll(() => {
  db.$client.close();
  try {
    unlinkSync('./data/test-search.db');
  } catch {}
});

beforeEach(() => {
  db.delete(sharedFiles).run();
  db.insert(sharedFiles).values(FIXTURES).run();
});

describe('searchFiles — query matching', () => {
  it('returns all files when query is empty', async () => {
    const result = await searchFiles(db, { query: '' });
    expect(result.total).toBe(7);
    expect(result.files).toHaveLength(7);
  });

  it('returns all files when query is whitespace only', async () => {
    const result = await searchFiles(db, { query: '   ' });
    expect(result.total).toBe(7);
  });

  it('matches filename substring', async () => {
    const result = await searchFiles(db, { query: 'jude' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('hey_jude.mp3');
  });

  it('is case-insensitive for filename match', async () => {
    const result = await searchFiles(db, { query: 'JUDE' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('hey_jude.mp3');
  });

  it('matches against metadata JSON content', async () => {
    const result = await searchFiles(db, { query: 'Beatles' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('hey_jude.mp3');
  });

  it('matches path directory components', async () => {
    const result = await searchFiles(db, { query: 'videos' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('movie.mp4');
  });

  it('returns empty results when no files match', async () => {
    const result = await searchFiles(db, { query: 'zzznomatch' });
    expect(result.total).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  it('returns files ordered by filename ascending', async () => {
    const result = await searchFiles(db, { query: '' });
    const filenames = result.files.map((f) => f.filename);
    expect(filenames).toEqual([...filenames].sort());
  });
});

describe('searchFiles — type filter', () => {
  it('filters to audio files', async () => {
    const result = await searchFiles(db, { query: '', type: 'audio' });
    expect(result.total).toBe(2);
    expect(result.files.every((f) => f.mimeType?.startsWith('audio/'))).toBe(true);
  });

  it('filters to video files', async () => {
    const result = await searchFiles(db, { query: '', type: 'video' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('movie.mp4');
  });

  it('filters to image files', async () => {
    const result = await searchFiles(db, { query: '', type: 'image' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('photo.jpg');
  });

  it('filters to document files (pdf and text)', async () => {
    const result = await searchFiles(db, { query: '', type: 'document' });
    expect(result.total).toBe(2);
    const filenames = result.files.map((f) => f.filename).sort();
    expect(filenames).toEqual(['readme.txt', 'report.pdf']);
  });

  it('filters to ebook files', async () => {
    const result = await searchFiles(db, { query: '', type: 'ebook' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('novel.epub');
  });

  it('"all" type returns everything', async () => {
    const result = await searchFiles(db, { query: '', type: 'all' });
    expect(result.total).toBe(7);
  });
});

describe('searchFiles — combined filters', () => {
  it('combines query and type filter', async () => {
    const result = await searchFiles(db, { query: 'jude', type: 'audio' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('hey_jude.mp3');
  });

  it('returns empty when query matches but type does not', async () => {
    const result = await searchFiles(db, { query: 'jude', type: 'video' });
    expect(result.total).toBe(0);
  });
});

describe('searchFiles — pagination', () => {
  it('respects limit', async () => {
    const result = await searchFiles(db, { query: '', limit: 3 });
    expect(result.files).toHaveLength(3);
    expect(result.total).toBe(7);
  });

  it('respects offset', async () => {
    const all = await searchFiles(db, { query: '' });
    const paged = await searchFiles(db, { query: '', limit: 3, offset: 3 });
    expect(paged.files[0].id).toBe(all.files[3].id);
  });

  it('returns empty files array when offset exceeds total', async () => {
    const result = await searchFiles(db, { query: '', offset: 100 });
    expect(result.files).toHaveLength(0);
    expect(result.total).toBe(7);
  });

  it('defaults to limit 50 and offset 0', async () => {
    const result = await searchFiles(db, { query: '' });
    expect(result.files).toHaveLength(7);
  });
});

describe('searchFiles — stable sort', () => {
  beforeEach(() => {
    db.delete(sharedFiles).run();
    db.insert(sharedFiles)
      .values([
        makeFile({
          path: '/a/dup.txt',
          filename: 'dup.txt',
          size: 100n,
          sha256: 'x'.repeat(64),
          mimeType: 'text/plain',
        }),
        makeFile({
          path: '/b/dup.txt',
          filename: 'dup.txt',
          size: 200n,
          sha256: 'y'.repeat(64),
          mimeType: 'text/plain',
        }),
      ])
      .run();
  });

  it('returns consistent pages when filenames collide', async () => {
    const page1 = await searchFiles(db, { query: '', limit: 1, offset: 0 });
    const page2 = await searchFiles(db, { query: '', limit: 1, offset: 1 });
    expect(page1.total).toBe(2);
    expect(page2.total).toBe(2);
    expect(page1.files[0].id).not.toBe(page2.files[0].id);
    const ids = new Set([page1.files[0].id, page2.files[0].id]);
    expect(ids.size).toBe(2);
  });
});
