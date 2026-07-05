import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from 'bun:test';
import { eq } from 'drizzle-orm';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import { friends, settings } from '../schema';
import { reconnectOnce, resetDialingForTesting } from '../reconnect';
import { registerPeer, unregisterPeer } from '../connections';
import type { ConnectPeerFn } from '../management';
import type { ConnectedPeer } from '../connections';
import type { Identity } from '../identity';
import { getOrCreateSettings } from '../config';

const TEST_DB_URL = 'file:./data/test-reconnect.db';
let db: Db;

const identity: Identity = {
  nodeId: 'test-node-id',
  publicKey: Buffer.alloc(32),
  privateKey: Buffer.alloc(64),
};

function makePeer(nodeId: string, address: string, port: number): ConnectedPeer {
  return {
    peerNodeId: nodeId,
    peerPublicKey: Buffer.alloc(32),
    address,
    port,
    sessionKey: Buffer.alloc(32),
    ws: { send() {}, close() {} },
  };
}

beforeAll(() => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
});

afterAll(() => {
  db.$client.close();
  try {
    unlinkSync('./data/test-reconnect.db');
  } catch {}
});

beforeEach(async () => {
  db.delete(friends).run();
  await getOrCreateSettings(db);
  db.update(settings).set({ name: '' }).run();
  resetDialingForTesting();
});

function insertFriend(data: {
  name: string;
  address: string;
  port: number;
  nodeId?: string;
  status?: string;
  acceptedAt?: Date;
  remotePassword?: string;
}) {
  const now = new Date();
  db.insert(friends)
    .values({
      id: randomUUID(),
      name: data.name,
      address: data.address,
      port: data.port,
      nodeId: data.nodeId ?? null,
      status: (data.status ?? 'OUTGOING_PENDING') as any,
      acceptedAt: data.acceptedAt ?? null,
      remotePassword: data.remotePassword ?? null,
      addedAt: now,
      updatedAt: now,
    })
    .run();
}

describe('reconnectOnce', () => {
  it('dials an ACCEPTED friend that is not currently connected', async () => {
    insertFriend({
      name: 'Alice',
      address: '10.0.0.1',
      port: 7734,
      nodeId: 'alice-id',
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    });
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);
    expect(connectPeer).toHaveBeenCalledWith('10.0.0.1', 7734, undefined);
  });

  it('skips an ACCEPTED friend that is already connected', async () => {
    insertFriend({
      name: 'Bob',
      address: '10.0.0.2',
      port: 7734,
      nodeId: 'bob-id',
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    });
    const { ws, sessionKey, peerPublicKey } = makePeer('bob-id', '10.0.0.2', 7734);
    registerPeer(ws, sessionKey, 'bob-id', peerPublicKey, '10.0.0.2', 7734);
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).not.toHaveBeenCalled();
    unregisterPeer('bob-id');
  });

  it('dials an OUTGOING_PENDING friend with a friend-request payload', async () => {
    insertFriend({ name: 'Charlie', address: '10.0.0.3', port: 7734, status: 'OUTGOING_PENDING' });
    db.update(settings).set({ name: 'Local User' }).run();
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);
    const [addr, port, req] = connectPeer.mock.calls[0] as Parameters<ConnectPeerFn>;
    expect(addr).toBe('10.0.0.3');
    expect(port).toBe(7734);
    expect(req).toEqual({ name: 'Local User' });
  });

  it('falls back to the local nodeId (not the remote name) when no display name is set', async () => {
    insertFriend({ name: 'Charlie', address: '10.0.0.3', port: 7734, status: 'OUTGOING_PENDING' });
    db.update(settings).set({ name: '' }).run();
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);
    const [, , req] = connectPeer.mock.calls[0] as Parameters<ConnectPeerFn>;
    expect(req).toEqual({ name: 'test-node-id' });
  });

  it('includes the stored remotePassword in the friend-request', async () => {
    insertFriend({
      name: 'Dan',
      address: '10.0.0.12',
      port: 7734,
      status: 'OUTGOING_PENDING',
      remotePassword: 'secret123',
    });
    db.update(settings).set({ name: 'Local User' }).run();
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(db, identity, connectPeer);
    const [, , req] = connectPeer.mock.calls[0] as Parameters<ConnectPeerFn>;
    expect(req).toEqual({ name: 'Local User', password: 'secret123' });
  });

  it('omits the password field when no remotePassword was stored', async () => {
    insertFriend({ name: 'Eli', address: '10.0.0.13', port: 7734, status: 'OUTGOING_PENDING' });
    db.update(settings).set({ name: 'Local User' }).run();
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(db, identity, connectPeer);
    const [, , req] = connectPeer.mock.calls[0] as Parameters<ConnectPeerFn>;
    expect(req).toEqual({ name: 'Local User' });
    expect(req).not.toHaveProperty('password');
  });

  it('does not leave the dialing set stuck when connectPeer throws synchronously', async () => {
    insertFriend({
      name: 'Ivy',
      address: '10.0.0.9',
      port: 7734,
      nodeId: 'ivy-id',
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    });
    const connectPeer = jest.fn(() => {
      throw new Error('sync boom');
    }) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);
    await new Promise<void>((r) => setTimeout(r, 10));
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(2);
  });

  it('does not dial INCOMING_PENDING or BLOCKED friends', async () => {
    const now = new Date();
    db.insert(friends)
      .values([
        {
          id: randomUUID(),
          name: 'Dave',
          address: '10.0.0.4',
          port: 7734,
          nodeId: 'dave-id',
          status: 'INCOMING_PENDING',
          addedAt: now,
          updatedAt: now,
        },
        {
          id: randomUUID(),
          name: 'Eve',
          address: '10.0.0.5',
          port: 7734,
          nodeId: 'eve-id',
          status: 'BLOCKED',
          addedAt: now,
          updatedAt: now,
        },
      ])
      .run();
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).not.toHaveBeenCalled();
  });

  it('skips a friend whose address:port is already being dialed', async () => {
    insertFriend({
      name: 'Frank',
      address: '10.0.0.6',
      port: 7734,
      nodeId: 'frank-id',
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    });
    let resolveFirst!: (peer: ConnectedPeer) => void;
    const slowConnection = new Promise<ConnectedPeer>((r) => {
      resolveFirst = r;
    });
    const connectPeer = jest
      .fn<ConnectPeerFn>()
      .mockReturnValueOnce(slowConnection)
      .mockResolvedValue({} as ConnectedPeer);
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);
    resolveFirst({} as ConnectedPeer);
    await new Promise<void>((r) => setTimeout(r, 10));
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(2);
  });

  it('dials multiple offline friends in a single pass', async () => {
    const now = new Date();
    db.insert(friends)
      .values([
        {
          id: randomUUID(),
          name: 'Grace',
          address: '10.0.0.7',
          port: 7734,
          nodeId: 'grace-id',
          status: 'ACCEPTED',
          acceptedAt: now,
          addedAt: now,
          updatedAt: now,
        },
        {
          id: randomUUID(),
          name: 'Hank',
          address: '10.0.0.8',
          port: 7734,
          nodeId: 'hank-id',
          status: 'ACCEPTED',
          acceptedAt: now,
          addedAt: now,
          updatedAt: now,
        },
      ])
      .run();
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(db, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(2);
  });

  it('logs a dial failure once, stays quiet on repeats, and logs recovery', async () => {
    insertFriend({
      name: 'Jack',
      address: '10.0.0.10',
      port: 7734,
      nodeId: 'jack-id',
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const failing = jest.fn(() =>
        Promise.reject(new Error('connection refused')),
      ) as jest.Mock<ConnectPeerFn>;
      await reconnectOnce(db, identity, failing);
      await new Promise<void>((r) => setTimeout(r, 10));
      await reconnectOnce(db, identity, failing);
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(failing).toHaveBeenCalledTimes(2);
      expect(errSpy).toHaveBeenCalledTimes(1);
      const succeeding = jest.fn(() =>
        Promise.resolve({} as ConnectedPeer),
      ) as jest.Mock<ConnectPeerFn>;
      await reconnectOnce(db, identity, succeeding);
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('connected'));
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('prunes failure-log suppression for removed friends so a re-added friend logs again', async () => {
    const kateData = {
      name: 'Kate',
      address: '10.0.0.11',
      port: 7734,
      nodeId: 'kate-id',
      status: 'ACCEPTED' as const,
      acceptedAt: new Date(),
    };
    insertFriend(kateData);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = jest.fn(() =>
        Promise.reject(new Error('connection refused')),
      ) as jest.Mock<ConnectPeerFn>;
      await reconnectOnce(db, identity, failing);
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(errSpy).toHaveBeenCalledTimes(1);
      db.delete(friends).where(eq(friends.nodeId, 'kate-id')).run();
      await reconnectOnce(db, identity, failing);
      await new Promise<void>((r) => setTimeout(r, 10));
      insertFriend(kateData);
      await reconnectOnce(db, identity, failing);
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(errSpy).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
    }
  });
});
