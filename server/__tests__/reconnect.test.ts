import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from 'bun:test';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';

import type { PrismaClient } from '@prisma/client';

import { reconnectOnce, resetDialingForTesting } from '../reconnect';
import { registerPeer, unregisterPeer } from '../connections';
import type { ConnectPeerFn } from '../management';
import type { ConnectedPeer } from '../connections';
import type { Identity } from '../identity';
import { createPrismaClient } from '../db';
import { getOrCreateSettings } from '../config';

const TEST_DB_URL = 'file:./data/test-reconnect.db';
let prisma: PrismaClient;

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
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    unlinkSync('./data/test-reconnect.db');
  } catch {
    // already gone
  }
});

beforeEach(async () => {
  await prisma.friend.deleteMany();
  await getOrCreateSettings(prisma); // ensure the singleton row exists for updateMany
  await prisma.settings.updateMany({ data: { name: '' } });
  resetDialingForTesting();
});

describe('reconnectOnce', () => {
  it('dials an ACCEPTED friend that is not currently connected', async () => {
    await prisma.friend.create({
      data: {
        name: 'Alice',
        address: '10.0.0.1',
        port: 7734,
        nodeId: 'alice-id',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);
    expect(connectPeer).toHaveBeenCalledWith('10.0.0.1', 7734, undefined);
  });

  it('skips an ACCEPTED friend that is already connected', async () => {
    await prisma.friend.create({
      data: {
        name: 'Bob',
        address: '10.0.0.2',
        port: 7734,
        nodeId: 'bob-id',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });
    const { ws, sessionKey, peerPublicKey } = makePeer('bob-id', '10.0.0.2', 7734);
    registerPeer(ws, sessionKey, 'bob-id', peerPublicKey, '10.0.0.2', 7734);

    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).not.toHaveBeenCalled();

    unregisterPeer('bob-id');
  });

  it('dials an OUTGOING_PENDING friend with a friend-request payload', async () => {
    await prisma.friend.create({
      data: { name: 'Charlie', address: '10.0.0.3', port: 7734, status: 'OUTGOING_PENDING' },
    });
    await prisma.settings.updateMany({ data: { name: 'Local User' } });
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);
    const [addr, port, req] = connectPeer.mock.calls[0] as Parameters<ConnectPeerFn>;
    expect(addr).toBe('10.0.0.3');
    expect(port).toBe(7734);
    expect(req).toEqual({ name: 'Local User' });
  });

  it('falls back to the local nodeId (not the remote name) when no display name is set', async () => {
    await prisma.friend.create({
      data: { name: 'Charlie', address: '10.0.0.3', port: 7734, status: 'OUTGOING_PENDING' },
    });
    await prisma.settings.updateMany({ data: { name: '' } });
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);
    const [, , req] = connectPeer.mock.calls[0] as Parameters<ConnectPeerFn>;
    expect(req).toEqual({ name: 'test-node-id' });
  });

  it('does not leave the dialing set stuck when connectPeer throws synchronously', async () => {
    await prisma.friend.create({
      data: {
        name: 'Ivy',
        address: '10.0.0.9',
        port: 7734,
        nodeId: 'ivy-id',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });
    const connectPeer = jest.fn(() => {
      throw new Error('sync boom');
    }) as jest.Mock<ConnectPeerFn>;

    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);
    // Let the rejection settle so .finally() clears the dialing set
    await new Promise<void>((r) => setTimeout(r, 10));

    // A second pass must retry — the address must not be stuck in `dialing`
    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(2);
  });

  it('does not dial INCOMING_PENDING or BLOCKED friends', async () => {
    await prisma.friend.createMany({
      data: [
        {
          name: 'Dave',
          address: '10.0.0.4',
          port: 7734,
          nodeId: 'dave-id',
          status: 'INCOMING_PENDING',
        },
        {
          name: 'Eve',
          address: '10.0.0.5',
          port: 7734,
          nodeId: 'eve-id',
          status: 'BLOCKED',
        },
      ],
    });
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).not.toHaveBeenCalled();
  });

  it('skips a friend whose address:port is already being dialed', async () => {
    await prisma.friend.create({
      data: {
        name: 'Frank',
        address: '10.0.0.6',
        port: 7734,
        nodeId: 'frank-id',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });

    let resolveFirst!: (peer: ConnectedPeer) => void;
    const slowConnection = new Promise<ConnectedPeer>((r) => {
      resolveFirst = r;
    });
    const connectPeer = jest
      .fn<ConnectPeerFn>()
      .mockReturnValueOnce(slowConnection)
      .mockResolvedValue({} as ConnectedPeer);

    // First tick — initiates the connection and marks the address as dialing
    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);

    // Second tick — connection is still in-flight, should be skipped
    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(1);

    // Resolve the first connection — removes address from the dialing set
    resolveFirst({} as ConnectedPeer);
    await new Promise<void>((r) => setTimeout(r, 10));

    // Third tick — no longer dialing, should attempt again (still not registered as connected)
    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(2);
  });

  it('dials multiple offline friends in a single pass', async () => {
    await prisma.friend.createMany({
      data: [
        {
          name: 'Grace',
          address: '10.0.0.7',
          port: 7734,
          nodeId: 'grace-id',
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
        {
          name: 'Hank',
          address: '10.0.0.8',
          port: 7734,
          nodeId: 'hank-id',
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
      ],
    });
    const connectPeer = jest.fn(() =>
      Promise.resolve({} as ConnectedPeer),
    ) as jest.Mock<ConnectPeerFn>;
    await reconnectOnce(prisma, identity, connectPeer);
    expect(connectPeer).toHaveBeenCalledTimes(2);
  });
});
