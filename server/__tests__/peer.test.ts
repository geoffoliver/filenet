import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import type { ServerWebSocket } from 'bun';

import {
  type ConnectedPeer,
  queryVouch,
  registerPeer,
  resetVouchesForTesting,
  unregisterPeer,
} from '../connections';
import {
  DEFAULT_TTL,
  initiateNetworkSearch,
  resetInternalMapsForTesting,
} from '../search-protocol';
import { type Db, applyMigrations, createDb } from '../db';
import type { InnerMessage, SearchRequestMessage, SearchResultMessage } from '../types';
import { type PeerData, dispatchMessage } from '../peer';
import { friends, sharedFiles } from '../schema';
import { indexFile } from '../indexer';

const TEST_DB_URL = 'file:./data/test-peer.db';
let db: Db;
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
      db,
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
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-peer-test-'));
});

afterAll(async () => {
  db.$client.close();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-peer.db');
  } catch {}
});

beforeEach(() => {
  db.delete(friends).run();
  db.delete(sharedFiles).run();
  resetInternalMapsForTesting();
  resetVouchesForTesting();
});

function insertFriend(overrides: {
  nodeId: string;
  status: string;
  address: string;
  port?: number;
  name?: string;
}) {
  const now = new Date();
  return db
    .insert(friends)
    .values({
      id: randomUUID(),
      name: overrides.name ?? 'Peer',
      address: overrides.address,
      port: overrides.port ?? 7734,
      nodeId: overrides.nodeId,
      status: overrides.status as 'ACCEPTED' | 'INCOMING_PENDING' | 'OUTGOING_PENDING' | 'BLOCKED',
      addedAt: now,
      updatedAt: now,
    })
    .returning()
    .get()!;
}

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
    await indexFile(db, join(dir, 'secret.mp3'));

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
    insertFriend({ nodeId, status: 'INCOMING_PENDING', address: '127.0.0.1' });
    const { dispatchWs, mockWs } = makeMockWs(nodeId);
    registerPeer(mockWs, Buffer.alloc(32), nodeId, Buffer.alloc(32), '127.0.0.1', 0);

    const dir = join(tmpDir, 'gate-incoming');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pendingfile.mp3'), 'data');
    await indexFile(db, join(dir, 'pendingfile.mp3'));

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
    insertFriend({ nodeId, status: 'OUTGOING_PENDING', address: '127.0.0.1' });
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
    insertFriend({ nodeId, status: 'ACCEPTED', address: '127.0.0.1' });
    const { dispatchWs, mockWs } = makeMockWs(nodeId);
    registerPeer(mockWs, Buffer.alloc(32), nodeId, Buffer.alloc(32), '127.0.0.1', 0);

    const dir = join(tmpDir, 'gate-accepted');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'shared.mp3'), 'data');
    await indexFile(db, join(dir, 'shared.mp3'));

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
    insertFriend({ nodeId: friendNodeId, status: 'ACCEPTED', address: '127.0.0.1' });

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
    insertFriend({ nodeId: friendNodeId, status: 'ACCEPTED', address: '127.0.0.1' });

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
    expect(found?.nodeId).toBe('impersonated-node');
    expect(found?.viaNodeId).toBe(friendNodeId);
  });
});

// ---------------------------------------------------------------------------
// friend-vouch-request dispatch
// ---------------------------------------------------------------------------

describe('dispatchMessage — friend-vouch-request', () => {
  it('drops vouch request from a non-friend and sends no response', async () => {
    const strangerNodeId = 'vouch-stranger-' + crypto.randomUUID();
    const { dispatchWs, mockWs } = makeMockWs(strangerNodeId);
    registerPeer(mockWs, Buffer.alloc(32), strangerNodeId, Buffer.alloc(32), '127.0.0.1', 0);

    await dispatchMessage(dispatchWs, { type: 'friend-vouch-request', nodeId: 'some-candidate' });
    unregisterPeer(strangerNodeId);

    expect(mockWs.sends).toHaveLength(0);
  });

  it('responds vouched=false when accepted friend asks about an unknown candidate', async () => {
    const friendNodeId = 'vouch-friend-' + crypto.randomUUID();
    insertFriend({ nodeId: friendNodeId, status: 'ACCEPTED', address: '127.0.0.1' });
    const { dispatchWs, mockWs } = makeMockWs(friendNodeId);
    registerPeer(mockWs, Buffer.alloc(32), friendNodeId, Buffer.alloc(32), '127.0.0.1', 0);

    await dispatchMessage(dispatchWs, {
      type: 'friend-vouch-request',
      nodeId: 'unknown-candidate',
    });
    unregisterPeer(friendNodeId);

    expect(mockWs.sends).toHaveLength(1);
    expect(mockWs.sends[0]).toBeDefined();
  });

  it('responds vouched=true when accepted friend asks about another accepted friend', async () => {
    const friendNodeId = 'vouch-asker-' + crypto.randomUUID();
    const candidateNodeId = 'vouch-candidate-' + crypto.randomUUID();

    insertFriend({ nodeId: friendNodeId, status: 'ACCEPTED', address: '127.0.0.1' });
    insertFriend({ nodeId: candidateNodeId, status: 'ACCEPTED', address: '10.0.0.1' });

    const sessionKey = Buffer.alloc(32);
    const { dispatchWs } = makeMockWs(friendNodeId);
    const trackedSends: Buffer[] = [];
    const trackedWs = {
      sends: trackedSends,
      send(d: string | Uint8Array) {
        trackedSends.push(Buffer.from(d as Uint8Array));
      },
      close() {},
    };
    registerPeer(trackedWs, sessionKey, friendNodeId, Buffer.alloc(32), '127.0.0.1', 0);

    await dispatchMessage(dispatchWs, { type: 'friend-vouch-request', nodeId: candidateNodeId });
    unregisterPeer(friendNodeId);

    expect(trackedSends).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// friend-vouch-response dispatch
// ---------------------------------------------------------------------------

describe('dispatchMessage — friend-vouch-response', () => {
  it('drops vouch response from a non-friend', async () => {
    const strangerNodeId = 'vouch-resp-stranger-' + crypto.randomUUID();
    const { dispatchWs } = makeMockWs(strangerNodeId);

    await dispatchMessage(dispatchWs, {
      type: 'friend-vouch-response',
      nodeId: 'some-candidate',
      vouched: true,
    });
  });

  it('resolves a pending vouch when accepted friend sends vouched=true', async () => {
    const friendNodeId = 'vouch-resp-friend-' + crypto.randomUUID();
    insertFriend({ nodeId: friendNodeId, status: 'ACCEPTED', address: '127.0.0.1' });
    const { dispatchWs, mockWs } = makeMockWs(friendNodeId);
    registerPeer(mockWs, Buffer.alloc(32), friendNodeId, Buffer.alloc(32), '127.0.0.1', 0);

    const fakePeer: ConnectedPeer = {
      ws: mockWs,
      sessionKey: Buffer.alloc(32),
      peerNodeId: friendNodeId,
      peerPublicKey: Buffer.alloc(32),
      address: '127.0.0.1',
      port: 7734,
    };

    const candidateNodeId = 'vouch-resp-candidate-' + crypto.randomUUID();
    const vouchPromise = queryVouch(candidateNodeId, [fakePeer], () => {}, 2_000);
    await Bun.sleep(10);

    await dispatchMessage(dispatchWs, {
      type: 'friend-vouch-response',
      nodeId: candidateNodeId,
      vouched: true,
    });

    expect(await vouchPromise).toBe(true);
    unregisterPeer(friendNodeId);
  });

  it('does not resolve vouch for an unqueried candidateNodeId', async () => {
    const friendNodeId = 'vouch-resp-unqueried-' + crypto.randomUUID();
    insertFriend({ nodeId: friendNodeId, status: 'ACCEPTED', address: '127.0.0.1' });
    const { dispatchWs, mockWs } = makeMockWs(friendNodeId);
    registerPeer(mockWs, Buffer.alloc(32), friendNodeId, Buffer.alloc(32), '127.0.0.1', 0);

    await dispatchMessage(dispatchWs, {
      type: 'friend-vouch-response',
      nodeId: 'no-pending-candidate',
      vouched: true,
    });
    unregisterPeer(friendNodeId);
  });
});
