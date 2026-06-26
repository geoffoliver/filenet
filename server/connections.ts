import { and, eq, inArray } from 'drizzle-orm';

import type { FriendRequestMessage, FriendVouchRequestMessage, InnerMessage } from './types';
import { acceptFriendRequest, handleIncomingFriendRequest, shouldAutoAccept } from './friends';
import {
  createHello,
  decodeMessage,
  decryptMessage,
  encodeMessage,
  encryptMessage,
  generateEphemeralKeypair,
  processHelloAck,
} from './handshake';
import type { Db } from './db';
import { FriendResponseMessageSchema } from './schemas';
import type { Identity } from './identity';
import { friends } from './schema';
import { getOrCreateSettings } from './config';

export type ConnectedPeer = {
  ws: { send(data: string | Uint8Array): unknown; close(): void };
  sessionKey: Buffer;
  peerNodeId: string;
  peerPublicKey: Buffer;
  address: string;
  port: number;
};

export function notifyFriendAccepted(peer: ConnectedPeer, localName: string | null): void {
  const name = localName?.trim().slice(0, 200) || undefined;
  sendToPeer(peer, {
    type: 'friend-response',
    accepted: true,
    ...(name ? { name } : {}),
  });
}

export function notifyFriendRejected(peer: ConnectedPeer): void {
  sendToPeer(peer, { type: 'friend-response', accepted: false });
}

const peers = new Map<string, ConnectedPeer>();

export function registerPeer(
  ws: ConnectedPeer['ws'],
  sessionKey: Buffer,
  peerNodeId: string,
  peerPublicKey: Buffer,
  address: string,
  port: number,
): ConnectedPeer {
  const existing = peers.get(peerNodeId);
  if (existing) existing.ws.close();
  const peer: ConnectedPeer = { ws, sessionKey, peerNodeId, peerPublicKey, address, port };
  peers.set(peerNodeId, peer);
  return peer;
}

export function unregisterPeer(nodeId: string): void {
  peers.delete(nodeId);
}

export function closeAndUnregisterPeer(nodeId: string): void {
  const peer = peers.get(nodeId);
  if (peer) {
    peers.delete(nodeId);
    peer.ws.close();
  }
}

export function updatePeerPort(nodeId: string, port: number): void {
  const peer = peers.get(nodeId);
  if (peer) peer.port = port;
}

export function getConnectedPeer(nodeId: string): ConnectedPeer | undefined {
  return peers.get(nodeId);
}

export function getAllConnectedPeers(): ConnectedPeer[] {
  return Array.from(peers.values());
}

export async function getAcceptedConnectedPeers(db: Db): Promise<ConnectedPeer[]> {
  const connected = getAllConnectedPeers();
  if (connected.length === 0) return [];
  const nodeIds = connected.map((p) => p.peerNodeId);
  const accepted = db
    .select({ nodeId: friends.nodeId })
    .from(friends)
    .where(and(eq(friends.status, 'ACCEPTED'), inArray(friends.nodeId, nodeIds)))
    .all();
  const acceptedSet = new Set(accepted.map((f) => f.nodeId as string));
  return connected.filter((p) => acceptedSet.has(p.peerNodeId));
}

export function sendToPeer(peer: ConnectedPeer, msg: InnerMessage): void {
  peer.ws.send(encodeMessage(encryptMessage(msg, peer.sessionKey)));
}

// ---------------------------------------------------------------------------
// Friends-of-friends vouch protocol
// ---------------------------------------------------------------------------

export const MAX_PENDING_VOUCHES = 500;

type PendingVouch = {
  queriedPeerIds: Set<string>;
  respondedPeerIds: Set<string>;
  remainingPeers: number;
  timer: ReturnType<typeof setTimeout>;
  promiseResolve: (vouched: boolean) => void;
};

const pendingVouches = new Map<string, PendingVouch>();

export function resetVouchesForTesting(): void {
  for (const [, vouch] of pendingVouches) {
    clearTimeout(vouch.timer);
    vouch.promiseResolve(false);
  }
  pendingVouches.clear();
}

export async function queryVouch(
  candidateNodeId: string,
  peers: ConnectedPeer[],
  sendFn: (peer: ConnectedPeer, msg: InnerMessage) => void = sendToPeer,
  timeoutMs = 3_000,
): Promise<boolean> {
  if (peers.length === 0) return false;
  if (pendingVouches.has(candidateNodeId)) return false;
  if (pendingVouches.size >= MAX_PENDING_VOUCHES) return false;

  return new Promise<boolean>((promiseResolve) => {
    const queriedPeerIds = new Set<string>();
    const respondedPeerIds = new Set<string>();
    const timer = setTimeout(() => {
      pendingVouches.delete(candidateNodeId);
      promiseResolve(false);
    }, timeoutMs);

    pendingVouches.set(candidateNodeId, {
      queriedPeerIds,
      respondedPeerIds,
      remainingPeers: 0,
      timer,
      promiseResolve,
    });

    const msg: FriendVouchRequestMessage = {
      type: 'friend-vouch-request',
      nodeId: candidateNodeId,
    };
    let sent = 0;
    for (const peer of peers) {
      try {
        sendFn(peer, msg);
        queriedPeerIds.add(peer.peerNodeId);
        sent++;
      } catch {
        // peer disconnected — skip
      }
    }

    const pending = pendingVouches.get(candidateNodeId);
    if (pending) pending.remainingPeers = sent;

    if (sent === 0) {
      clearTimeout(timer);
      pendingVouches.delete(candidateNodeId);
      promiseResolve(false);
    }
  });
}

export function resolveVouch(fromNodeId: string, candidateNodeId: string, vouched: boolean): void {
  const pending = pendingVouches.get(candidateNodeId);
  if (!pending) return;
  if (!pending.queriedPeerIds.has(fromNodeId)) return;
  if (pending.respondedPeerIds.has(fromNodeId)) return;
  pending.respondedPeerIds.add(fromNodeId);

  if (vouched) {
    clearTimeout(pending.timer);
    pendingVouches.delete(candidateNodeId);
    pending.promiseResolve(true);
    return;
  }

  pending.remainingPeers--;
  if (pending.remainingPeers <= 0) {
    clearTimeout(pending.timer);
    pendingVouches.delete(candidateNodeId);
    pending.promiseResolve(false);
  }
}

export const HANDSHAKE_TIMEOUT_MS = 15_000;

export async function connectToPeer(
  identity: Identity,
  db: Db,
  address: string,
  port: number,
  localPort: number,
  friendRequest?: { name: string; password?: string },
  onMessage?: (nodeId: string, msg: InnerMessage) => Promise<void>,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<ConnectedPeer> {
  const host = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
  const url = `ws://${host}:${port}`;
  const ws = new WebSocket(url);

  return new Promise((resolve, reject) => {
    const ephemeral = generateEphemeralKeypair();
    const hello = createHello(identity, ephemeral);
    let sessionKey: Buffer | null = null;
    let peerNodeId: string | null = null;
    let peerPublicKey: Buffer | null = null;
    let handshakeDone = false;
    let timedOut = false;

    const handshakeTimer = setTimeout(() => {
      if (!handshakeDone) {
        timedOut = true;
        reject(new Error(`Handshake timeout after ${handshakeTimeoutMs}ms`));
        ws.close(1000, 'Handshake timeout');
      }
    }, handshakeTimeoutMs);

    ws.onopen = () => {
      ws.send(encodeMessage(hello));
    };

    ws.onmessage = async (event) => {
      if (timedOut) return;
      try {
        const wire = decodeMessage(
          typeof event.data === 'string' ? event.data : Buffer.from(event.data),
        );

        if (wire.type === 'hello-ack') {
          const { sessionKey: sk, ready } = processHelloAck(identity, ephemeral, hello, wire);
          sessionKey = sk;
          peerNodeId = wire.nodeId;
          peerPublicKey = Buffer.from(wire.publicKey, 'base64');

          ws.send(encodeMessage({ type: 'encrypted', payload: ready.toString('base64') }));

          const peer = registerPeer(
            ws,
            sk,
            wire.nodeId,
            Buffer.from(wire.publicKey, 'base64'),
            address,
            port,
          );

          handshakeDone = true;
          clearTimeout(handshakeTimer);

          db.update(friends)
            .set({ nodeId: wire.nodeId, publicKey: wire.publicKey, updatedAt: new Date() })
            .where(
              and(
                eq(friends.address, address),
                eq(friends.port, port),
                eq(friends.status, 'OUTGOING_PENDING'),
              ),
            )
            .run();

          if (friendRequest) {
            const msg: FriendRequestMessage = {
              type: 'friend-request',
              name: friendRequest.name,
              port: localPort,
              ...(friendRequest.password !== undefined ? { password: friendRequest.password } : {}),
            };
            sendToPeer(peer, msg);
          }

          resolve(peer);
          return;
        }

        if (wire.type === 'encrypted' && sessionKey) {
          const msg = decryptMessage(wire, sessionKey);
          await handleOutboundMessage(identity, db, msg, {
            nodeId: peerNodeId!,
            publicKey: peerPublicKey!,
            address,
            port,
          });
          if (onMessage && peerNodeId) {
            try {
              await onMessage(peerNodeId, msg);
            } catch (err) {
              console.error(`onMessage error from peer ${address}:${port}:`, err);
            }
          }
        }
      } catch (err) {
        if (peerNodeId) closeAndUnregisterPeer(peerNodeId);
        reject(err);
        if (!handshakeDone) {
          clearTimeout(handshakeTimer);
          timedOut = true;
          ws.close(1000, 'Pre-handshake error');
        } else {
          console.error(`Error from peer ${address}:${port}:`, err);
        }
      }
    };

    ws.onerror = (err) => {
      clearTimeout(handshakeTimer);
      if (!handshakeDone) reject(err);
    };
    ws.onclose = (event) => {
      clearTimeout(handshakeTimer);
      if (peerNodeId) {
        const current = peers.get(peerNodeId);
        if (current && (current.ws as unknown) === ws) peers.delete(peerNodeId);
      }
      if (!handshakeDone) reject(new Error(`Connection closed before handshake: ${event.reason}`));
    };
  });
}

async function handleOutboundMessage(
  _identity: Identity,
  db: Db,
  msg: InnerMessage,
  peer: { nodeId: string; publicKey: Buffer; address: string; port: number },
): Promise<void> {
  if (msg.type === 'friend-response') {
    const result = FriendResponseMessageSchema.safeParse(msg);
    if (!result.success) return;
    const { accepted, name } = result.data;
    const existing = db
      .select()
      .from(friends)
      .where(and(eq(friends.address, peer.address), eq(friends.port, peer.port)))
      .get();
    if (!existing) return;

    if (accepted) {
      db.transaction((tx) => {
        const txDb = tx as unknown as Db;
        acceptFriendRequest(txDb, existing.id);
        txDb
          .update(friends)
          .set({
            nodeId: peer.nodeId,
            publicKey: peer.publicKey.toString('base64'),
            ...(name ? { name } : {}),
            updatedAt: new Date(),
          })
          .where(eq(friends.id, existing.id))
          .run();
      });
    } else {
      db.delete(friends).where(eq(friends.id, existing.id)).run();
      closeAndUnregisterPeer(peer.nodeId);
    }
  }
}

export async function handleInboundFriendRequest(
  _identity: Identity,
  db: Db,
  msg: FriendRequestMessage,
  peer: { nodeId: string; publicKey: Buffer; address: string; port: number },
  sendResponse: (msg: InnerMessage) => void,
  vouchTimeoutMs = 3_000,
): Promise<void> {
  const settingsRow = await getOrCreateSettings(db);
  let autoAccept = shouldAutoAccept(settingsRow, msg.password);

  const friend = await handleIncomingFriendRequest(db, {
    nodeId: peer.nodeId,
    publicKey: peer.publicKey.toString('base64'),
    name: msg.name,
    address: peer.address,
    port: msg.port,
  });

  if (friend.status === 'BLOCKED') return;

  if (!autoAccept && settingsRow.autoAcceptFromFriendsOfFriends) {
    const allAccepted = await getAcceptedConnectedPeers(db);
    const vouchPeers = allAccepted.filter((p) => p.peerNodeId !== peer.nodeId);
    if (vouchPeers.length > 0) {
      autoAccept = await queryVouch(peer.nodeId, vouchPeers, sendToPeer, vouchTimeoutMs);
    }
  }

  if (autoAccept) {
    await acceptFriendRequest(db, friend.id);
    const name = settingsRow.name.trim().slice(0, 200) || undefined;
    sendResponse({ type: 'friend-response', accepted: true, name });
  }
}
