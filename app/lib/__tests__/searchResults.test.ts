import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_SORT,
  type SearchHit,
  defaultDirectionFor,
  detailColumnValue,
  directSources,
  formatDuration,
  mergeResults,
  mimeIcon,
  parseMeta,
  sortHits,
  sourceCount,
} from '../searchResults';
import type { LocalFile, NetworkFile } from '../api';

function networkFile(overrides: Partial<NetworkFile> = {}): NetworkFile {
  return {
    filename: 'song.mp3',
    size: '1000',
    sha256: 'a'.repeat(64),
    mimeType: 'audio/mpeg',
    metadata: null,
    nodeId: 'node-a',
    ...overrides,
  };
}

function localFile(overrides: Partial<LocalFile> = {}): LocalFile {
  return {
    id: 'local-1',
    filename: 'song.mp3',
    size: '1000',
    sha256: 'a'.repeat(64),
    mimeType: 'audio/mpeg',
    metadata: null,
    fileModifiedAt: null,
    indexedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    sha256: 'a'.repeat(64),
    filename: 'song.mp3',
    size: '1000',
    mimeType: 'audio/mpeg',
    metadata: null,
    local: false,
    networkSources: [],
    ...overrides,
  };
}

describe('mergeResults', () => {
  test('merges a local file and a network file with the same sha256 into one hit', () => {
    const local = [localFile()];
    const network = [networkFile({ nodeId: 'node-b' })];
    const merged = mergeResults(local, network);
    expect(merged).toHaveLength(1);
    expect(merged[0].local).toBe(true);
    expect(merged[0].networkSources).toHaveLength(1);
  });

  test('keeps a network-only file as non-local', () => {
    const merged = mergeResults([], [networkFile({ sha256: 'b'.repeat(64) })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].local).toBe(false);
  });
});

describe('parseMeta', () => {
  test('returns null for null input', () => {
    expect(parseMeta(null)).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(parseMeta('{not json')).toBeNull();
  });

  test('parses valid JSON', () => {
    expect(parseMeta('{"artist":"Test"}')).toEqual({ artist: 'Test' });
  });
});

describe('formatDuration', () => {
  test('formats under an hour as m:ss', () => {
    expect(formatDuration(210)).toBe('3:30');
  });

  test('formats an hour or more as h:mm:ss', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
  });
});

describe('mimeIcon', () => {
  test('returns a music note for audio', () => {
    expect(mimeIcon('audio/mpeg')).toBe('🎵');
  });

  test('returns a generic document icon for null', () => {
    expect(mimeIcon(null)).toBe('📄');
  });
});

describe('sourceCount', () => {
  test('counts local plus network sources', () => {
    expect(sourceCount(hit({ local: true, networkSources: [networkFile(), networkFile()] }))).toBe(
      3,
    );
  });

  test('is zero for an empty, non-local hit', () => {
    expect(sourceCount(hit({ local: false, networkSources: [] }))).toBe(0);
  });
});

describe('directSources', () => {
  test('includes a source with no viaNodeId', () => {
    const n = networkFile({ nodeId: 'node-a', viaNodeId: undefined });
    expect(directSources(hit({ networkSources: [n] }))).toEqual([n]);
  });

  test('includes a source whose viaNodeId equals its own nodeId', () => {
    const n = networkFile({ nodeId: 'node-a', viaNodeId: 'node-a' });
    expect(directSources(hit({ networkSources: [n] }))).toEqual([n]);
  });

  test('excludes a relayed-only source (viaNodeId differs from nodeId)', () => {
    const n = networkFile({ nodeId: 'node-a', viaNodeId: 'node-relay' });
    expect(directSources(hit({ networkSources: [n] }))).toEqual([]);
  });
});

describe('defaultDirectionFor', () => {
  test('defaults text columns to ascending', () => {
    expect(defaultDirectionFor('name')).toBe('asc');
    expect(defaultDirectionFor('type')).toBe('asc');
  });

  test('defaults numeric columns to descending', () => {
    expect(defaultDirectionFor('size')).toBe('desc');
    expect(defaultDirectionFor('sources')).toBe('desc');
  });
});

describe('DEFAULT_SORT', () => {
  test('is Sources, descending', () => {
    expect(DEFAULT_SORT).toEqual({ column: 'sources', direction: 'desc' });
  });
});

describe('sortHits', () => {
  const hits = [
    hit({ sha256: 'a'.repeat(64), filename: 'banana.mp3', size: '300', networkSources: [] }),
    hit({
      sha256: 'b'.repeat(64),
      filename: 'apple.mp3',
      size: '100',
      local: true,
      networkSources: [networkFile({ nodeId: 'n1' }), networkFile({ nodeId: 'n2' })],
    }),
    hit({ sha256: 'c'.repeat(64), filename: 'cherry.mp3', size: '200', networkSources: [] }),
  ];

  test('sorts by name ascending', () => {
    const sorted = sortHits(hits, 'name', 'asc');
    expect(sorted.map((h) => h.filename)).toEqual(['apple.mp3', 'banana.mp3', 'cherry.mp3']);
  });

  test('sorts by name descending', () => {
    const sorted = sortHits(hits, 'name', 'desc');
    expect(sorted.map((h) => h.filename)).toEqual(['cherry.mp3', 'banana.mp3', 'apple.mp3']);
  });

  test('sorts by size ascending', () => {
    const sorted = sortHits(hits, 'size', 'asc');
    expect(sorted.map((h) => h.size)).toEqual(['100', '200', '300']);
  });

  test('sorts by sources descending (the default)', () => {
    const sorted = sortHits(hits, 'sources', 'desc');
    expect(sorted[0].filename).toBe('apple.mp3'); // 3 sources (local + 2 network)
  });

  test('does not mutate the input array', () => {
    const copy = [...hits];
    sortHits(hits, 'name', 'asc');
    expect(hits).toEqual(copy);
  });
});

describe('detailColumnValue', () => {
  test('shows duration for audio', () => {
    const h = hit({ mimeType: 'audio/mpeg', metadata: JSON.stringify({ duration: 125 }) });
    expect(detailColumnValue(h)).toBe('2:05');
  });

  test('shows dimensions for images', () => {
    const h = hit({
      mimeType: 'image/jpeg',
      metadata: JSON.stringify({ width: 1920, height: 1080 }),
    });
    expect(detailColumnValue(h)).toBe('1920×1080');
  });

  test('shows page count for PDFs', () => {
    const h = hit({ mimeType: 'application/pdf', metadata: JSON.stringify({ pageCount: 14 }) });
    expect(detailColumnValue(h)).toBe('14 pages');
  });

  test('falls back to an em dash when there is no relevant metadata', () => {
    const h = hit({ mimeType: 'application/zip', metadata: null });
    expect(detailColumnValue(h)).toBe('—');
  });
});
