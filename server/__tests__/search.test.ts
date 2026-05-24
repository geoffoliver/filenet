import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';

import { createPrismaClient } from '../db';
import { searchFiles } from '../search';

const TEST_DB_URL = 'file:./data/test-search.db';
let prisma: PrismaClient;

beforeAll(() => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    unlinkSync('./data/test-search.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.sharedFile.deleteMany();
  await prisma.sharedFile.createMany({
    data: [
      {
        path: '/music/hey_jude.mp3',
        filename: 'hey_jude.mp3',
        size: 5000,
        sha256: 'a'.repeat(64),
        mimeType: 'audio/mpeg',
        metadata: JSON.stringify({ title: 'Hey Jude', artist: 'The Beatles', album: 'Let It Be' }),
      },
      {
        path: '/music/bohemian.flac',
        filename: 'bohemian.flac',
        size: 8000,
        sha256: 'b'.repeat(64),
        mimeType: 'audio/flac',
        metadata: null,
      },
      {
        path: '/videos/movie.mp4',
        filename: 'movie.mp4',
        size: 100000,
        sha256: 'c'.repeat(64),
        mimeType: 'video/mp4',
        metadata: null,
      },
      {
        path: '/docs/readme.txt',
        filename: 'readme.txt',
        size: 500,
        sha256: 'd'.repeat(64),
        mimeType: 'text/plain',
        metadata: null,
      },
      {
        path: '/docs/report.pdf',
        filename: 'report.pdf',
        size: 2000,
        sha256: 'e'.repeat(64),
        mimeType: 'application/pdf',
        metadata: null,
      },
      {
        path: '/images/photo.jpg',
        filename: 'photo.jpg',
        size: 300,
        sha256: 'f'.repeat(64),
        mimeType: 'image/jpeg',
        metadata: null,
      },
      {
        path: '/ebooks/novel.epub',
        filename: 'novel.epub',
        size: 1500,
        sha256: 'g'.repeat(64),
        mimeType: 'application/epub+zip',
        metadata: null,
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// query matching
// ---------------------------------------------------------------------------

describe('searchFiles — query matching', () => {
  it('returns all files when query is empty', async () => {
    const result = await searchFiles(prisma, { query: '' });
    expect(result.total).toBe(7);
    expect(result.files).toHaveLength(7);
  });

  it('returns all files when query is whitespace only', async () => {
    const result = await searchFiles(prisma, { query: '   ' });
    expect(result.total).toBe(7);
  });

  it('matches filename substring', async () => {
    const result = await searchFiles(prisma, { query: 'jude' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('hey_jude.mp3');
  });

  it('is case-insensitive for filename match', async () => {
    const result = await searchFiles(prisma, { query: 'JUDE' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('hey_jude.mp3');
  });

  it('matches against metadata JSON content', async () => {
    const result = await searchFiles(prisma, { query: 'Beatles' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('hey_jude.mp3');
  });

  it('returns empty results when no files match', async () => {
    const result = await searchFiles(prisma, { query: 'zzznomatch' });
    expect(result.total).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  it('returns files ordered by filename ascending', async () => {
    const result = await searchFiles(prisma, { query: '' });
    const filenames = result.files.map((f) => f.filename);
    expect(filenames).toEqual([...filenames].sort());
  });
});

// ---------------------------------------------------------------------------
// type filter
// ---------------------------------------------------------------------------

describe('searchFiles — type filter', () => {
  it('filters to audio files', async () => {
    const result = await searchFiles(prisma, { query: '', type: 'audio' });
    expect(result.total).toBe(2);
    expect(result.files.every((f) => f.mimeType?.startsWith('audio/'))).toBe(true);
  });

  it('filters to video files', async () => {
    const result = await searchFiles(prisma, { query: '', type: 'video' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('movie.mp4');
  });

  it('filters to image files', async () => {
    const result = await searchFiles(prisma, { query: '', type: 'image' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('photo.jpg');
  });

  it('filters to document files (pdf and text)', async () => {
    const result = await searchFiles(prisma, { query: '', type: 'document' });
    expect(result.total).toBe(2);
    const filenames = result.files.map((f) => f.filename).sort();
    expect(filenames).toEqual(['readme.txt', 'report.pdf']);
  });

  it('filters to ebook files', async () => {
    const result = await searchFiles(prisma, { query: '', type: 'ebook' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('novel.epub');
  });

  it('"all" type returns everything', async () => {
    const result = await searchFiles(prisma, { query: '', type: 'all' });
    expect(result.total).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// combined query + type filter
// ---------------------------------------------------------------------------

describe('searchFiles — combined filters', () => {
  it('combines query and type filter', async () => {
    const result = await searchFiles(prisma, { query: 'jude', type: 'audio' });
    expect(result.total).toBe(1);
    expect(result.files[0].filename).toBe('hey_jude.mp3');
  });

  it('returns empty when query matches but type does not', async () => {
    const result = await searchFiles(prisma, { query: 'jude', type: 'video' });
    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

describe('searchFiles — pagination', () => {
  it('respects limit', async () => {
    const result = await searchFiles(prisma, { query: '', limit: 3 });
    expect(result.files).toHaveLength(3);
    expect(result.total).toBe(7);
  });

  it('respects offset', async () => {
    const all = await searchFiles(prisma, { query: '' });
    const paged = await searchFiles(prisma, { query: '', limit: 3, offset: 3 });
    expect(paged.files[0].id).toBe(all.files[3].id);
  });

  it('returns empty files array when offset exceeds total', async () => {
    const result = await searchFiles(prisma, { query: '', offset: 100 });
    expect(result.files).toHaveLength(0);
    expect(result.total).toBe(7);
  });

  it('defaults to limit 50 and offset 0', async () => {
    const result = await searchFiles(prisma, { query: '' });
    expect(result.files).toHaveLength(7);
  });
});
