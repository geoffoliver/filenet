import { describe, expect, it } from 'bun:test';

import {
  AddFriendBodySchema,
  FriendActionBodySchema,
  FriendRequestMessageSchema,
  FriendResponseMessageSchema,
  PatchSettingsBodySchema,
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

  it('rejects wrong type for invitePassword', () => {
    expect(PatchSettingsBodySchema.safeParse({ invitePassword: 123 }).success).toBe(false);
  });

  it('rejects non-object body', () => {
    expect(PatchSettingsBodySchema.safeParse(null).success).toBe(false);
    expect(PatchSettingsBodySchema.safeParse([]).success).toBe(false);
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
});
