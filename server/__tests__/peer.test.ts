import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { execSync } from 'child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import type { PrismaClient } from '@prisma/client';
import type { ServerWebSocket } from 'bun';

import { type ConnectedPeer, registerPeer, unregisterPeer } from '../connections';
import { DEFAULT_TTL, initiateNetworkSearch } from '../search-protocol';
import type { InnerMessage, SearchRequestMessage, SearchResultMessage } from '../types';
import { type PeerData, dispatchMessage } from '../peer';
import { createPrismaClient } from '../db';
import { indexFile } from '../indexer';

const TEST_DB_URL = 'file:./data/test-peer.db';
let prisma: PrismaClient;
let tmpDir: string;

const identity = {
  nodeId: 'local-node',
  publicKey: Buffer.alloc(32),
  privateKey: Buffer.alloc(64),
};

type MockWs = { send(d: string | Uint8Array): void; close(): void; sends: Buffer[] };

function makeMockWs(peerNodeId: string): { dispatchWs: ServerWebSocket<PeerData>; mockWs: MockWs } {
  const sends: Buffer[] = [];
  const mockWs: MockWs = {
    sends,
    send(d: string | Uint8Array) {
      sends.push(Buffer.from(d as Uint8Array));
    },
    close() {},
  };
  const dispatchWs = {
    data: {
      identity,
      prisma,
      localPort: 7734,
      state: {
        phase: 'authenticated' as const,
        sessionKey: Buffer.alloc(32),
        peerNodeId,
        peerPublicKey: Buffer.alloc(32),
      },
    },
    send: mockWs.send.bind(mockWs),
    close: mockWs.close.bind(mockWs),
    remoteAddress: '127.0.0.1',
  } as unknown as ServerWebSocket<PeerData>;
  return { dispatchWs, mockWs };
}

function captureAll(log: { peer: ConnectedPeer; msg: InnerMessage }[]) {
  return (peer: ConnectedPeer, msg: InnerMessage) => log.push({ peer, msg });
}

beforeAll(async () => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-peer-test-'));
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-peer.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.friend.deleteMany();
  await prisma.sharedFile.deleteMany();
});

// ---------------------------------------------------------------------------
// search-request auth gate
// ---------------------------------------------------------------------------

describe('dispatchMessage — search-request auth gate', () => {
  it('drops search-request from a peer with no friend record', async () => {
    const nodeId = 'stranger-' + crypto.randomUUID();
    const { dispatchWs, mockWs } = makeMockWs(nodeId);
    registerPeer(mockWs, Buffer.alloc(32), nodeId, Buffer.alloc(32), '127.0.0.1', 0);

    const dir = join(tmpDir, 'gate-stranger');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'secret.mp3'), 'data');
    await indexFile(prisma, join(dir, 'secret.mp3'));

    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: nodeId,
      query: 'secret',
      fileType: 'all',
      ttl: DEFAULT_TTL,
    };

    await dispatchMessage(dispatchWs, msg);
    unregisterPeer(nodeId);

    expect(mockWs.sends).toHaveLength(0);
  });

  it('drops search-request from a peer with INCOMING_PENDING status', async () => {
    const nodeId = 'pending-in-' + crypto.randomUUID();
    await prisma.friend.create({
      data: {
        name: 'Pending',
        address: '127.0.0.1',
        port: 7734,
        nodeId,
        status: 'INCOMING_PENDING',
      },
    });
    const { dispatchWs, mockWs } = makeMockWs(nodeId);
    registerPeer(mockWs, Buffer.alloc(32), nodeId, Buffer.alloc(32), '127.0.0.1', 0);

    const dir = join(tmpDir, 'gate-incoming');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pendingfile.mp3'), 'data');
    await indexFile(prisma, join(dir, 'pendingfile.mp3'));

    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: nodeId,
      query: 'pendingfile',
      fileType: 'all',
      ttl: DEFAULT_TTL,
    };

    await dispatchMessage(dispatchWs, msg);
    unregisterPeer(nodeId);

    expect(mockWs.sends).toHaveLength(0);
  });

  it('drops search-request from a peer with OUTGOING_PENDING status', async () => {
    const nodeId = 'pending-out-' + crypto.randomUUID();
    await prisma.friend.create({
      data: {
        name: 'Pending',
        address: '127.0.0.1',
        port: 7734,
        nodeId,
        status: 'OUTGOING_PENDING',
      },
    });
    const { dispatchWs, mockWs } = makeMockWs(nodeId);
    registerPeer(mockWs, Buffer.alloc(32), nodeId, Buffer.alloc(32), '127.0.0.1', 0);

    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: nodeId,
      query: 'anything',
      fileType: 'all',
      ttl: DEFAULT_TTL,
    };

    await dispatchMessage(dispatchWs, msg);
    unregisterPeer(nodeId);

    expect(mockWs.sends).toHaveLength(0);
  });

  it('processes search-request from an ACCEPTED friend and sends results', async () => {
    const nodeId = 'accepted-' + crypto.randomUUID();
    await prisma.friend.create({
      data: { name: 'Friend', address: '127.0.0.1', port: 7734, nodeId, status: 'ACCEPTED' },
    });
    const { dispatchWs, mockWs } = makeMockWs(nodeId);
    registerPeer(mockWs, Buffer.alloc(32), nodeId, Buffer.alloc(32), '127.0.0.1', 0);

    const dir = join(tmpDir, 'gate-accepted');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'shared.mp3'), 'data');
    await indexFile(prisma, join(dir, 'shared.mp3'));

    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: nodeId,
      query: 'shared',
      fileType: 'all',
      ttl: 1,
    };

    await dispatchMessage(dispatchWs, msg);
    unregisterPeer(nodeId);

    expect(mockWs.sends.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// search-result auth gate
// ---------------------------------------------------------------------------

describe('dispatchMessage — search-result auth gate', () => {
  it('drops search-result that would inject into a pending search from a non-friend', async () => {
    const intruderNodeId = 'intruder-' + crypto.randomUUID();
    // no friend record for intruder

    // Start a network search to get a live searchId
    const dummyPeer = {
      peerNodeId: 'dummy',
      peerPublicKey: Buffer.alloc(32),
      address: '127.0.0.1',
      port: 7734,
      sessionKey: Buffer.alloc(32),
      ws: { send() {}, close() {} },
    } as ConnectedPeer;
    const searchSent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const searchPromise = initiateNetworkSearch(
      identity,
      [dummyPeer],
      { query: 'inject-test', fileType: 'all' },
      200,
      captureAll(searchSent),
    );

    await Bun.sleep(10);
    const searchId = (searchSent[0].msg as SearchRequestMessage).searchId;

    const { dispatchWs, mockWs } = makeMockWs(intruderNodeId);
    registerPeer(mockWs, Buffer.alloc(32), intruderNodeId, Buffer.alloc(32), '127.0.0.1', 0);

    const resultMsg: SearchResultMessage = {
      type: 'search-result',
      searchId,
      fromNodeId: intruderNodeId,
      results: [
        {
          filename: 'injected.mp3',
          size: '100',
          sha256: 'f'.repeat(64),
          mimeType: null,
          metadata: null,
        },
      ],
    };

    await dispatchMessage(dispatchWs, resultMsg);
    unregisterPeer(intruderNodeId);

    const results = await searchPromise;
    expect(results.find((r) => r.sha256 === 'f'.repeat(64))).toBeUndefined();
  });

  it('accepts search-result from an ACCEPTED friend', async () => {
    const friendNodeId = 'friend-result-' + crypto.randomUUID();
    await prisma.friend.create({
      data: {
        name: 'Friend',
        address: '127.0.0.1',
        port: 7734,
        nodeId: friendNodeId,
        status: 'ACCEPTED',
      },
    });

    const dummyPeer = {
      peerNodeId: 'dummy2',
      peerPublicKey: Buffer.alloc(32),
      address: '127.0.0.1',
      port: 7734,
      sessionKey: Buffer.alloc(32),
      ws: { send() {}, close() {} },
    } as ConnectedPeer;
    const searchSent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const searchPromise = initiateNetworkSearch(
      identity,
      [dummyPeer],
      { query: 'friend-result-test', fileType: 'all' },
      200,
      captureAll(searchSent),
    );

    await Bun.sleep(10);
    const searchId = (searchSent[0].msg as SearchRequestMessage).searchId;

    const { dispatchWs, mockWs } = makeMockWs(friendNodeId);
    registerPeer(mockWs, Buffer.alloc(32), friendNodeId, Buffer.alloc(32), '127.0.0.1', 0);

    const resultMsg: SearchResultMessage = {
      type: 'search-result',
      searchId,
      fromNodeId: friendNodeId,
      results: [
        {
          filename: 'legit.mp3',
          size: '200',
          sha256: '0'.repeat(64),
          mimeType: null,
          metadata: null,
        },
      ],
    };

    await dispatchMessage(dispatchWs, resultMsg);
    unregisterPeer(friendNodeId);

    const results = await searchPromise;
    expect(results.find((r) => r.sha256 === '0'.repeat(64))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// viaNodeId attribution
// ---------------------------------------------------------------------------

describe('dispatchMessage — viaNodeId attribution', () => {
  it('preserves producer fromNodeId and tags viaNodeId with the authenticated sender', async () => {
    const friendNodeId = 'spoof-friend-' + crypto.randomUUID();
    await prisma.friend.create({
      data: {
        name: 'Friend',
        address: '127.0.0.1',
        port: 7734,
        nodeId: friendNodeId,
        status: 'ACCEPTED',
      },
    });

    const dummyPeer = {
      peerNodeId: 'dummy-spoof',
      peerPublicKey: Buffer.alloc(32),
      address: '127.0.0.1',
      port: 7734,
      sessionKey: Buffer.alloc(32),
      ws: { send() {}, close() {} },
    } as ConnectedPeer;
    const searchSent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const searchPromise = initiateNetworkSearch(
      identity,
      [dummyPeer],
      { query: 'spoof-test', fileType: 'all' },
      200,
      captureAll(searchSent),
    );

    await Bun.sleep(10);
    const searchId = (searchSent[0].msg as SearchRequestMessage).searchId;

    const { dispatchWs, mockWs } = makeMockWs(friendNodeId);
    registerPeer(mockWs, Buffer.alloc(32), friendNodeId, Buffer.alloc(32), '127.0.0.1', 0);

    // Friend tries to claim the result came from 'impersonated-node', not themselves
    const resultMsg: SearchResultMessage = {
      type: 'search-result',
      searchId,
      fromNodeId: 'impersonated-node',
      results: [
        {
          filename: 'spoofed.mp3',
          size: '100',
          sha256: '2'.repeat(64),
          mimeType: null,
          metadata: null,
        },
      ],
    };

    await dispatchMessage(dispatchWs, resultMsg);
    unregisterPeer(friendNodeId);

    const results = await searchPromise;
    const found = results.find((r) => r.sha256 === '2'.repeat(64));
    expect(found).toBeDefined();
    // fromNodeId is preserved so multi-hop results retain correct producer attribution
    expect(found?.nodeId).toBe('impersonated-node');
    // viaNodeId is the authenticated sender — lets callers verify the relay chain
    expect(found?.viaNodeId).toBe(friendNodeId);
  });
});
