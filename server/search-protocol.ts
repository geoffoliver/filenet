import crypto from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { type ConnectedPeer, sendToPeer } from './connections';
import { type FileType, searchFiles } from './search';
import type {
  InnerMessage,
  SearchRequestMessage,
  SearchResultItem,
  SearchResultMessage,
} from './types';
import type { Identity } from './identity';

export const DEFAULT_TTL = 3;
export const SEARCH_TIMEOUT_MS = 5_000;
export const MAX_NETWORK_RESULTS = 200;
const ROUTE_EXPIRY_MS = 10 * 60 * 1_000;
const PRUNE_INTERVAL_MS = 60_000;
export const MAX_MAP_SIZE = 10_000;
const VALID_FILE_TYPES = new Set<string>(['all', 'audio', 'video', 'image', 'document', 'ebook']);

export type NetworkResult = SearchResultItem & { nodeId: string; viaNodeId?: string };

type PendingSearch = {
  results: NetworkResult[];
  seenKeys: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  resolve: (results: NetworkResult[]) => void;
};

// Seen search IDs — prevents processing the same search twice (cycle prevention)
const seenSearchIds = new Map<string, number>(); // searchId → timestamp

// Return paths — who to relay results back to for each in-flight search
// returnPeer === null means this node originated the search
const searchRoutes = new Map<string, { returnPeer: ConnectedPeer | null; expiresAt: number }>();

// Pending outbound searches waiting to collect results
const pendingSearches = new Map<string, PendingSearch>();

let lastPruneAt = 0;

export function getInternalMapSizes(): { seenSearchIds: number; searchRoutes: number } {
  return { seenSearchIds: seenSearchIds.size, searchRoutes: searchRoutes.size };
}

function pruneExpired(): void {
  const now = Date.now();
  lastPruneAt = now;
  for (const [id, ts] of seenSearchIds) {
    if (ts < now - ROUTE_EXPIRY_MS) seenSearchIds.delete(id);
  }
  for (const [id, route] of searchRoutes) {
    if (now > route.expiresAt) searchRoutes.delete(id);
  }
  // Hard cap: evict oldest entries down to MAX_MAP_SIZE - 1 when still at or above the
  // limit after expiry pruning. We evict to -1 rather than exactly MAX_MAP_SIZE so the
  // caller can safely insert one more entry (the one that triggered the prune) without
  // immediately overshooting the cap again.
  if (seenSearchIds.size >= MAX_MAP_SIZE) {
    const overflow = seenSearchIds.size - (MAX_MAP_SIZE - 1);
    const oldest = [...seenSearchIds.entries()].sort((a, b) => a[1] - b[1]).slice(0, overflow);
    for (const [id] of oldest) seenSearchIds.delete(id);
  }
  if (searchRoutes.size >= MAX_MAP_SIZE) {
    const overflow = searchRoutes.size - (MAX_MAP_SIZE - 1);
    const oldest = [...searchRoutes.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      .slice(0, overflow);
    for (const [id] of oldest) searchRoutes.delete(id);
  }
}

function markSeen(searchId: string): boolean {
  if (seenSearchIds.has(searchId)) return false;
  const now = Date.now();
  // Check BEFORE inserting so pruneExpired runs while both maps are at the cap,
  // leaving room for the new entry and the searchRoutes.set that follows in the caller.
  if (
    seenSearchIds.size >= MAX_MAP_SIZE ||
    searchRoutes.size >= MAX_MAP_SIZE ||
    now - lastPruneAt > PRUNE_INTERVAL_MS
  ) {
    pruneExpired();
  }
  seenSearchIds.set(searchId, now);
  return true;
}

function coerceFileType(raw: string): FileType {
  return VALID_FILE_TYPES.has(raw) ? (raw as FileType) : 'all';
}

export function handleSearchResult(
  msg: SearchResultMessage,
  sendFn: (peer: ConnectedPeer, msg: InnerMessage) => void = sendToPeer,
): void {
  const route = searchRoutes.get(msg.searchId);
  if (!route) return;

  if (route.returnPeer === null) {
    // We originated this search — collect results up to the cap
    const pending = pendingSearches.get(msg.searchId);
    if (!pending) return;
    for (const item of msg.results) {
      if (pending.results.length >= MAX_NETWORK_RESULTS) break;
      const key = `${msg.fromNodeId}:${item.sha256}`;
      if (!pending.seenKeys.has(key)) {
        pending.seenKeys.add(key);
        pending.results.push({ ...item, nodeId: msg.fromNodeId, viaNodeId: msg.viaNodeId });
      }
    }
    // Resolve early once we've hit the result cap instead of waiting for timeout
    if (pending.results.length >= MAX_NETWORK_RESULTS) {
      clearTimeout(pending.timer);
      pendingSearches.delete(msg.searchId);
      searchRoutes.delete(msg.searchId);
      pending.resolve(pending.results);
    }
  } else {
    // We're a relay — forward the result back up the chain
    try {
      sendFn(route.returnPeer, msg);
    } catch {
      // relay peer disconnected — nothing to do
    }
  }
}

export async function handleSearchRequest(
  msg: SearchRequestMessage,
  prisma: PrismaClient,
  identity: Identity,
  fromPeer: ConnectedPeer,
  allPeers: ConnectedPeer[],
  sendFn: (peer: ConnectedPeer, msg: InnerMessage) => void = sendToPeer,
): Promise<void> {
  if (msg.ttl <= 0) return; // TTL exhausted — drop without processing
  if (!markSeen(msg.searchId)) return; // already seen — drop (cycle prevention)

  searchRoutes.set(msg.searchId, {
    returnPeer: fromPeer,
    expiresAt: Date.now() + ROUTE_EXPIRY_MS,
  });

  // Execute local search and return any matching results to the sender
  const { files } = await searchFiles(prisma, {
    query: msg.query,
    type: coerceFileType(msg.fileType),
    limit: 50,
    offset: 0,
  });

  if (files.length > 0) {
    const resultMsg: SearchResultMessage = {
      type: 'search-result',
      searchId: msg.searchId,
      fromNodeId: identity.nodeId,
      results: files.map((f) => ({
        filename: f.filename.slice(0, 1000),
        size: f.size.toString(),
        sha256: f.sha256,
        mimeType: f.mimeType?.slice(0, 200) ?? null,
        metadata: f.metadata?.slice(0, 4096) ?? null,
      })),
    };
    try {
      sendFn(fromPeer, resultMsg);
    } catch {
      // requester disconnected before results arrived
    }
  }

  // Forward with TTL decremented; receiving peers drop ttl=0 via the guard above
  if (msg.ttl > 0) {
    const forward: SearchRequestMessage = { ...msg, ttl: msg.ttl - 1 };
    for (const peer of allPeers) {
      if (peer.peerNodeId !== fromPeer.peerNodeId) {
        try {
          sendFn(peer, forward);
        } catch {
          // peer disconnected — skip
        }
      }
    }
  }
}

export async function initiateNetworkSearch(
  identity: Identity,
  peers: ConnectedPeer[],
  params: { query: string; fileType: string },
  timeoutMs = SEARCH_TIMEOUT_MS,
  sendFn: (peer: ConnectedPeer, msg: InnerMessage) => void = sendToPeer,
): Promise<NetworkResult[]> {
  if (peers.length === 0) return [];

  const searchId = crypto.randomUUID();
  markSeen(searchId);
  searchRoutes.set(searchId, { returnPeer: null, expiresAt: Date.now() + ROUTE_EXPIRY_MS });

  return new Promise((resolve) => {
    const pending: PendingSearch = {
      results: [],
      seenKeys: new Set(),
      timer: setTimeout(() => {
        pendingSearches.delete(searchId);
        searchRoutes.delete(searchId);
        resolve(pending.results);
      }, timeoutMs),
      resolve,
    };
    pendingSearches.set(searchId, pending);

    const msg: SearchRequestMessage = {
      type: 'search-request',
      searchId,
      originNodeId: identity.nodeId,
      query: params.query,
      fileType: params.fileType,
      ttl: DEFAULT_TTL,
    };

    for (const peer of peers) {
      try {
        sendFn(peer, msg);
      } catch {
        // peer disconnected before search could be sent
      }
    }
  });
}
