import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { execSync } from 'child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import type { PrismaClient } from '@prisma/client';

import {
  DEFAULT_TTL,
  MAX_MAP_SIZE,
  MAX_NETWORK_RESULTS,
  MAX_RESULTS_PER_SENDER,
  type NetworkResult,
  ROUTE_EXPIRY_MS,
  getInternalMapSizes,
  handleSearchRequest,
  handleSearchResult,
  initiateNetworkSearch,
  resetInternalMapsForTesting,
} from '../search-protocol';
import type { InnerMessage, SearchRequestMessage, SearchResultMessage } from '../types';
import { registerPeer, unregisterPeer } from '../connections';
import type { ConnectedPeer } from '../connections';
import type { Identity } from '../identity';
import { createPrismaClient } from '../db';
import { indexFile } from '../indexer';

const TEST_DB_URL = 'file:./data/test-search-protocol.db';
let prisma: PrismaClient;
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
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-search-proto-'));
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-search-protocol.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.sharedFile.deleteMany();
  resetInternalMapsForTesting();
});

// ---------------------------------------------------------------------------
// handleSearchRequest
// ---------------------------------------------------------------------------

describe('handleSearchRequest', () => {
  it('returns local results to the sender', async () => {
    const dir = join(tmpDir, 'hsr-basic');
    await mkdir(dir);
    const filePath = join(dir, 'hello.mp3');
    await writeFile(filePath, 'fake audio');
    await indexFile(prisma, filePath);

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

    await handleSearchRequest(msg, prisma, identity, fromPeer, [], captureAll(sent));

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

    await handleSearchRequest(msg, prisma, identity, fromPeer, [], captureAll(sent));
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
      prisma,
      identity,
      fromPeer,
      [fromPeer, forwardPeer],
      captureAll(sent),
    );

    const forwarded = sent.filter((s) => s.peer.peerNodeId === 'peer-D');
    expect(forwarded).toHaveLength(1);
    expect((forwarded[0].msg as SearchRequestMessage).ttl).toBe(1);
    expect((forwarded[0].msg as SearchRequestMessage).searchId).toBe(msg.searchId);
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

    await handleSearchRequest(
      msg,
      prisma,
      identity,
      fromPeer,
      [fromPeer, otherPeer],
      captureAll(sent),
    );

    const forwarded = sent.filter((s) => s.peer.peerNodeId === 'peer-F');
    expect(forwarded).toHaveLength(0);
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

    await handleSearchRequest(msg, prisma, identity, fromPeer, [fromPeer], captureAll(sent));

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

    await handleSearchRequest(msg, prisma, identity, fromPeer, [], captureAll(sent));
    sent.length = 0; // clear
    await handleSearchRequest(msg, prisma, identity, fromPeer, [], captureAll(sent));
    expect(sent).toHaveLength(0); // second call dropped
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

    await handleSearchRequest(
      msg,
      prisma,
      identity,
      fromPeer,
      [fromPeer], // only peer is the sender
      captureAll(sent),
    );

    const forwarded = sent.filter((s) => (s.msg as SearchRequestMessage).type === 'search-request');
    expect(forwarded).toHaveLength(0);
  });

  it('truncates filename, mimeType, and metadata to schema limits before sending', async () => {
    await prisma.sharedFile.create({
      data: {
        path: '/trunc/file.bin',
        filename: 'trunc_' + 'y'.repeat(1000),
        size: 100n,
        sha256: 'd'.repeat(64),
        mimeType: 'audio/' + 'z'.repeat(200),
        metadata: 'M'.repeat(5000),
      },
    });

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

    await handleSearchRequest(msg, prisma, identity, fromPeer, [], captureAll(sent));

    expect(sent).toHaveLength(1);
    const item = (sent[0].msg as SearchResultMessage).results.find(
      (r) => r.sha256 === 'd'.repeat(64),
    )!;
    expect(item.filename.length).toBeLessThanOrEqual(1000);
    expect(item.mimeType!.length).toBeLessThanOrEqual(200);
    // Oversized metadata is dropped (null) rather than sliced into invalid JSON
    expect(item.metadata).toBeNull();
  });

  it('swallows sendFn error when sending results to requester', async () => {
    const dir = join(tmpDir, 'send-err-result');
    await mkdir(dir);
    await writeFile(join(dir, 'errfile.mp3'), 'data');
    await indexFile(prisma, join(dir, 'errfile.mp3'));

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
      handleSearchRequest(msg, prisma, identity, fromPeer, [], throwFn),
    ).resolves.toBeUndefined();
  });

  it('drops route and skips forwarding when requester disconnects during result send', async () => {
    const dir = join(tmpDir, 'send-err-fwd');
    await mkdir(dir);
    await writeFile(join(dir, 'fwdfile.mp3'), 'data');
    await indexFile(prisma, join(dir, 'fwdfile.mp3'));

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

    await handleSearchRequest(msg, prisma, identity, fromPeer, [fwdPeer], throwOnResultFn);

    expect(forwardCount).toBe(0); // skip forwarding when requester is gone
    expect(getInternalMapSizes().searchRoutes).toBe(0); // dead route freed immediately
  });

  it('keeps seenSearchIds and searchRoutes at or below MAX_MAP_SIZE under a burst of unique IDs', async () => {
    const fromPeer = makePeer('flood-peer');
    const noop = () => {};
    // Send MAX_MAP_SIZE + 100 unique search IDs in rapid succession so pruneExpired fires
    // and the hard-cap eviction path runs. ttl=2 so a searchRoutes entry is created per request
    // (ttl=1 would never create routes, making the searchRoutes cap assertion trivially true).
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
        prisma,
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
    // Fill seenSearchIds to the cap by initiating MAX_MAP_SIZE origin searches (which protect
    // their own entries). Then send a new handleSearchRequest and verify the hard cap holds.
    const peers = Array.from({ length: 1 }, (_, i) => makePeer(`protected-peer-${i}`));
    const promises: Promise<NetworkResult[]>[] = [];
    for (let i = 0; i < MAX_MAP_SIZE; i++) {
      promises.push(
        initiateNetworkSearch(identity, peers, { query: 'fill', fileType: 'all' }, 200, () => {}),
      );
    }

    // All seenSearchIds entries are now protected by pendingSearches — cap should hold
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
      prisma,
      identity,
      fromPeer,
      [],
      () => {},
    );
    expect(getInternalMapSizes().seenSearchIds).toBeLessThanOrEqual(MAX_MAP_SIZE);

    // Clean up pending searches
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
      handleSearchRequest(msg, prisma, identity, fromPeer, [fromPeer, toPeer], throwFn),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleSearchResult
// ---------------------------------------------------------------------------

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

    // Simulate the peer sending a result back
    // Get the searchId that was sent to the peer
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const networkResultsPromise2 = initiateNetworkSearch(
      identity,
      peers,
      { query: 'find-me', fileType: 'all' },
      200,
      captureAll(sent),
    );

    await Bun.sleep(10); // let the search be initiated
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reqMsg = sent[0].msg as SearchRequestMessage;
    expect(reqMsg.type).toBe('search-request');

    const resultMsg: SearchResultMessage = {
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
    };
    handleSearchResult(resultMsg);

    const results = await networkResultsPromise2;
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('found.mp3');
    expect(results[0].nodeId).toBe('relay-1');

    // Clean up first search
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

      // Process as relay (returnPeer is upstream)
      await handleSearchRequest(relayMsg, prisma, identity, returnPeer, [], captureAll([]));

      // Now a downstream peer sends us a result for this search
      const resultMsg: SearchResultMessage = {
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
      };
      const relayed: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
      handleSearchResult(resultMsg, captureAll(relayed));

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
      await handleSearchRequest(relayMsg, prisma, identity, returnPeer, [], captureAll([]));

      // Activate fake timers and advance past route expiry
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
        expect(relayed).toHaveLength(0); // expired route — result must be dropped
        // Route should be cleaned up
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
      {
        type: 'search-result',
        searchId: crypto.randomUUID(), // unknown ID
        fromNodeId: 'someone',
        results: [],
      },
      captureAll(relayed),
    );
    expect(relayed).toHaveLength(0);
  });

  it('frees dead relay route when return peer has disconnected', async () => {
    // Create a relay route for a peer that is NOT in the connections registry
    const gonePeer = makePeer('gone-upstream');
    const relayMsg: SearchRequestMessage = {
      type: 'search-request',
      searchId: crypto.randomUUID(),
      originNodeId: 'origin',
      query: 'gone',
      fileType: 'all',
      ttl: 2,
    };
    await handleSearchRequest(relayMsg, prisma, identity, gonePeer, [], captureAll([]));
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

    expect(relayed).toHaveLength(0); // peer not connected — nothing relayed
    expect(getInternalMapSizes().searchRoutes).toBe(0); // dead route freed
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

      await handleSearchRequest(relayMsg, prisma, identity, returnPeer, [], captureAll([]));
      expect(getInternalMapSizes().searchRoutes).toBe(1);

      const resultMsg: SearchResultMessage = {
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
      };

      const throwFn = () => {
        throw new Error('relay send failed');
      };
      expect(() => handleSearchResult(resultMsg, throwFn)).not.toThrow();
      expect(getInternalMapSizes().searchRoutes).toBe(0); // dead route freed on send failure
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
    // "node:with:colons" and "node" are two distinct fromNodeId values sharing the same sha256 —
    // both should be kept as separate results (distinct producers of the same file)
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

// ---------------------------------------------------------------------------
// initiateNetworkSearch
// ---------------------------------------------------------------------------

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
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(results).toEqual([]); // no results sent back
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

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Send same result twice — second call adds 0 results and must not log
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
      // Only the first call added results and should have logged; the second was a
      // duplicate (added=0) and must not produce a [search] result log line.
      const resultLogs = logSpy.mock.calls.filter(
        ([msg]) => typeof msg === 'string' && (msg as string).includes('[search] result'),
      );
      expect(resultLogs).toHaveLength(1);
      expect(resultLogs[0][0]).toContain('+1');
    } finally {
      logSpy.mockRestore();
    }
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
      const sha256 = i.toString(16).padStart(64, '0');
      handleSearchResult({
        type: 'search-result',
        searchId: reqMsg.searchId,
        fromNodeId: 'cap-peer',
        results: [
          { filename: `file${i}.mp3`, size: '100', sha256, mimeType: null, metadata: null },
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

    // Flood from one authenticated sender with many spoofed fromNodeId values
    for (let i = 0; i < MAX_RESULTS_PER_SENDER + 10; i++) {
      const sha256 = i.toString(16).padStart(64, '0');
      handleSearchResult({
        type: 'search-result',
        searchId: reqMsg.searchId,
        fromNodeId: `spoofed-node-${i}`,
        viaNodeId: 'flood-sender',
        results: [
          { filename: `file${i}.mp3`, size: '100', sha256, mimeType: null, metadata: null },
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

    // Two producers with the same sha256 coming through different relays — both should be kept
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
