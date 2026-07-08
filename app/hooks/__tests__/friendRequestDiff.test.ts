import { describe, expect, test } from 'bun:test';

import { getNewlyPendingIds } from '../friendRequestDiff';

describe('getNewlyPendingIds', () => {
  test('returns all pending ids when none have been notified yet', () => {
    expect(getNewlyPendingIds(['a', 'b'], new Set())).toEqual(['a', 'b']);
  });

  test('excludes ids that have already been notified', () => {
    expect(getNewlyPendingIds(['a', 'b'], new Set(['a']))).toEqual(['b']);
  });

  test('returns an empty array when all pending ids have already been notified', () => {
    expect(getNewlyPendingIds(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
  });

  test('returns an empty array when there are no pending ids', () => {
    expect(getNewlyPendingIds([], new Set(['a']))).toEqual([]);
  });

  test('ignores notified ids that are no longer pending (e.g. accepted or declined since)', () => {
    expect(getNewlyPendingIds(['b'], new Set(['a', 'b']))).toEqual([]);
  });
});
