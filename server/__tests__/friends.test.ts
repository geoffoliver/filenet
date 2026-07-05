import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import {
  acceptFriendRequest,
  addOutgoingFriend,
  getFriends,
  handleIncomingFriendRequest,
  rejectFriendRequest,
  removeFriend,
  shouldAutoAccept,
} from '../friends';
import { friends, settings } from '../schema';
import { getOrCreateSettings, updateSettings } from '../config';
import { generateIdentity } from '../identity';

const TEST_DB_URL = 'file:./data/test-friends.db';
let db: Db;

beforeAll(() => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
});

afterAll(() => {
  db.$client.close();
  try {
    unlinkSync('./data/test-friends.db');
  } catch {}
});

beforeEach(() => {
  db.delete(friends).run();
  db.delete(settings).run();
});

describe('addOutgoingFriend', () => {
  it('creates a friend record with OUTGOING_PENDING status', async () => {
    const friend = await addOutgoingFriend(db, {
      name: 'Bob',
      address: '192.168.1.10',
      port: 7734,
    });
    expect(friend.status).toBe('OUTGOING_PENDING');
    expect(friend.name).toBe('Bob');
    expect(friend.address).toBe('192.168.1.10');
    expect(friend.port).toBe(7734);
    expect(friend.nodeId).toBeNull();
    expect(friend.publicKey).toBeNull();
  });

  it('stores the invite password when provided', async () => {
    const friend = await addOutgoingFriend(db, {
      name: 'Carol',
      address: '192.168.1.11',
      port: 7734,
      password: 'hunter2',
    });
    expect(friend.remotePassword).toBe('hunter2');
  });

  it('stores null remotePassword when no password is provided', async () => {
    const friend = await addOutgoingFriend(db, {
      name: 'Dave',
      address: '192.168.1.12',
      port: 7734,
    });
    expect(friend.remotePassword).toBeNull();
  });

  it('rejects duplicate address + port combinations', async () => {
    await addOutgoingFriend(db, { name: 'Bob', address: '192.168.1.10', port: 7734 });
    await expect(
      addOutgoingFriend(db, { name: 'Bob Again', address: '192.168.1.10', port: 7734 }),
    ).rejects.toThrow();
  });
});

describe('handleIncomingFriendRequest', () => {
  it('creates a friend record with INCOMING_PENDING status', async () => {
    const peerIdentity = generateIdentity();
    const friend = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Carol',
      address: '10.0.0.5',
      port: 7734,
    });
    expect(friend.status).toBe('INCOMING_PENDING');
    expect(friend.nodeId).toBe(peerIdentity.nodeId);
    expect(friend.name).toBe('Carol');
  });

  it('updates stale name/address/port when the same peer reconnects from a new location', async () => {
    const peerIdentity = generateIdentity();
    await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'OldName',
      address: '10.0.0.5',
      port: 7734,
    });
    const updated = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'NewName',
      address: '10.0.0.99',
      port: 7800,
    });
    expect(updated.name).toBe('NewName');
    expect(updated.address).toBe('10.0.0.99');
    expect(updated.port).toBe(7800);
    const all = db.select().from(friends).where(eq(friends.nodeId, peerIdentity.nodeId)).all();
    expect(all.length).toBe(1);
  });

  it('does not duplicate if request already exists from same nodeId', async () => {
    const peerIdentity = generateIdentity();
    const params = {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Carol',
      address: '10.0.0.5',
      port: 7734,
    };
    await handleIncomingFriendRequest(db, params);
    const second = await handleIncomingFriendRequest(db, params);
    const all = db.select().from(friends).where(eq(friends.nodeId, peerIdentity.nodeId)).all();
    expect(all.length).toBe(1);
    expect(second.id).toBe(all[0].id);
  });

  it('clears acceptedAt when an already-accepted record is re-upgraded to INCOMING_PENDING', async () => {
    const peerIdentity = generateIdentity();
    const outgoing = await addOutgoingFriend(db, {
      name: 'Re-requester',
      address: '10.0.0.200',
      port: 7734,
    });
    await acceptFriendRequest(db, outgoing.id);
    const incoming = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Re-requester',
      address: '10.0.0.200',
      port: 7734,
    });
    expect(incoming.id).toBe(outgoing.id);
    expect(incoming.status).toBe('INCOMING_PENDING');
    expect(incoming.acceptedAt).toBeNull();
  });

  it('does not upgrade a BLOCKED record matched by address+port', async () => {
    const peerIdentity = generateIdentity();
    const outgoing = await addOutgoingFriend(db, {
      name: 'Blocked',
      address: '10.0.0.11',
      port: 7734,
    });
    db.update(friends)
      .set({ status: 'BLOCKED', updatedAt: new Date() })
      .where(eq(friends.id, outgoing.id))
      .run();
    const returned = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Blocked',
      address: '10.0.0.11',
      port: 7734,
    });
    expect(returned.id).toBe(outgoing.id);
    expect(returned.status).toBe('BLOCKED');
    expect(db.select().from(friends).all().length).toBe(1);
  });

  it('upgrades an OUTGOING_PENDING record when the peer sends back a request', async () => {
    const peerIdentity = generateIdentity();
    const outgoing = await addOutgoingFriend(db, { name: 'Dan', address: '10.0.0.10', port: 7734 });
    const incoming = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Dan',
      address: '10.0.0.10',
      port: 7734,
    });
    expect(incoming.id).toBe(outgoing.id);
    expect(incoming.status).toBe('INCOMING_PENDING');
    expect(incoming.nodeId).toBe(peerIdentity.nodeId);
    expect(db.select().from(friends).all().length).toBe(1);
  });

  it('clears remotePassword when upgrading OUTGOING_PENDING to INCOMING_PENDING', async () => {
    const peerIdentity = generateIdentity();
    await addOutgoingFriend(db, {
      name: 'Dan',
      address: '10.0.0.10',
      port: 7734,
      password: 'secret',
    });
    const incoming = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Dan',
      address: '10.0.0.10',
      port: 7734,
    });
    expect(incoming.remotePassword).toBeNull();
  });

  it('updates name when upgrading an existing record matched by address+port', async () => {
    const peerIdentity = generateIdentity();
    await addOutgoingFriend(db, { name: 'Placeholder Name', address: '10.0.0.15', port: 7734 });
    const incoming = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Their Real Name',
      address: '10.0.0.15',
      port: 7734,
    });
    expect(incoming.name).toBe('Their Real Name');
  });
});

describe('acceptFriendRequest', () => {
  it('transitions an INCOMING_PENDING friend to ACCEPTED', async () => {
    const peerIdentity = generateIdentity();
    const incoming = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Dave',
      address: '10.0.0.6',
      port: 7734,
    });
    const accepted = await acceptFriendRequest(db, incoming.id);
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.acceptedAt).not.toBeNull();
  });

  it('transitions an OUTGOING_PENDING friend to ACCEPTED (they accepted us)', async () => {
    const friend = await addOutgoingFriend(db, { name: 'Eve', address: '10.0.0.7', port: 7734 });
    const accepted = await acceptFriendRequest(db, friend.id);
    expect(accepted.status).toBe('ACCEPTED');
  });

  it('clears remotePassword on acceptance', async () => {
    const friend = await addOutgoingFriend(db, {
      name: 'Faye',
      address: '10.0.0.8',
      port: 7734,
      password: 'secret',
    });
    expect(friend.remotePassword).toBe('secret');
    const accepted = await acceptFriendRequest(db, friend.id);
    expect(accepted.remotePassword).toBeNull();
  });

  it('does not overwrite acceptedAt when called again on an already-accepted friend', async () => {
    const peerIdentity = generateIdentity();
    const incoming = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Dave',
      address: '10.0.0.6',
      port: 7734,
    });
    const first = await acceptFriendRequest(db, incoming.id);
    await new Promise((r) => setTimeout(r, 5));
    const second = await acceptFriendRequest(db, incoming.id);
    expect(second.acceptedAt?.getTime()).toBe(first.acceptedAt?.getTime());
  });

  it('throws if friend does not exist', () => {
    expect(() => acceptFriendRequest(db, 'nonexistent-id')).toThrow();
  });

  it('throws when trying to accept a BLOCKED friend', async () => {
    const peerIdentity = generateIdentity();
    const friend = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Blocked',
      address: '10.0.0.100',
      port: 7734,
    });
    db.update(friends)
      .set({ status: 'BLOCKED', updatedAt: new Date() })
      .where(eq(friends.id, friend.id))
      .run();
    expect(() => acceptFriendRequest(db, friend.id)).toThrow();
  });

  it('is a no-op when called on an already-ACCEPTED friend', async () => {
    const peerIdentity = generateIdentity();
    const incoming = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Dave',
      address: '10.0.0.6',
      port: 7734,
    });
    const first = await acceptFriendRequest(db, incoming.id);
    await new Promise((r) => setTimeout(r, 5));
    const second = await acceptFriendRequest(db, incoming.id);
    expect(second.status).toBe('ACCEPTED');
    expect(second.acceptedAt?.getTime()).toBe(first.acceptedAt?.getTime());
  });
});

describe('rejectFriendRequest', () => {
  it('removes an INCOMING_PENDING friend request', async () => {
    const peerIdentity = generateIdentity();
    const incoming = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Frank',
      address: '10.0.0.8',
      port: 7734,
    });
    await rejectFriendRequest(db, incoming.id);
    const found = db.select().from(friends).where(eq(friends.id, incoming.id)).get();
    expect(found).toBeUndefined();
  });

  it('removes an OUTGOING_PENDING friend record', async () => {
    const friend = await addOutgoingFriend(db, {
      name: 'Outgoing',
      address: '10.0.0.50',
      port: 7734,
    });
    await rejectFriendRequest(db, friend.id);
    const found = db.select().from(friends).where(eq(friends.id, friend.id)).get();
    expect(found).toBeUndefined();
  });

  it('throws when trying to reject an ACCEPTED friend', async () => {
    const peerIdentity = generateIdentity();
    const incoming = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Henry',
      address: '10.0.0.60',
      port: 7734,
    });
    await acceptFriendRequest(db, incoming.id);
    await expect(rejectFriendRequest(db, incoming.id)).rejects.toThrow();
  });

  it('throws when trying to reject a BLOCKED friend', async () => {
    const peerIdentity = generateIdentity();
    const friend = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Ivan',
      address: '10.0.0.70',
      port: 7734,
    });
    db.update(friends)
      .set({ status: 'BLOCKED', updatedAt: new Date() })
      .where(eq(friends.id, friend.id))
      .run();
    await expect(rejectFriendRequest(db, friend.id)).rejects.toThrow();
  });
});

describe('removeFriend', () => {
  it('deletes an ACCEPTED friend', async () => {
    const peerIdentity = generateIdentity();
    const incoming = await handleIncomingFriendRequest(db, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Grace',
      address: '10.0.0.9',
      port: 7734,
    });
    await acceptFriendRequest(db, incoming.id);
    await removeFriend(db, incoming.id);
    const found = db.select().from(friends).where(eq(friends.id, incoming.id)).get();
    expect(found).toBeUndefined();
  });

  it('throws if friend does not exist', async () => {
    await expect(removeFriend(db, 'nonexistent-id')).rejects.toThrow();
  });
});

describe('getFriends', () => {
  it('returns all friends', async () => {
    const peer = generateIdentity();
    await addOutgoingFriend(db, { name: 'Alice', address: '10.0.0.1', port: 7734 });
    await handleIncomingFriendRequest(db, {
      nodeId: peer.nodeId,
      publicKey: peer.publicKey.toString('base64'),
      name: 'Bob',
      address: '10.0.0.2',
      port: 7734,
    });
    const all = await getFriends(db);
    expect(all.length).toBe(2);
  });

  it('filters by status', async () => {
    const peer = generateIdentity();
    await addOutgoingFriend(db, { name: 'Alice', address: '10.0.0.1', port: 7734 });
    await handleIncomingFriendRequest(db, {
      nodeId: peer.nodeId,
      publicKey: peer.publicKey.toString('base64'),
      name: 'Bob',
      address: '10.0.0.2',
      port: 7734,
    });
    const pending = await getFriends(db, 'INCOMING_PENDING');
    expect(pending.length).toBe(1);
    expect(pending[0].name).toBe('Bob');
  });
});

describe('shouldAutoAccept', () => {
  it('returns false when auto-accept is off', async () => {
    const s = await getOrCreateSettings(db);
    expect(shouldAutoAccept(s, undefined)).toBe(false);
  });

  it('returns true when autoAcceptFromAnyone is on', async () => {
    const s = await updateSettings(db, { autoAcceptFromAnyone: true });
    expect(shouldAutoAccept(s, undefined)).toBe(true);
  });

  it('returns true when correct invite password provided', async () => {
    const s = await updateSettings(db, { invitePassword: 'open-sesame' });
    expect(shouldAutoAccept(s, 'open-sesame')).toBe(true);
  });

  it('returns true when invitePassword is empty string and empty string provided', async () => {
    const s = await updateSettings(db, { invitePassword: '' });
    expect(shouldAutoAccept(s, '')).toBe(true);
  });

  it('returns false when invitePassword is empty string but password is omitted', async () => {
    const s = await updateSettings(db, { invitePassword: '' });
    expect(shouldAutoAccept(s, undefined)).toBe(false);
  });

  it('returns false when wrong invite password provided', async () => {
    const s = await updateSettings(db, { invitePassword: 'open-sesame' });
    expect(shouldAutoAccept(s, 'wrong-password')).toBe(false);
  });

  it('returns false when invite password is set but no password provided', async () => {
    const s = await updateSettings(db, { invitePassword: 'secret' });
    expect(shouldAutoAccept(s, undefined)).toBe(false);
  });

  it('returns false when passwords differ only in length (timing-safe check)', async () => {
    const s = await updateSettings(db, { invitePassword: 'abc' });
    expect(shouldAutoAccept(s, 'abcd')).toBe(false);
    expect(shouldAutoAccept(s, 'ab')).toBe(false);
  });

  it('runs the timing-safe comparison even when no password is provided', async () => {
    const s = await updateSettings(db, { invitePassword: 'secret' });
    expect(shouldAutoAccept(s, undefined)).toBe(false);
    expect(shouldAutoAccept(s, '')).toBe(false);
  });
});
