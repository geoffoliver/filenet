import { describe, expect, test } from 'bun:test';

import { shouldNotifyForUpdate } from '../updateNotificationDiff';

describe('shouldNotifyForUpdate', () => {
  test('returns the version when ready and not yet notified', () => {
    expect(shouldNotifyForUpdate('ready', '0.2.0', new Set())).toBe('0.2.0');
  });

  test('returns null when already notified for this version', () => {
    expect(shouldNotifyForUpdate('ready', '0.2.0', new Set(['0.2.0']))).toBeNull();
  });

  test('returns null when not ready yet', () => {
    expect(shouldNotifyForUpdate('downloading', '0.2.0', new Set())).toBeNull();
    expect(shouldNotifyForUpdate('available', '0.2.0', new Set())).toBeNull();
    expect(shouldNotifyForUpdate('idle', null, new Set())).toBeNull();
  });

  test('returns null when ready but latestVersion is missing', () => {
    expect(shouldNotifyForUpdate('ready', null, new Set())).toBeNull();
  });

  test('notifies again if a newer version becomes ready after an earlier one was notified', () => {
    expect(shouldNotifyForUpdate('ready', '0.3.0', new Set(['0.2.0']))).toBe('0.3.0');
  });
});
