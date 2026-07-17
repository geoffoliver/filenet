import { describe, expect, it } from 'bun:test';

import {
  AddFriendBodySchema,
  ChatMessageSchema,
  ChunkRequestMessageSchema,
  FriendActionBodySchema,
  FriendRequestMessageSchema,
  FriendResponseMessageSchema,
  PatchSettingsBodySchema,
  SearchQuerySchema,
  SearchRequestMessageSchema,
  SearchResultItemSchema,
  SearchResultMessageSchema,
} from '../schemas';

describe('AddFriendBodySchema', () => {
  it('accepts a valid friend body', () => {
    const r = AddFriendBodySchema.safeParse({ name: 'Bob', address: '10.0.0.1', port: 8080 });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.name).toBe('Bob');
    expect(r.data.port).toBe(8080);
  });

  it('defaults port to 7734 when omitted', () => {
    const r = AddFriendBodySchema.safeParse({ name: 'Bob', address: '10.0.0.1' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.port).toBe(7734);
  });

  it('trims whitespace from name and address', () => {
    const r = AddFriendBodySchema.safeParse({ name: '  Bob  ', address: '  10.0.0.1  ' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.name).toBe('Bob');
    expect(r.data.address).toBe('10.0.0.1');
  });

  it('rejects whitespace-only name', () => {
    const r = AddFriendBodySchema.safeParse({ name: '   ', address: '10.0.0.1' });
    expect(r.success).toBe(false);
  });

  it('rejects non-string name', () => {
    const r = AddFriendBodySchema.safeParse({ name: 123, address: '10.0.0.1' });
    expect(r.success).toBe(false);
  });

  it('rejects non-integer port', () => {
    const r = AddFriendBodySchema.safeParse({ name: 'Bob', address: '10.0.0.1', port: 3.14 });
    expect(r.success).toBe(false);
  });

  it('rejects port out of range', () => {
    expect(
      AddFriendBodySchema.safeParse({ name: 'Bob', address: '10.0.0.1', port: 0 }).success,
    ).toBe(false);
    expect(
      AddFriendBodySchema.safeParse({ name: 'Bob', address: '10.0.0.1', port: 65536 }).success,
    ).toBe(false);
  });

  it('rejects non-object body', () => {
    expect(AddFriendBodySchema.safeParse(null).success).toBe(false);
    expect(AddFriendBodySchema.safeParse([]).success).toBe(false);
    expect(AddFriendBodySchema.safeParse('string').success).toBe(false);
  });

  it('rejects non-string password', () => {
    const r = AddFriendBodySchema.safeParse({ name: 'Bob', address: '10.0.0.1', password: 123 });
    expect(r.success).toBe(false);
  });

  it('trims and accepts a valid password', () => {
    const r = AddFriendBodySchema.safeParse({
      name: 'Bob',
      address: '10.0.0.1',
      password: '  secret  ',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.password).toBe('secret');
  });

  it('rejects a whitespace-only password with an API-facing message', () => {
    const r = AddFriendBodySchema.safeParse({
      name: 'Bob',
      address: '10.0.0.1',
      password: '   ',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe('password must be a non-empty string');
  });

  it('rejects a password longer than 200 characters with an API-facing message', () => {
    const r = AddFriendBodySchema.safeParse({
      name: 'Bob',
      address: '10.0.0.1',
      password: 'x'.repeat(201),
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues[0].message).toBe('password must be at most 200 characters');
  });

  it('accepts a password at exactly 200 characters', () => {
    const r = AddFriendBodySchema.safeParse({
      name: 'Bob',
      address: '10.0.0.1',
      password: 'x'.repeat(200),
    });
    expect(r.success).toBe(true);
  });
});

describe('FriendActionBodySchema', () => {
  it('accepts accept', () => {
    const r = FriendActionBodySchema.safeParse({ action: 'accept' });
    expect(r.success).toBe(true);
  });

  it('accepts reject', () => {
    const r = FriendActionBodySchema.safeParse({ action: 'reject' });
    expect(r.success).toBe(true);
  });

  it('rejects unknown action', () => {
    expect(FriendActionBodySchema.safeParse({ action: 'delete' }).success).toBe(false);
  });

  it('rejects missing action', () => {
    expect(FriendActionBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects non-object body', () => {
    expect(FriendActionBodySchema.safeParse(null).success).toBe(false);
  });
});

describe('PatchSettingsBodySchema', () => {
  it('accepts valid partial settings', () => {
    const r = PatchSettingsBodySchema.safeParse({ autoAcceptFromAnyone: true, name: 'Node' });
    expect(r.success).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(PatchSettingsBodySchema.safeParse({}).success).toBe(true);
  });

  it('accepts null for invitePassword', () => {
    const r = PatchSettingsBodySchema.safeParse({ invitePassword: null });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.invitePassword).toBeNull();
  });

  it('rejects unknown keys', () => {
    const r = PatchSettingsBodySchema.safeParse({ autoAcceptFromAnyone: true, foo: 'bar' });
    expect(r.success).toBe(false);
  });

  it('rejects wrong type for autoAcceptFromAnyone', () => {
    expect(PatchSettingsBodySchema.safeParse({ autoAcceptFromAnyone: 'yes' }).success).toBe(false);
  });

  it('accepts autoOpenBrowser', () => {
    const r = PatchSettingsBodySchema.safeParse({ autoOpenBrowser: false });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.autoOpenBrowser).toBe(false);
  });

  it('rejects wrong type for autoOpenBrowser', () => {
    expect(PatchSettingsBodySchema.safeParse({ autoOpenBrowser: 'yes' }).success).toBe(false);
  });

  it('rejects wrong type for invitePassword', () => {
    expect(PatchSettingsBodySchema.safeParse({ invitePassword: 123 }).success).toBe(false);
  });

  it('rejects non-object body', () => {
    expect(PatchSettingsBodySchema.safeParse(null).success).toBe(false);
    expect(PatchSettingsBodySchema.safeParse([]).success).toBe(false);
  });

  it('trims whitespace from name', () => {
    const r = PatchSettingsBodySchema.safeParse({ name: '  My Node  ' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.name).toBe('My Node');
  });

  it('rejects name longer than 200 characters', () => {
    expect(PatchSettingsBodySchema.safeParse({ name: 'a'.repeat(201) }).success).toBe(false);
  });

  it('accepts name at exactly 200 characters', () => {
    expect(PatchSettingsBodySchema.safeParse({ name: 'a'.repeat(200) }).success).toBe(true);
  });

  it('accepts a valid sharedFolders array', () => {
    const r = PatchSettingsBodySchema.safeParse({ sharedFolders: ['/music', '/videos'] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.sharedFolders).toEqual(['/music', '/videos']);
  });

  it('accepts an empty sharedFolders array', () => {
    expect(PatchSettingsBodySchema.safeParse({ sharedFolders: [] }).success).toBe(true);
  });

  it('rejects sharedFolders with empty string elements', () => {
    expect(PatchSettingsBodySchema.safeParse({ sharedFolders: [''] }).success).toBe(false);
  });

  it('rejects sharedFolders with whitespace-only elements', () => {
    expect(PatchSettingsBodySchema.safeParse({ sharedFolders: ['   '] }).success).toBe(false);
  });

  it('trims whitespace from sharedFolders elements', () => {
    const r = PatchSettingsBodySchema.safeParse({ sharedFolders: ['  /music  ', '/videos'] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.sharedFolders).toEqual(['/music', '/videos']);
  });

  it('rejects non-array sharedFolders', () => {
    expect(PatchSettingsBodySchema.safeParse({ sharedFolders: '/music' }).success).toBe(false);
  });

  it('accepts a valid downloadFolder string', () => {
    const r = PatchSettingsBodySchema.safeParse({ downloadFolder: '/downloads' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.downloadFolder).toBe('/downloads');
  });

  it('accepts null for downloadFolder', () => {
    const r = PatchSettingsBodySchema.safeParse({ downloadFolder: null });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.downloadFolder).toBeNull();
  });

  it('trims whitespace from downloadFolder', () => {
    const r = PatchSettingsBodySchema.safeParse({ downloadFolder: '  /downloads  ' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.downloadFolder).toBe('/downloads');
  });

  it('rejects empty string downloadFolder', () => {
    expect(PatchSettingsBodySchema.safeParse({ downloadFolder: '   ' }).success).toBe(false);
  });

  it('accepts rescanIntervalMinutes of 0 (disabled)', () => {
    const r = PatchSettingsBodySchema.safeParse({ rescanIntervalMinutes: 0 });
    expect(r.success).toBe(true);
  });

  it('accepts a positive rescanIntervalMinutes', () => {
    const r = PatchSettingsBodySchema.safeParse({ rescanIntervalMinutes: 60 });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.rescanIntervalMinutes).toBe(60);
  });

  it('rejects negative rescanIntervalMinutes', () => {
    expect(PatchSettingsBodySchema.safeParse({ rescanIntervalMinutes: -1 }).success).toBe(false);
  });

  it('rejects non-integer rescanIntervalMinutes', () => {
    expect(PatchSettingsBodySchema.safeParse({ rescanIntervalMinutes: 1.5 }).success).toBe(false);
  });

  it('rejects rescanIntervalMinutes above 35791 (setInterval overflow guard)', () => {
    expect(PatchSettingsBodySchema.safeParse({ rescanIntervalMinutes: 35792 }).success).toBe(false);
  });

  it('accepts rescanIntervalMinutes at the maximum (35791)', () => {
    const r = PatchSettingsBodySchema.safeParse({ rescanIntervalMinutes: 35791 });
    expect(r.success).toBe(true);
  });

  it('accepts a valid owner/repo updateRepo', () => {
    const result = PatchSettingsBodySchema.safeParse({ updateRepo: 'someone/fork' });
    expect(result.success).toBe(true);
  });

  it('rejects an updateRepo without a slash', () => {
    const result = PatchSettingsBodySchema.safeParse({ updateRepo: 'not-a-repo' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid updateCheckIntervalMinutes', () => {
    const result = PatchSettingsBodySchema.safeParse({ updateCheckIntervalMinutes: 60 });
    expect(result.success).toBe(true);
  });

  it('rejects a negative updateCheckIntervalMinutes', () => {
    const result = PatchSettingsBodySchema.safeParse({ updateCheckIntervalMinutes: -1 });
    expect(result.success).toBe(false);
  });
});

describe('SearchQuerySchema', () => {
  it('defaults q to empty string, type to all, limit to 50, offset to 0', () => {
    const r = SearchQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.q).toBe('');
    expect(r.data.type).toBe('all');
    expect(r.data.limit).toBe(50);
    expect(r.data.offset).toBe(0);
  });

  it('accepts all valid type values', () => {
    for (const type of ['all', 'audio', 'video', 'image', 'document', 'ebook']) {
      expect(SearchQuerySchema.safeParse({ type }).success).toBe(true);
    }
  });

  it('rejects invalid type', () => {
    expect(SearchQuerySchema.safeParse({ type: 'unknown' }).success).toBe(false);
  });

  it('coerces string limit to integer', () => {
    const r = SearchQuerySchema.safeParse({ limit: '20' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.limit).toBe(20);
  });

  it('coerces string offset to integer', () => {
    const r = SearchQuerySchema.safeParse({ offset: '5' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.offset).toBe(5);
  });

  it('rejects limit of 0', () => {
    expect(SearchQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('rejects limit above 200', () => {
    expect(SearchQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('rejects negative offset', () => {
    expect(SearchQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });

  it('accepts limit of 200', () => {
    expect(SearchQuerySchema.safeParse({ limit: '200' }).success).toBe(true);
  });

  it('treats whitespace-only limit as absent and uses default', () => {
    const r = SearchQuerySchema.safeParse({ limit: '   ' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.limit).toBe(50);
  });

  it('treats whitespace-only offset as absent and uses default', () => {
    const r = SearchQuerySchema.safeParse({ offset: '   ' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.offset).toBe(0);
  });

  it('treats empty string type as absent and defaults to all', () => {
    const r = SearchQuerySchema.safeParse({ type: '' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.type).toBe('all');
  });

  it('treats whitespace-only type as absent and defaults to all', () => {
    const r = SearchQuerySchema.safeParse({ type: '   ' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.type).toBe('all');
  });

  it('defaults network to false when omitted', () => {
    const r = SearchQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.network).toBe(false);
  });

  it('parses network=true from the string "true"', () => {
    const r = SearchQuerySchema.safeParse({ network: 'true' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.network).toBe(true);
  });

  it('parses network=false from the string "false"', () => {
    const r = SearchQuerySchema.safeParse({ network: 'false' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.network).toBe(false);
  });

  it('treats any non-"true" string value as false', () => {
    expect(SearchQuerySchema.safeParse({ network: 'yes' }).data?.network).toBe(false);
    expect(SearchQuerySchema.safeParse({ network: '1' }).data?.network).toBe(false);
  });

  it('accepts boolean true directly', () => {
    const r = SearchQuerySchema.safeParse({ network: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.network).toBe(true);
  });

  it('rejects q longer than 500 characters', () => {
    expect(SearchQuerySchema.safeParse({ q: 'a'.repeat(501) }).success).toBe(false);
  });

  it('accepts q of exactly 500 characters', () => {
    expect(SearchQuerySchema.safeParse({ q: 'a'.repeat(500) }).success).toBe(true);
  });
});

describe('FriendRequestMessageSchema', () => {
  it('accepts a valid friend-request message', () => {
    const r = FriendRequestMessageSchema.safeParse({
      type: 'friend-request',
      name: 'Alice',
      port: 7734,
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing name', () => {
    expect(
      FriendRequestMessageSchema.safeParse({ type: 'friend-request', port: 7734 }).success,
    ).toBe(false);
  });

  it('rejects whitespace-only name', () => {
    expect(
      FriendRequestMessageSchema.safeParse({ type: 'friend-request', name: '  ', port: 7734 })
        .success,
    ).toBe(false);
  });

  it('rejects invalid port', () => {
    expect(
      FriendRequestMessageSchema.safeParse({ type: 'friend-request', name: 'Alice', port: 0 })
        .success,
    ).toBe(false);
    expect(
      FriendRequestMessageSchema.safeParse({ type: 'friend-request', name: 'Alice', port: 3.14 })
        .success,
    ).toBe(false);
  });

  it('rejects non-string password', () => {
    const r = FriendRequestMessageSchema.safeParse({
      type: 'friend-request',
      name: 'Alice',
      port: 7734,
      password: 123,
    });
    expect(r.success).toBe(false);
  });

  it('rejects name longer than 200 characters', () => {
    expect(
      FriendRequestMessageSchema.safeParse({
        type: 'friend-request',
        name: 'a'.repeat(201),
        port: 7734,
      }).success,
    ).toBe(false);
  });

  it('accepts name at exactly 200 characters', () => {
    expect(
      FriendRequestMessageSchema.safeParse({
        type: 'friend-request',
        name: 'a'.repeat(200),
        port: 7734,
      }).success,
    ).toBe(true);
  });

  it('rejects password longer than 200 characters', () => {
    expect(
      FriendRequestMessageSchema.safeParse({
        type: 'friend-request',
        name: 'Alice',
        port: 7734,
        password: 'x'.repeat(201),
      }).success,
    ).toBe(false);
  });

  it('accepts password at exactly 200 characters', () => {
    expect(
      FriendRequestMessageSchema.safeParse({
        type: 'friend-request',
        name: 'Alice',
        port: 7734,
        password: 'x'.repeat(200),
      }).success,
    ).toBe(true);
  });
});

describe('ChunkRequestMessageSchema', () => {
  const valid = {
    type: 'chunk-request',
    transferId: '00000000-0000-0000-0000-000000000000',
    sha256: 'a'.repeat(64),
    offset: 0,
    length: 1024,
  };

  it('accepts a valid chunk request', () => {
    expect(ChunkRequestMessageSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects negative offset', () => {
    expect(ChunkRequestMessageSchema.safeParse({ ...valid, offset: -1 }).success).toBe(false);
  });

  it('rejects offset above Number.MAX_SAFE_INTEGER', () => {
    expect(
      ChunkRequestMessageSchema.safeParse({ ...valid, offset: Number.MAX_SAFE_INTEGER + 1 })
        .success,
    ).toBe(false);
  });

  it('accepts offset at Number.MAX_SAFE_INTEGER', () => {
    expect(
      ChunkRequestMessageSchema.safeParse({ ...valid, offset: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(true);
  });

  it('rejects length above 4 MB', () => {
    expect(
      ChunkRequestMessageSchema.safeParse({ ...valid, length: 4 * 1024 * 1024 + 1 }).success,
    ).toBe(false);
  });

  it('accepts length at exactly 4 MB', () => {
    expect(ChunkRequestMessageSchema.safeParse({ ...valid, length: 4 * 1024 * 1024 }).success).toBe(
      true,
    );
  });

  it('rejects length of 0', () => {
    expect(ChunkRequestMessageSchema.safeParse({ ...valid, length: 0 }).success).toBe(false);
  });

  it('rejects invalid transferId', () => {
    expect(
      ChunkRequestMessageSchema.safeParse({ ...valid, transferId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('rejects invalid sha256', () => {
    expect(ChunkRequestMessageSchema.safeParse({ ...valid, sha256: 'short' }).success).toBe(false);
  });
});

describe('FriendResponseMessageSchema', () => {
  it('accepts accepted=true with optional name', () => {
    const r = FriendResponseMessageSchema.safeParse({
      type: 'friend-response',
      accepted: true,
      name: 'Bob',
    });
    expect(r.success).toBe(true);
  });

  it('accepts accepted=false without name', () => {
    const r = FriendResponseMessageSchema.safeParse({ type: 'friend-response', accepted: false });
    expect(r.success).toBe(true);
  });

  it('rejects non-boolean accepted', () => {
    expect(
      FriendResponseMessageSchema.safeParse({ type: 'friend-response', accepted: 'yes' }).success,
    ).toBe(false);
    expect(
      FriendResponseMessageSchema.safeParse({ type: 'friend-response', accepted: 1 }).success,
    ).toBe(false);
  });

  it('rejects non-string name', () => {
    const r = FriendResponseMessageSchema.safeParse({
      type: 'friend-response',
      accepted: true,
      name: 42,
    });
    expect(r.success).toBe(false);
  });

  it('trims whitespace from name', () => {
    const r = FriendResponseMessageSchema.safeParse({
      type: 'friend-response',
      accepted: true,
      name: '  Bob  ',
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.name).toBe('Bob');
  });

  it('normalizes whitespace-only name to undefined', () => {
    const r = FriendResponseMessageSchema.safeParse({
      type: 'friend-response',
      accepted: true,
      name: '   ',
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.name).toBeUndefined();
  });

  it('rejects name longer than 200 characters', () => {
    const r = FriendResponseMessageSchema.safeParse({
      type: 'friend-response',
      accepted: true,
      name: 'a'.repeat(201),
    });
    expect(r.success).toBe(false);
  });

  it('accepts name at exactly 200 characters', () => {
    const r = FriendResponseMessageSchema.safeParse({
      type: 'friend-response',
      accepted: true,
      name: 'a'.repeat(200),
    });
    expect(r.success).toBe(true);
  });
});

describe('SearchResultItemSchema', () => {
  const valid = {
    filename: 'song.mp3',
    size: '1234567',
    sha256: 'a'.repeat(64),
    mimeType: 'audio/mpeg',
    metadata: null,
  };

  it('accepts a valid result item', () => {
    expect(SearchResultItemSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts null mimeType and metadata', () => {
    expect(
      SearchResultItemSchema.safeParse({ ...valid, mimeType: null, metadata: null }).success,
    ).toBe(true);
  });

  it('rejects size with non-digit characters', () => {
    expect(SearchResultItemSchema.safeParse({ ...valid, size: '123abc' }).success).toBe(false);
    expect(SearchResultItemSchema.safeParse({ ...valid, size: '-1' }).success).toBe(false);
  });

  it('rejects size longer than 20 characters', () => {
    expect(SearchResultItemSchema.safeParse({ ...valid, size: '1'.repeat(21) }).success).toBe(
      false,
    );
  });

  it('accepts size at exactly 20 characters', () => {
    expect(SearchResultItemSchema.safeParse({ ...valid, size: '1'.repeat(20) }).success).toBe(true);
  });

  it('rejects sha256 of wrong length', () => {
    expect(SearchResultItemSchema.safeParse({ ...valid, sha256: 'a'.repeat(63) }).success).toBe(
      false,
    );
    expect(SearchResultItemSchema.safeParse({ ...valid, sha256: 'a'.repeat(65) }).success).toBe(
      false,
    );
  });

  it('rejects sha256 with non-hex characters', () => {
    expect(SearchResultItemSchema.safeParse({ ...valid, sha256: 'g'.repeat(64) }).success).toBe(
      false,
    );
  });

  it('rejects filename longer than 1000 characters', () => {
    expect(SearchResultItemSchema.safeParse({ ...valid, filename: 'a'.repeat(1001) }).success).toBe(
      false,
    );
  });

  it('rejects metadata longer than 4096 characters', () => {
    expect(SearchResultItemSchema.safeParse({ ...valid, metadata: 'x'.repeat(4097) }).success).toBe(
      false,
    );
  });
});

describe('SearchRequestMessageSchema', () => {
  const valid = {
    type: 'search-request',
    searchId: '00000000-0000-0000-0000-000000000000',
    originNodeId: 'node-abc',
    query: 'hello',
    fileType: 'audio',
    ttl: 3,
  };

  it('accepts a valid search-request', () => {
    expect(SearchRequestMessageSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects ttl below 1', () => {
    expect(SearchRequestMessageSchema.safeParse({ ...valid, ttl: 0 }).success).toBe(false);
    expect(SearchRequestMessageSchema.safeParse({ ...valid, ttl: -1 }).success).toBe(false);
  });

  it('rejects ttl above 10', () => {
    expect(SearchRequestMessageSchema.safeParse({ ...valid, ttl: 11 }).success).toBe(false);
  });

  it('rejects non-integer ttl', () => {
    expect(SearchRequestMessageSchema.safeParse({ ...valid, ttl: 2.5 }).success).toBe(false);
  });

  it('rejects invalid searchId (not a UUID)', () => {
    expect(SearchRequestMessageSchema.safeParse({ ...valid, searchId: 'not-a-uuid' }).success).toBe(
      false,
    );
  });

  it('rejects query longer than 500 characters', () => {
    expect(SearchRequestMessageSchema.safeParse({ ...valid, query: 'a'.repeat(501) }).success).toBe(
      false,
    );
  });
});

describe('SearchResultMessageSchema', () => {
  const validItem = {
    filename: 'file.txt',
    size: '100',
    sha256: 'b'.repeat(64),
    mimeType: null,
    metadata: null,
  };
  const valid = {
    type: 'search-result',
    searchId: '00000000-0000-0000-0000-000000000000',
    fromNodeId: 'node-xyz',
    results: [validItem],
  };

  it('accepts a valid search-result', () => {
    expect(SearchResultMessageSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an empty results array', () => {
    expect(SearchResultMessageSchema.safeParse({ ...valid, results: [] }).success).toBe(true);
  });

  it('rejects more than 200 result items', () => {
    expect(
      SearchResultMessageSchema.safeParse({ ...valid, results: Array(201).fill(validItem) })
        .success,
    ).toBe(false);
  });

  it('accepts optional viaNodeId', () => {
    expect(SearchResultMessageSchema.safeParse({ ...valid, viaNodeId: 'relay-node' }).success).toBe(
      true,
    );
  });

  it('rejects invalid searchId', () => {
    expect(SearchResultMessageSchema.safeParse({ ...valid, searchId: 'bad' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChatMessageSchema
// ---------------------------------------------------------------------------

describe('ChatMessageSchema', () => {
  const valid = {
    type: 'chat-message',
    messageId: '00000000-0000-0000-0000-000000000000',
    conversationId: 'group:abc',
    fromNodeId: 'node-a',
    body: 'Hello',
    sentAt: 1_000_000,
  };

  it('accepts a valid chat message', () => {
    expect(ChatMessageSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an optional conversationName', () => {
    const r = ChatMessageSchema.safeParse({ ...valid, conversationName: 'Dev Chat' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.conversationName).toBe('Dev Chat');
  });

  it('trims conversationName and treats empty string as undefined', () => {
    const r = ChatMessageSchema.safeParse({ ...valid, conversationName: '   ' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.conversationName).toBeUndefined();
  });

  it('trims conversationName whitespace', () => {
    const r = ChatMessageSchema.safeParse({ ...valid, conversationName: '  My Group  ' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.conversationName).toBe('My Group');
  });

  it('rejects conversationId without valid prefix', () => {
    expect(ChatMessageSchema.safeParse({ ...valid, conversationId: 'bad:id' }).success).toBe(false);
  });

  it('rejects conversationId containing /', () => {
    expect(ChatMessageSchema.safeParse({ ...valid, conversationId: 'group:abc/def' }).success).toBe(
      false,
    );
  });

  it('rejects conversationId containing ?', () => {
    expect(ChatMessageSchema.safeParse({ ...valid, conversationId: 'group:abc?x=1' }).success).toBe(
      false,
    );
  });

  it('rejects conversationId containing #', () => {
    expect(
      ChatMessageSchema.safeParse({ ...valid, conversationId: 'group:abc#frag' }).success,
    ).toBe(false);
  });

  it('rejects sentAt above max valid Date timestamp', () => {
    expect(ChatMessageSchema.safeParse({ ...valid, sentAt: 8_640_000_000_000_001 }).success).toBe(
      false,
    );
  });

  it('accepts sentAt at max valid Date timestamp', () => {
    expect(ChatMessageSchema.safeParse({ ...valid, sentAt: 8_640_000_000_000_000 }).success).toBe(
      true,
    );
  });

  it('rejects empty body', () => {
    expect(ChatMessageSchema.safeParse({ ...valid, body: '' }).success).toBe(false);
  });

  it('rejects whitespace-only body', () => {
    expect(ChatMessageSchema.safeParse({ ...valid, body: '   ' }).success).toBe(false);
  });
});
