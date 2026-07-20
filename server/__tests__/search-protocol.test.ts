import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import {
  DEFAULT_TTL,
  MAX_MAP_SIZE,
  MAX_NETWORK_RESULTS,
  MAX_RESULTS_PER_SENDER,
  type NetworkResult,
  ROUTE_EXPIRY_MS,
  SETTLE_TIMEOUT_MS,
  getInternalMapSizes,
  handleSearchRequest,
  handleSearchResult,
  initiateNetworkSearch,
  resetInternalMapsForTesting,
} from '../search-protocol';
import { type Db, applyMigrations, createDb } from '../db';
import type { InnerMessage, SearchRequestMessage, SearchResultMessage } from '../types';
import { registerPeer, unregisterPeer } from '../connections';
import type { ConnectedPeer } from '../connections';
import type { Identity } from '../identity';
import { indexFile } from '../indexer';
import { sharedFiles } from '../schema';

const TEST_DB_URL = 'file:./data/test-search-protocol.db';
let db: Db;
let tmpDir: string;

const identity: Identity = {
  nodeId: 'test-node-id',
  publicKey: Buffer.alloc(32),
  privateKey: Buffer.alloc(64),
};

function makePeer(nodeId: string): ConnectedPeer & { sent: InnerMessage[] } {
  const sent: InnerMessage[] = [];
  return {
    peerNodeId: nodeId,
    peerPublicKey: Buffer.alloc(32),
    address: '127.0.0.1',
    port: 7734,
    sessionKey: Buffer.alloc(32),
    ws: { send() {}, close() {} },
    sent,
  };
}

function captureAll(log: { peer: ConnectedPeer; msg: InnerMessage }[]) {
  return (peer: ConnectedPeer, msg: InnerMessage) => log.push({ peer, msg });
}

beforeAll(async () => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-search-proto-'));
});

afterAll(async () => {
  db.$client.close();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-search-protocol.db');
  } catch {}
});

beforeEach(() => {
  db.delete(sharedFiles).run();
  resetInternalMapsForTesting();
});

describe('handleSearchRequest', () => {
  it('returns local results to the sender', async () => {
    const dir = join(tmpDir, 'hsr-basic');
    await mkdir(dir);
    const filePath = join(dir, 'hello.mp3');
    await writeFile(filePath, 'fake audio');
    await indexFile(db, filePath);

    const fromPeer = makePeer('peer-A');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'peer-A',
      query: 'hello',
      fileType: 'all',
      ttl: DEFAULT_TTL,
    };

    await handleSearchRequest(msg, db, identity, fromPeer, [], captureAll(sent));

    expect(sent).toHaveLength(1);
    expect(sent[0].peer.peerNodeId).toBe('peer-A');
    const result = sent[0].msg as SearchResultMessage;
    expect(result.type).toBe('search-result');
    expect(result.searchId).toBe(msg.searchId);
    expect(result.fromNodeId).toBe(identity.nodeId);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0].filename).toBe('hello.mp3');
  });

  it('sends no result when query matches nothing', async () => {
    const fromPeer = makePeer('peer-B');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'peer-B',
      query: 'zzz-nothing-matches-zzz',
      fileType: 'all',
      ttl: DEFAULT_TTL,
    };
    await handleSearchRequest(msg, db, identity, fromPeer, [], captureAll(sent));
    expect(sent).toHaveLength(0);
  });

  it('forwards the request to other peers with TTL decremented', async () => {
    const fromPeer = makePeer('peer-C');
    const forwardPeer = makePeer('peer-D');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'peer-C',
      query: 'anything',
      fileType: 'all',
      ttl: 2,
    };
    await handleSearchRequest(
      msg,
      db,
      identity,
      fromPeer,
      [fromPeer, forwardPeer],
      captureAll(sent),
    );
    const forwarded = sent.filter((s) => s.peer.peerNodeId === 'peer-D');
    expect(forwarded).toHaveLength(1);
    expect((forwarded[0].msg as SearchRequestMessage).ttl).toBe(1);
  });

  it('does not forward when TTL is 1 (terminal hop)', async () => {
    const fromPeer = makePeer('peer-E');
    const otherPeer = makePeer('peer-F');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'peer-E',
      query: 'test',
      fileType: 'all',
      ttl: 1,
    };
    await handleSearchRequest(msg, db, identity, fromPeer, [fromPeer, otherPeer], captureAll(sent));
    expect(sent.filter((s) => s.peer.peerNodeId === 'peer-F')).toHaveLength(0);
  });

  it('drops a request with TTL=0 without processing', async () => {
    const fromPeer = makePeer('peer-E0');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'peer-E0',
      query: 'test',
      fileType: 'all',
      ttl: 0,
    };
    await handleSearchRequest(msg, db, identity, fromPeer, [fromPeer], captureAll(sent));
    expect(sent).toHaveLength(0);
  });

  it('drops a duplicate search ID (cycle prevention)', async () => {
    const fromPeer = makePeer('peer-G');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'peer-G',
      query: 'test',
      fileType: 'all',
      ttl: DEFAULT_TTL,
    };
    await handleSearchRequest(msg, db, identity, fromPeer, [], captureAll(sent));
    sent.length = 0;
    await handleSearchRequest(msg, db, identity, fromPeer, [], captureAll(sent));
    expect(sent).toHaveLength(0);
  });

  it('does not forward back to the peer that sent the request', async () => {
    const fromPeer = makePeer('peer-H');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'peer-H',
      query: 'test',
      fileType: 'all',
      ttl: 3,
    };
    await handleSearchRequest(msg, db, identity, fromPeer, [fromPeer], captureAll(sent));
    expect(
      sent.filter((s) => (s.msg as SearchRequestMessage).type === 'search-request'),
    ).toHaveLength(0);
  });

  it('truncates filename, mimeType, and metadata to schema limits before sending', async () => {
    const now = new Date();
    db.insert(sharedFiles)
      .values({
        id: randomUUID(),
        path: '/trunc/file.bin',
        filename: 'trunc_' + 'y'.repeat(1000),
        size: 100n,
        sha256: 'd'.repeat(64),
        mimeType: 'audio/' + 'z'.repeat(200),
        metadata: 'M'.repeat(5000),
        lastSeenAt: now,
        indexedAt: now,
        updatedAt: now,
      })
      .run();

    const fromPeer = makePeer('peer-trunc');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'peer-trunc',
      query: 'trunc_',
      fileType: 'all',
      ttl: 1,
    };
    await handleSearchRequest(msg, db, identity, fromPeer, [], captureAll(sent));
    expect(sent).toHaveLength(1);
    const item = (sent[0].msg as SearchResultMessage).results.find(
      (r) => r.sha256 === 'd'.repeat(64),
    )!;
    expect(item.filename.length).toBeLessThanOrEqual(1000);
    expect(item.mimeType!.length).toBeLessThanOrEqual(200);
    expect(item.metadata).toBeNull();
  });

  it('swallows sendFn error when sending results to requester', async () => {
    const dir = join(tmpDir, 'send-err-result');
    await mkdir(dir);
    await writeFile(join(dir, 'errfile.mp3'), 'data');
    await indexFile(db, join(dir, 'errfile.mp3'));
    const fromPeer = makePeer('peer-send-err');
    const throwFn = () => {
      throw new Error('send failed');
    };
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'peer-send-err',
      query: 'errfile',
      fileType: 'all',
      ttl: 1,
    };
    await expect(
      handleSearchRequest(msg, db, identity, fromPeer, [], throwFn),
    ).resolves.toBeUndefined();
  });

  it('drops route and skips forwarding when requester disconnects during result send', async () => {
    const dir = join(tmpDir, 'send-err-fwd');
    await mkdir(dir);
    await writeFile(join(dir, 'fwdfile.mp3'), 'data');
    await indexFile(db, join(dir, 'fwdfile.mp3'));
    const fromPeer = makePeer('disconnected-requester');
    const fwdPeer = makePeer('forward-target');
    let forwardCount = 0;
    const throwOnResultFn = (_peer: ConnectedPeer, msg: InnerMessage) => {
      if ((msg as SearchResultMessage).type === 'search-result') throw new Error('requester gone');
      forwardCount++;
    };
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'disconnected-requester',
      query: 'fwdfile',
      fileType: 'all',
      ttl: 2,
    };
    await handleSearchRequest(msg, db, identity, fromPeer, [fwdPeer], throwOnResultFn);
    expect(forwardCount).toBe(0);
    expect(getInternalMapSizes().searchRoutes).toBe(0);
  });

  it('keeps seenSearchIds and searchRoutes at or below MAX_MAP_SIZE under a burst of unique IDs', async () => {
    const fromPeer = makePeer('flood-peer');
    const noop = () => {};
    for (let i = 0; i < MAX_MAP_SIZE + 100; i++) {
      await handleSearchRequest(
        {
          type: 'search-request',
          searchId: crypto.randomUUID(),
          originNodeId: 'flood-peer',
          query: 'flood',
          fileType: 'all',
          ttl: 2,
        },
        db,
        identity,
        fromPeer,
        [],
        noop,
      );
    }
    const sizes = getInternalMapSizes();
    expect(sizes.seenSearchIds).toBeLessThanOrEqual(MAX_MAP_SIZE);
    expect(sizes.searchRoutes).toBeLessThanOrEqual(MAX_MAP_SIZE);
  });

  it('does not exceed MAX_MAP_SIZE in seenSearchIds when all entries are protected from eviction', async () => {
    const peers = Array.from({ length: 1 }, (_, i) => makePeer(`protected-peer-${i}`));
    const promises: Promise<NetworkResult[]>[] = [];
    for (let i = 0; i < MAX_MAP_SIZE; i++) {
      promises.push(
        initiateNetworkSearch(identity, peers, { query: 'fill', fileType: 'all' }, 200, () => {}),
      );
    }
    const fromPeer = makePeer('overflow-peer');
    await handleSearchRequest(
      {
        type: 'search-request',
        searchId: crypto.randomUUID(),
        originNodeId: 'overflow-peer',
        query: 'overflow',
        fileType: 'all',
        ttl: 1,
      },
      db,
      identity,
      fromPeer,
      [],
      () => {},
    );
    expect(getInternalMapSizes().seenSearchIds).toBeLessThanOrEqual(MAX_MAP_SIZE);
    await Promise.all(promises);
  });

  it('swallows sendFn error when forwarding request to peers', async () => {
    const fromPeer = makePeer('peer-fwd-err-from');
    const toPeer = makePeer('peer-fwd-err-to');
    const throwFn = () => {
      throw new Error('send failed');
    };
    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'peer-fwd-err-from',
      query: 'anything',
      fileType: 'all',
      ttl: 2,
    };
    await expect(
      handleSearchRequest(msg, db, identity, fromPeer, [fromPeer, toPeer], throwFn),
    ).resolves.toBeUndefined();
  });
});

describe('handleSearchResult', () => {
  it('collects results into a pending search', async () => {
    const peers = [makePeer('relay-1')];
    const networkResultsPromise = initiateNetworkSearch(
      identity,
      peers,
      { query: 'test', fileType: 'all' },
      500,
      captureAll([]),
    );
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const networkResultsPromise2 = initiateNetworkSearch(
      identity,
      peers,
      { query: 'find-me', fileType: 'all' },
      200,
      captureAll(sent),
    );
    await Bun.sleep(10);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'relay-1',
      results: [
        {
          filename: 'found.mp3',
          size: '1234',
          sha256: 'a'.repeat(64),
          mimeType: 'audio/mpeg',
          metadata: null,
        },
      ],
    });
    const results = await networkResultsPromise2;
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('found.mp3');
    expect(results[0].nodeId).toBe('relay-1');
    await networkResultsPromise;
  });

  it('relays results back up the chain to the return peer', async () => {
    const returnPeer = makePeer('upstream');
    registerPeer(
      returnPeer.ws,
      returnPeer.sessionKey,
      'upstream',
      returnPeer.peerPublicKey,
      '127.0.0.1',
      7734,
    );
    try {
      const relayMsg: SearchRequestMessage = {
        type: 'search-request',
        searchId: crypto.randomUUID(),
        originNodeId: 'origin-node',
        query: 'relay-test',
        fileType: 'all',
        ttl: 2,
      };
      await handleSearchRequest(relayMsg, db, identity, returnPeer, [], captureAll([]));
      const relayed: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
      handleSearchResult(
        {
          type: 'search-result',
          searchId: relayMsg.searchId,
          fromNodeId: 'downstream',
          results: [
            {
              filename: 'relay.txt',
              size: '99',
              sha256: 'b'.repeat(64),
              mimeType: 'text/plain',
              metadata: null,
            },
          ],
        },
        captureAll(relayed),
      );
      expect(relayed).toHaveLength(1);
      expect(relayed[0].peer.peerNodeId).toBe('upstream');
      expect((relayed[0].msg as SearchResultMessage).results[0].filename).toBe('relay.txt');
    } finally {
      unregisterPeer('upstream');
    }
  });

  it('drops results for an expired route and removes the route', async () => {
    const returnPeer = makePeer('upstream-expired');
    registerPeer(
      returnPeer.ws,
      returnPeer.sessionKey,
      'upstream-expired',
      returnPeer.peerPublicKey,
      '127.0.0.1',
      7734,
    );
    try {
      const relayMsg: SearchRequestMessage = {
        type: 'search-request',
        searchId: crypto.randomUUID(),
        originNodeId: 'origin-expired',
        query: 'expired',
        fileType: 'all',
        ttl: 2,
      };
      await handleSearchRequest(relayMsg, db, identity, returnPeer, [], captureAll([]));
      const expiredAt = Date.now() + ROUTE_EXPIRY_MS + 1;
      jest.useFakeTimers();
      jest.setSystemTime(expiredAt);
      try {
        const relayed: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
        handleSearchResult(
          {
            type: 'search-result',
            searchId: relayMsg.searchId,
            fromNodeId: 'downstream',
            results: [
              {
                filename: 'f.mp3',
                size: '1',
                sha256: '1'.repeat(64),
                mimeType: null,
                metadata: null,
              },
            ],
          },
          captureAll(relayed),
        );
        expect(relayed).toHaveLength(0);
        expect(getInternalMapSizes().searchRoutes).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    } finally {
      unregisterPeer('upstream-expired');
    }
  });

  it('ignores results for unknown search IDs', () => {
    const relayed: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    handleSearchResult(
      { type: 'search-result', searchId: crypto.randomUUID(), fromNodeId: 'someone', results: [] },
      captureAll(relayed),
    );
    expect(relayed).toHaveLength(0);
  });

  it('frees dead relay route when return peer has disconnected', async () => {
    const gonePeer = makePeer('gone-upstream');
    const relayMsg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'origin',
      query: 'gone',
      fileType: 'all',
      ttl: 2,
    };
    await handleSearchRequest(relayMsg, db, identity, gonePeer, [], captureAll([]));
    expect(getInternalMapSizes().searchRoutes).toBe(1);
    const relayed: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    handleSearchResult(
      {
        type: 'search-result',
        searchId: relayMsg.searchId,
        fromNodeId: 'downstream',
        results: [
          { filename: 'f.mp3', size: '1', sha256: '2'.repeat(64), mimeType: null, metadata: null },
        ],
      },
      captureAll(relayed),
    );
    expect(relayed).toHaveLength(0);
    expect(getInternalMapSizes().searchRoutes).toBe(0);
  });

  it('frees relay route on sendFn failure and does not throw', async () => {
    const returnPeer = makePeer('upstream-err');
    registerPeer(
      returnPeer.ws,
      returnPeer.sessionKey,
      'upstream-err',
      returnPeer.peerPublicKey,
      '127.0.0.1',
      7734,
    );
    try {
      const relayMsg: SearchRequestMessage = {
        type: 'search-request',
        searchId: crypto.randomUUID(),
        originNodeId: 'origin',
        query: 'relay-err',
        fileType: 'all',
        ttl: 2,
      };
      await handleSearchRequest(relayMsg, db, identity, returnPeer, [], captureAll([]));
      expect(getInternalMapSizes().searchRoutes).toBe(1);
      const throwFn = () => {
        throw new Error('relay send failed');
      };
      expect(() =>
        handleSearchResult(
          {
            type: 'search-result',
            searchId: relayMsg.searchId,
            fromNodeId: 'downstream',
            results: [
              {
                filename: 'a.mp3',
                size: '100',
                sha256: 'e'.repeat(64),
                mimeType: null,
                metadata: null,
              },
            ],
          },
          throwFn,
        ),
      ).not.toThrow();
      expect(getInternalMapSizes().searchRoutes).toBe(0);
    } finally {
      unregisterPeer('upstream-err');
    }
  });

  it('does not conflate distinct (fromNodeId, sha256) pairs when fromNodeId contains a colon', async () => {
    const peer = makePeer('colon-peer');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const networkResultsPromise = initiateNetworkSearch(
      identity,
      [peer],
      { query: 'colon-dedup', fileType: 'all' },
      200,
      captureAll(sent),
    );
    await Bun.sleep(10);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    const sha256 = 'f'.repeat(64);
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'node:with:colons',
      results: [{ filename: 'f1.mp3', size: '1', sha256, mimeType: null, metadata: null }],
    });
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'node',
      results: [{ filename: 'f2.mp3', size: '1', sha256, mimeType: null, metadata: null }],
    });
    const results = await networkResultsPromise;
    expect(results.filter((r) => r.sha256 === sha256)).toHaveLength(2);
  });
});

describe('initiateNetworkSearch', () => {
  it('returns empty immediately when there are no peers', async () => {
    const results = await initiateNetworkSearch(identity, [], { query: 'test', fileType: 'all' });
    expect(results).toEqual([]);
  });

  it('resolves after timeout with whatever results arrived', async () => {
    const peer = makePeer('slow-peer');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const start = Date.now();
    const results = await initiateNetworkSearch(
      identity,
      [peer],
      { query: 'timeout-test', fileType: 'all' },
      100,
      captureAll(sent),
    );
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
    expect(results).toEqual([]);
  });

  it('resolves early after settle timeout when results arrive before the main timeout', async () => {
    const peer = makePeer('settle-peer');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const settleMs = 50;
    const start = Date.now();
    const networkResultsPromise = initiateNetworkSearch(
      identity,
      [peer],
      { query: 'settle-test', fileType: 'all' },
      5_000,
      captureAll(sent),
      settleMs,
    );
    await Bun.sleep(10);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'settle-peer',
      results: [
        {
          filename: 'a.mp3',
          size: '100',
          sha256: 'a'.repeat(64),
          mimeType: 'audio/mpeg',
          metadata: null,
        },
      ],
    });
    const results = await networkResultsPromise;
    expect(results).toHaveLength(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(settleMs);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('resets settle timer when a second result batch arrives before settle fires', async () => {
    const peer = makePeer('settle-reset-peer');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const networkResultsPromise = initiateNetworkSearch(
      identity,
      [peer],
      { query: 'settle-reset', fileType: 'all' },
      5_000,
      captureAll(sent),
      100,
    );
    await Bun.sleep(10);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'settle-reset-peer',
      results: [
        {
          filename: 'a.mp3',
          size: '100',
          sha256: 'a'.repeat(64),
          mimeType: 'audio/mpeg',
          metadata: null,
        },
      ],
    });
    await Bun.sleep(50);
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'settle-reset-peer-2',
      results: [
        {
          filename: 'b.mp3',
          size: '200',
          sha256: 'b'.repeat(64),
          mimeType: 'audio/mpeg',
          metadata: null,
        },
      ],
    });
    const results = await networkResultsPromise;
    expect(results).toHaveLength(2);
  });

  it('SETTLE_TIMEOUT_MS constant is exported and positive', () => {
    expect(SETTLE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('deduplicates results with the same sha256 from the same node', async () => {
    const peer = makePeer('dedup-peer');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const networkResultsPromise = initiateNetworkSearch(
      identity,
      [peer],
      { query: 'dedup', fileType: 'all' },
      200,
      captureAll(sent),
    );
    await Bun.sleep(10);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    const duplicate = {
      filename: 'song.mp3',
      size: '5000',
      sha256: 'c'.repeat(64),
      mimeType: 'audio/mpeg',
      metadata: null,
    };
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'dedup-peer',
      results: [duplicate],
    });
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'dedup-peer',
      results: [duplicate],
    });
    const results = await networkResultsPromise;
    expect(results.filter((r) => r.sha256 === 'c'.repeat(64))).toHaveLength(1);
  });

  it('invokes onBatch with newly added results as they arrive', async () => {
    const peer = makePeer('batch-peer');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const batches: NetworkResult[][] = [];
    const networkResultsPromise = initiateNetworkSearch(
      identity,
      [peer],
      { query: 'batch-test', fileType: 'all' },
      5_000,
      captureAll(sent),
      50,
      (batch) => batches.push(batch),
    );
    await Bun.sleep(10);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'batch-peer',
      results: [
        {
          filename: 'a.mp3',
          size: '100',
          sha256: 'a'.repeat(64),
          mimeType: 'audio/mpeg',
          metadata: null,
        },
      ],
    });
    const results = await networkResultsPromise;
    expect(results).toHaveLength(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].sha256).toBe('a'.repeat(64));
    expect(batches[0][0].nodeId).toBe('batch-peer');
  });

  it('does not invoke onBatch when a result batch adds no new results', async () => {
    const peer = makePeer('dup-batch-peer');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const batches: NetworkResult[][] = [];
    const networkResultsPromise = initiateNetworkSearch(
      identity,
      [peer],
      { query: 'dup-batch-test', fileType: 'all' },
      5_000,
      captureAll(sent),
      50,
      (batch) => batches.push(batch),
    );
    await Bun.sleep(10);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    const resultMsg: SearchResultMessage = {
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'dup-batch-peer',
      results: [
        {
          filename: 'a.mp3',
          size: '100',
          sha256: 'a'.repeat(64),
          mimeType: 'audio/mpeg',
          metadata: null,
        },
      ],
    };
    handleSearchResult(resultMsg);
    handleSearchResult(resultMsg); // duplicate — adds nothing
    const results = await networkResultsPromise;
    expect(results).toHaveLength(1);
    expect(batches).toHaveLength(1); // only the first call added anything
  });

  it('caps collected results at MAX_NETWORK_RESULTS', async () => {
    const peer = makePeer('cap-peer');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const networkResultsPromise = initiateNetworkSearch(
      identity,
      [peer],
      { query: 'cap-test', fileType: 'all' },
      200,
      captureAll(sent),
    );
    await Bun.sleep(10);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    for (let i = 0; i < MAX_NETWORK_RESULTS + 10; i++) {
      handleSearchResult({
        type: 'search-result',
        searchId: reqMsg.searchId,
        fromNodeId: 'cap-peer',
        results: [
          {
            filename: `file${i}.mp3`,
            size: '100',
            sha256: i.toString(16).padStart(64, '0'),
            mimeType: null,
            metadata: null,
          },
        ],
      });
    }
    const results = await networkResultsPromise;
    expect(results.length).toBeLessThanOrEqual(MAX_NETWORK_RESULTS);
  });

  it('caps results per authenticated sender at MAX_RESULTS_PER_SENDER', async () => {
    const peer = makePeer('flood-sender');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const networkResultsPromise = initiateNetworkSearch(
      identity,
      [peer],
      { query: 'sender-cap', fileType: 'all' },
      200,
      captureAll(sent),
    );
    await Bun.sleep(10);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    for (let i = 0; i < MAX_RESULTS_PER_SENDER + 10; i++) {
      handleSearchResult({
        type: 'search-result',
        searchId: reqMsg.searchId,
        fromNodeId: `spoofed-node-${i}`,
        viaNodeId: 'flood-sender',
        results: [
          {
            filename: `file${i}.mp3`,
            size: '100',
            sha256: i.toString(16).padStart(64, '0'),
            mimeType: null,
            metadata: null,
          },
        ],
      });
    }
    const results = await networkResultsPromise;
    expect(results.length).toBeLessThanOrEqual(MAX_RESULTS_PER_SENDER);
  });

  it('allows distinct producers behind different relays to each contribute up to the per-sender cap', async () => {
    const peer = makePeer('multi-relay-peer');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const networkResultsPromise = initiateNetworkSearch(
      identity,
      [peer],
      { query: 'multi-relay', fileType: 'all' },
      200,
      captureAll(sent),
    );
    await Bun.sleep(10);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    const sha256 = 'f'.repeat(64);
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'producer-A',
      viaNodeId: 'relay-1',
      results: [{ filename: 'song.mp3', size: '1000', sha256, mimeType: null, metadata: null }],
    });
    handleSearchResult({
      type: 'search-result',
      searchId: reqMsg.searchId,
      fromNodeId: 'producer-B',
      viaNodeId: 'relay-2',
      results: [{ filename: 'song.mp3', size: '1000', sha256, mimeType: null, metadata: null }],
    });
    const results = await networkResultsPromise;
    expect(results.filter((r) => r.sha256 === sha256)).toHaveLength(2);
  });

  it('does not throw when sendFn throws during fan-out', async () => {
    const peer = makePeer('throw-fanout-peer');
    const throwFn = () => {
      throw new Error('send failed during fan-out');
    };
    await expect(
      initiateNetworkSearch(
        identity,
        [peer],
        { query: 'throw-fanout', fileType: 'all' },
        100,
        throwFn,
      ),
    ).resolves.toEqual([]);
  });
});
