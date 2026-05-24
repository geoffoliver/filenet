import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';

import {
  acceptFriendRequest,
  addOutgoingFriend,
  getFriends,
  handleIncomingFriendRequest,
  rejectFriendRequest,
  removeFriend,
  shouldAutoAccept,
} from '../friends';
import { getOrCreateSettings, updateSettings } from '../config';
import { createPrismaClient } from '../db';
import { generateIdentity } from '../identity';

const TEST_DB_URL = 'file:./data/test-friends.db';
let prisma: PrismaClient;

beforeAll(() => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    unlinkSync('./data/test-friends.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.friend.deleteMany();
  await prisma.settings.deleteMany();
});

describe('addOutgoingFriend', () => {
  it('creates a friend record with OUTGOING_PENDING status', async () => {
    const friend = await addOutgoingFriend(prisma, {
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

  it('rejects duplicate address + port combinations', async () => {
    await addOutgoingFriend(prisma, {
      name: 'Bob',
      address: '192.168.1.10',
      port: 7734,
    });
    await expect(
      addOutgoingFriend(prisma, {
        name: 'Bob Again',
        address: '192.168.1.10',
        port: 7734,
      }),
    ).rejects.toThrow();
  });
});

describe('handleIncomingFriendRequest', () => {
  it('creates a friend record with INCOMING_PENDING status', async () => {
    const peerIdentity = generateIdentity();
    const friend = await handleIncomingFriendRequest(prisma, {
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
    await handleIncomingFriendRequest(prisma, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'OldName',
      address: '10.0.0.5',
      port: 7734,
    });
    const updated = await handleIncomingFriendRequest(prisma, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'NewName',
      address: '10.0.0.99',
      port: 7800,
    });
    expect(updated.name).toBe('NewName');
    expect(updated.address).toBe('10.0.0.99');
    expect(updated.port).toBe(7800);
    const all = await prisma.friend.findMany({ where: { nodeId: peerIdentity.nodeId } });
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
    await handleIncomingFriendRequest(prisma, params);
    const second = await handleIncomingFriendRequest(prisma, params);
    const all = await prisma.friend.findMany({ where: { nodeId: peerIdentity.nodeId } });
    expect(all.length).toBe(1);
    expect(second.id).toBe(all[0].id);
  });

  it('upgrades an OUTGOING_PENDING record when the peer sends back a request', async () => {
    const peerIdentity = generateIdentity();
    const outgoing = await addOutgoingFriend(prisma, {
      name: 'Dan',
      address: '10.0.0.10',
      port: 7734,
    });
    const incoming = await handleIncomingFriendRequest(prisma, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Dan',
      address: '10.0.0.10',
      port: 7734,
    });
    expect(incoming.id).toBe(outgoing.id);
    expect(incoming.status).toBe('INCOMING_PENDING');
    expect(incoming.nodeId).toBe(peerIdentity.nodeId);
    const all = await prisma.friend.findMany();
    expect(all.length).toBe(1);
  });
});

describe('acceptFriendRequest', () => {
  it('transitions an INCOMING_PENDING friend to ACCEPTED', async () => {
    const peerIdentity = generateIdentity();
    const incoming = await handleIncomingFriendRequest(prisma, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Dave',
      address: '10.0.0.6',
      port: 7734,
    });
    const accepted = await acceptFriendRequest(prisma, incoming.id);
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.acceptedAt).not.toBeNull();
  });

  it('transitions an OUTGOING_PENDING friend to ACCEPTED (they accepted us)', async () => {
    const friend = await addOutgoingFriend(prisma, {
      name: 'Eve',
      address: '10.0.0.7',
      port: 7734,
    });
    const accepted = await acceptFriendRequest(prisma, friend.id);
    expect(accepted.status).toBe('ACCEPTED');
  });

  it('does not overwrite acceptedAt when called again on an already-accepted friend', async () => {
    const peerIdentity = generateIdentity();
    const incoming = await handleIncomingFriendRequest(prisma, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Dave',
      address: '10.0.0.6',
      port: 7734,
    });
    const first = await acceptFriendRequest(prisma, incoming.id);
    await new Promise((r) => setTimeout(r, 5));
    const second = await acceptFriendRequest(prisma, incoming.id);
    expect(second.acceptedAt?.getTime()).toBe(first.acceptedAt?.getTime());
  });

  it('throws if friend does not exist', async () => {
    await expect(acceptFriendRequest(prisma, 'nonexistent-id')).rejects.toThrow();
  });
});

describe('rejectFriendRequest', () => {
  it('removes an INCOMING_PENDING friend request', async () => {
    const peerIdentity = generateIdentity();
    const incoming = await handleIncomingFriendRequest(prisma, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Frank',
      address: '10.0.0.8',
      port: 7734,
    });
    await rejectFriendRequest(prisma, incoming.id);
    const found = await prisma.friend.findUnique({ where: { id: incoming.id } });
    expect(found).toBeNull();
  });
});

describe('removeFriend', () => {
  it('deletes an ACCEPTED friend', async () => {
    const peerIdentity = generateIdentity();
    const incoming = await handleIncomingFriendRequest(prisma, {
      nodeId: peerIdentity.nodeId,
      publicKey: peerIdentity.publicKey.toString('base64'),
      name: 'Grace',
      address: '10.0.0.9',
      port: 7734,
    });
    await acceptFriendRequest(prisma, incoming.id);
    await removeFriend(prisma, incoming.id);
    const found = await prisma.friend.findUnique({ where: { id: incoming.id } });
    expect(found).toBeNull();
  });

  it('throws if friend does not exist', async () => {
    await expect(removeFriend(prisma, 'nonexistent-id')).rejects.toThrow();
  });
});

describe('getFriends', () => {
  it('returns all friends', async () => {
    const peer = generateIdentity();
    await addOutgoingFriend(prisma, {
      name: 'Alice',
      address: '10.0.0.1',
      port: 7734,
    });
    await handleIncomingFriendRequest(prisma, {
      nodeId: peer.nodeId,
      publicKey: peer.publicKey.toString('base64'),
      name: 'Bob',
      address: '10.0.0.2',
      port: 7734,
    });
    const all = await getFriends(prisma);
    expect(all.length).toBe(2);
  });

  it('filters by status', async () => {
    const peer = generateIdentity();
    await addOutgoingFriend(prisma, {
      name: 'Alice',
      address: '10.0.0.1',
      port: 7734,
    });
    await handleIncomingFriendRequest(prisma, {
      nodeId: peer.nodeId,
      publicKey: peer.publicKey.toString('base64'),
      name: 'Bob',
      address: '10.0.0.2',
      port: 7734,
    });
    const pending = await getFriends(prisma, 'INCOMING_PENDING');
    expect(pending.length).toBe(1);
    expect(pending[0].name).toBe('Bob');
  });
});

describe('shouldAutoAccept', () => {
  it('returns false when auto-accept is off', async () => {
    const settings = await getOrCreateSettings(prisma);
    const result = await shouldAutoAccept(settings, undefined);
    expect(result).toBe(false);
  });

  it('returns true when autoAcceptFromAnyone is on', async () => {
    const settings = await updateSettings(prisma, { autoAcceptFromAnyone: true });
    const result = await shouldAutoAccept(settings, undefined);
    expect(result).toBe(true);
  });

  it('returns true when correct invite password provided', async () => {
    const settings = await updateSettings(prisma, { invitePassword: 'open-sesame' });
    const result = await shouldAutoAccept(settings, 'open-sesame');
    expect(result).toBe(true);
  });

  it('returns true when invitePassword is empty string and empty string provided', async () => {
    const settings = await updateSettings(prisma, { invitePassword: '' });
    expect(shouldAutoAccept(settings, '')).toBe(true);
  });

  it('returns false when wrong invite password provided', async () => {
    const settings = await updateSettings(prisma, { invitePassword: 'open-sesame' });
    const result = await shouldAutoAccept(settings, 'wrong-password');
    expect(result).toBe(false);
  });
});
