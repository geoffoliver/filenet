import crypto from 'node:crypto';

import type { Db } from './db';

import { type ConnectedPeer, getConnectedPeer, sendToPeer } from './connections';
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
// How long to wait after the last result batch before resolving early.
// Keeps the search open for stragglers without forcing the full timeout.
export const SETTLE_TIMEOUT_MS = 500;
export const MAX_NETWORK_RESULTS = 200;
export const MAX_RESULTS_PER_SENDER = 50; // per authenticated sender, matches local search limit
export const ROUTE_EXPIRY_MS = 10 * 60 * 1_000;
const PRUNE_INTERVAL_MS = 60_000;
export const MAX_MAP_SIZE = 10_000;
const VALID_FILE_TYPES = new Set<string>(['all', 'audio', 'video', 'image', 'document', 'ebook']);

export type NetworkResult = SearchResultItem & { nodeId: string; viaNodeId?: string };

type PendingSearch = {
  results: NetworkResult[];
  seenKeys: Set<string>;
  resultsPerSender: Map<string, number>; // authenticated sender → result count
  timer: ReturnType<typeof setTimeout>;
  settleTimer: ReturnType<typeof setTimeout> | null;
  settleTimeoutMs: number;
  resolve: (results: NetworkResult[]) => void;
};

// Seen search IDs — prevents processing the same search twice (cycle prevention)
const seenSearchIds = new Map<string, number>(); // searchId → timestamp

// Return paths — who to relay results back to for each in-flight search
// returnPeerNodeId === null means this node originated the search
const searchRoutes = new Map<
  string,
  { returnPeerNodeId: string | null; expiresAt: number; createdAt: number }
>();

// Pending outbound searches waiting to collect results
const pendingSearches = new Map<string, PendingSearch>();

let lastPruneAt = 0;

export function getInternalMapSizes(): { seenSearchIds: number; searchRoutes: number } {
  return { seenSearchIds: seenSearchIds.size, searchRoutes: searchRoutes.size };
}

/** Reset all module-level state. Only for use in tests. */
export function resetInternalMapsForTesting(): void {
  for (const [, pending] of pendingSearches) {
    clearTimeout(pending.timer);
    if (pending.settleTimer) clearTimeout(pending.settleTimer);
  }
  seenSearchIds.clear();
  searchRoutes.clear();
  pendingSearches.clear();
  lastPruneAt = 0;
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
  // Hard cap: evict oldest entries down to MAX_MAP_SIZE - 1. Map iteration follows insertion
  // order, which is chronological (oldest first), so we walk forward and delete until we've
  // freed enough slots — O(overflow) rather than O(n log n) for the sort-based approach.
  // We stop at MAX_MAP_SIZE - 1 so the caller can insert one more without overshooting.
  if (seenSearchIds.size >= MAX_MAP_SIZE) {
    const toEvict = seenSearchIds.size - (MAX_MAP_SIZE - 1);
    let evicted = 0;
    for (const [id] of seenSearchIds) {
      if (evicted >= toEvict) break;
      // Never evict an in-flight origin search or any entry with a live route —
      // losing the seenSearchIds entry while the route exists would let a duplicate
      // search-request overwrite the route and misroute in-flight results.
      if (!pendingSearches.has(id) && !searchRoutes.has(id)) {
        seenSearchIds.delete(id);
        evicted++;
      }
    }
  }
  if (searchRoutes.size >= MAX_MAP_SIZE) {
    const toEvict = searchRoutes.size - (MAX_MAP_SIZE - 1);
    // Protect origin searches (in pendingSearches) AND recently-created relay routes
    // (within SEARCH_TIMEOUT_MS). Use route.createdAt rather than seenSearchIds.get(id)
    // so protection holds even if the seenSearchIds entry was evicted first.
    const relayCutoff = now - SEARCH_TIMEOUT_MS;
    let evicted = 0;
    for (const [id, route] of searchRoutes) {
      if (evicted >= toEvict) break;
      if (!pendingSearches.has(id) && route.createdAt < relayCutoff) {
        searchRoutes.delete(id);
        evicted++;
      }
    }
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
  // If pruneExpired couldn't free a slot (all entries protected), roll back and signal failure
  // so callers can bail out rather than silently exceeding the hard cap.
  if (seenSearchIds.size > MAX_MAP_SIZE) {
    seenSearchIds.delete(searchId);
    return false;
  }
  return true;
}

function coerceFileType(raw: string): FileType {
  return VALID_FILE_TYPES.has(raw) ? (raw as FileType) : 'all';
}

export function handleSearchResult(
  msg: SearchResultMessage,
  sendFn: (peer: ConnectedPeer, msg: InnerMessage) => void = sendToPeer,
): void {
  // Opportunistic prune — keeps maps tidy even when markSeen() isn't called (e.g., idle relay)
  const now = Date.now();
  if (now - lastPruneAt > PRUNE_INTERVAL_MS) pruneExpired();

  const route = searchRoutes.get(msg.searchId);
  if (!route) return;
  if (now > route.expiresAt) {
    searchRoutes.delete(msg.searchId);
    return;
  }

  if (route.returnPeerNodeId === null) {
    // We originated this search — collect results up to the cap
    const pending = pendingSearches.get(msg.searchId);
    if (!pending) return;
    // Dedup by (fromNodeId, sha256) so distinct producers with the same file are all counted.
    // Cap per authenticated sender (viaNodeId) to prevent a malicious peer from flooding the
    // result list by spoofing many fromNodeId values.
    const sender = msg.viaNodeId ?? msg.fromNodeId;
    const senderCount = pending.resultsPerSender.get(sender) ?? 0;
    let added = 0;
    for (const item of msg.results) {
      if (pending.results.length >= MAX_NETWORK_RESULTS) break;
      if (senderCount + added >= MAX_RESULTS_PER_SENDER) break;
      // JSON.stringify avoids key collisions when fromNodeId contains the separator character
      const key = JSON.stringify([msg.fromNodeId, item.sha256]);
      if (!pending.seenKeys.has(key)) {
        pending.seenKeys.add(key);
        pending.results.push({ ...item, nodeId: msg.fromNodeId, viaNodeId: msg.viaNodeId });
        added++;
      }
    }
    if (added > 0) {
      pending.resultsPerSender.set(sender, senderCount + added);
      // Reset the settle timer — resolve early if no new results arrive within the window.
      if (pending.settleTimer) clearTimeout(pending.settleTimer);
      pending.settleTimer = setTimeout(() => {
        clearTimeout(pending.timer);
        pendingSearches.delete(msg.searchId);
        searchRoutes.delete(msg.searchId);
        pending.resolve(pending.results);
      }, pending.settleTimeoutMs);
    }
    // Resolve early once we've hit the result cap instead of waiting for timeout
    if (pending.results.length >= MAX_NETWORK_RESULTS) {
      if (pending.settleTimer) clearTimeout(pending.settleTimer);
      clearTimeout(pending.timer);
      pendingSearches.delete(msg.searchId);
      searchRoutes.delete(msg.searchId);
      pending.resolve(pending.results);
    }
  } else {
    // We're a relay — resolve the live connection at send time to avoid using a stale peer object
    const returnPeer = getConnectedPeer(route.returnPeerNodeId);
    if (!returnPeer) {
      // Return peer disconnected — free the dead route immediately rather than waiting for expiry
      searchRoutes.delete(msg.searchId);
      return;
    }
    try {
      sendFn(returnPeer, msg);
    } catch {
      // Peer disconnected mid-send — free the dead route
      searchRoutes.delete(msg.searchId);
    }
  }
}

export async function handleSearchRequest(
  msg: SearchRequestMessage,
  db: Db,
  identity: Identity,
  fromPeer: ConnectedPeer,
  allPeers: ConnectedPeer[],
  sendFn: (peer: ConnectedPeer, msg: InnerMessage) => void = sendToPeer,
): Promise<void> {
  if (msg.ttl <= 0) return; // TTL exhausted — drop without processing
  if (!markSeen(msg.searchId)) return; // already seen — drop (cycle prevention)

  // Only create a return route when we need to relay results back — if ttl=1 we process locally
  // and never forward, so no downstream results can ever arrive and a route would be dead weight.
  if (msg.ttl > 1) {
    if (searchRoutes.size >= MAX_MAP_SIZE) {
      // Pruning couldn't free a searchRoutes slot — roll back the seenSearchIds entry so the
      // same searchId isn't permanently orphaned (no route = no point marking it seen).
      seenSearchIds.delete(msg.searchId);
      return;
    }
    const routeCreatedAt = Date.now();
    searchRoutes.set(msg.searchId, {
      returnPeerNodeId: fromPeer.peerNodeId,
      expiresAt: routeCreatedAt + ROUTE_EXPIRY_MS,
      createdAt: routeCreatedAt,
    });
  }

  // Execute local search — skip the count query since the protocol only uses files
  const { files } = await searchFiles(db, {
    query: msg.query,
    type: coerceFileType(msg.fileType),
    limit: 50,
    offset: 0,
    skipTotal: true,
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
        metadata: f.metadata != null && f.metadata.length <= 4096 ? f.metadata : null,
      })),
    };
    try {
      sendFn(fromPeer, resultMsg);
    } catch {
      // Requester disconnected — drop the return route and skip forwarding: there is no one to
      // deliver downstream results to, so propagating the search would waste network bandwidth.
      searchRoutes.delete(msg.searchId);
      return;
    }
  }

  // Forward with TTL decremented; ttl=1 means "process locally, do not forward further"
  if (msg.ttl > 1) {
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
  settleTimeoutMs = SETTLE_TIMEOUT_MS,
): Promise<NetworkResult[]> {
  if (peers.length === 0) return [];

  const searchId = crypto.randomUUID();
  if (!markSeen(searchId)) return []; // UUID collision — astronomically unlikely
  if (searchRoutes.size >= MAX_MAP_SIZE) {
    // At capacity even after pruning — clean up and bail rather than overflowing the map.
    seenSearchIds.delete(searchId);
    return [];
  }
  const routeCreatedAt = Date.now();
  searchRoutes.set(searchId, {
    returnPeerNodeId: null,
    expiresAt: routeCreatedAt + ROUTE_EXPIRY_MS,
    createdAt: routeCreatedAt,
  });

  return new Promise((resolve) => {
    const pending: PendingSearch = {
      results: [],
      seenKeys: new Set(),
      resultsPerSender: new Map(),
      timer: setTimeout(() => {
        if (pending.settleTimer) clearTimeout(pending.settleTimer);
        pendingSearches.delete(searchId);
        searchRoutes.delete(searchId);
        resolve(pending.results);
      }, timeoutMs),
      settleTimer: null,
      settleTimeoutMs,
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
