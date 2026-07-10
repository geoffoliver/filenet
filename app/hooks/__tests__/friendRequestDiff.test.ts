import { describe, expect, test } from 'bun:test';

import { getNewlyPendingIds, pruneStaleIds } from '../friendRequestDiff';

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

describe('pruneStaleIds', () => {
  test('removes notified ids that are no longer pending', () => {
    expect(pruneStaleIds(new Set(['a', 'b']), ['b'])).toEqual(new Set(['b']));
  });

  test('keeps notified ids that are still pending', () => {
    expect(pruneStaleIds(new Set(['a', 'b']), ['a', 'b'])).toEqual(new Set(['a', 'b']));
  });

  test('returns an empty set when nothing is pending anymore', () => {
    expect(pruneStaleIds(new Set(['a', 'b']), [])).toEqual(new Set());
  });

  test('returns an empty set unchanged when there was nothing notified', () => {
    expect(pruneStaleIds(new Set(), ['a'])).toEqual(new Set());
  });

  test('so a friend re-entering the pending state with the same id is treated as new again', () => {
    const notifiedIds = pruneStaleIds(new Set(['carol']), []); // Carol got accepted/declined
    expect(getNewlyPendingIds(['carol'], notifiedIds)).toEqual(['carol']); // Carol re-requests
  });
});
