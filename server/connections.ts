import type { PrismaClient } from '@prisma/client';

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
import { FriendResponseMessageSchema } from './schemas';
import type { Identity } from './identity';
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

export async function getAcceptedConnectedPeers(prisma: PrismaClient): Promise<ConnectedPeer[]> {
  const connected = getAllConnectedPeers();
  if (connected.length === 0) return [];
  const nodeIds = connected.map((p) => p.peerNodeId);
  const accepted = await prisma.friend.findMany({
    where: { status: 'ACCEPTED', nodeId: { in: nodeIds } },
    select: { nodeId: true },
  });
  const acceptedSet = new Set(accepted.map((f) => f.nodeId as string));
  return connected.filter((p) => acceptedSet.has(p.peerNodeId));
}

export function sendToPeer(peer: ConnectedPeer, msg: InnerMessage): void {
  peer.ws.send(encodeMessage(encryptMessage(msg, peer.sessionKey)));
}

// ---------------------------------------------------------------------------
// Friends-of-friends vouch protocol
// ---------------------------------------------------------------------------

// Hard cap: prevents a flood of inbound friend-requests from exhausting memory
// via unbounded pendingVouches entries + timers.
export const MAX_PENDING_VOUCHES = 500;

type PendingVouch = {
  // Peers we actually sent a vouch-request to; only responses from members of
  // this set are accepted, preventing unsolicited/spoofed vouches.
  queriedPeerIds: Set<string>;
  // Tracks which queried peers have already responded, so a single malicious
  // peer cannot decrement remainingPeers multiple times and force an early false.
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

  // Guard: a concurrent vouch query for the same candidateNodeId is already in
  // flight (e.g., rapid duplicate friend-requests). Let it finish rather than
  // overwriting the map entry and corrupting both queries' state.
  if (pendingVouches.has(candidateNodeId)) return false;

  // Guard: prevent memory exhaustion from a flood of simultaneous friend-requests.
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
  if (!pending.queriedPeerIds.has(fromNodeId)) return; // unsolicited — ignore
  // Deduplicate responses: a single peer sending vouched=false multiple times
  // must not drain remainingPeers and force an early false before honest peers respond.
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

export async function connectToPeer(
  identity: Identity,
  prisma: PrismaClient,
  address: string,
  port: number,
  localPort: number,
  friendRequest?: { name: string; password?: string },
  onMessage?: (nodeId: string, msg: InnerMessage) => Promise<void>,
): Promise<ConnectedPeer> {
  const url = `ws://${address}:${port}`;
  const ws = new WebSocket(url);

  return new Promise((resolve, reject) => {
    const ephemeral = generateEphemeralKeypair();
    const hello = createHello(identity, ephemeral);
    let sessionKey: Buffer | null = null;
    let peerNodeId: string | null = null;
    let peerPublicKey: Buffer | null = null;
    let handshakeDone = false;

    ws.onopen = () => {
      ws.send(encodeMessage(hello));
    };

    ws.onmessage = async (event) => {
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

          // Mark handshake done immediately so onclose won't spuriously reject
          // if the socket closes while we're doing the DB write below.
          handshakeDone = true;

          await prisma.friend.updateMany({
            where: { address, port, nodeId: null, status: 'OUTGOING_PENDING' },
            data: { nodeId: wire.nodeId, publicKey: wire.publicKey },
          });

          if (friendRequest) {
            const msg: FriendRequestMessage = {
              type: 'friend-request',
              name: friendRequest.name,
              port: localPort,
              ...(friendRequest.password ? { password: friendRequest.password } : {}),
            };
            sendToPeer(peer, msg);
          }

          resolve(peer);
          return;
        }

        if (wire.type === 'encrypted' && sessionKey) {
          const msg = decryptMessage(wire, sessionKey);
          await handleOutboundMessage(identity, prisma, msg, {
            nodeId: peerNodeId!,
            publicKey: peerPublicKey!,
            address,
            port,
          });
          if (onMessage && peerNodeId) {
            try {
              await onMessage(peerNodeId, msg);
            } catch (err) {
              // A transient error in the optional message hook (e.g. DB blip) must not
              // tear down an otherwise healthy connection.
              console.error(`onMessage error from peer ${address}:${port}:`, err);
            }
          }
        }
      } catch (err) {
        if (peerNodeId) closeAndUnregisterPeer(peerNodeId);
        reject(err); // no-op if already resolved; handles pre- and mid-setup failures
        if (handshakeDone) {
          console.error(`Error from peer ${address}:${port}:`, err);
        }
      }
    };

    ws.onerror = (err) => {
      if (!handshakeDone) reject(err);
    };
    ws.onclose = (event) => {
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
  prisma: PrismaClient,
  msg: InnerMessage,
  peer: { nodeId: string; publicKey: Buffer; address: string; port: number },
): Promise<void> {
  if (msg.type === 'friend-response') {
    const result = FriendResponseMessageSchema.safeParse(msg);
    if (!result.success) return;
    const { accepted, name } = result.data;
    const existing = await prisma.friend.findFirst({
      where: { address: peer.address, port: peer.port },
    });
    if (!existing) return;

    if (accepted) {
      await acceptFriendRequest(prisma, existing.id);
      await prisma.friend.update({
        where: { id: existing.id },
        data: {
          nodeId: peer.nodeId,
          publicKey: peer.publicKey.toString('base64'),
          ...(name ? { name } : {}),
        },
      });
    } else {
      await prisma.friend.delete({ where: { id: existing.id } });
      closeAndUnregisterPeer(peer.nodeId);
    }
  }
}

export async function handleInboundFriendRequest(
  _identity: Identity,
  prisma: PrismaClient,
  msg: FriendRequestMessage,
  peer: { nodeId: string; publicKey: Buffer; address: string; port: number },
  sendResponse: (msg: InnerMessage) => void,
  vouchTimeoutMs = 3_000,
): Promise<void> {
  const settings = await getOrCreateSettings(prisma);
  let autoAccept = shouldAutoAccept(settings, msg.password);

  const friend = await handleIncomingFriendRequest(prisma, {
    nodeId: peer.nodeId,
    publicKey: peer.publicKey.toString('base64'),
    name: msg.name,
    address: peer.address,
    port: msg.port,
  });

  if (friend.status === 'BLOCKED') return;

  if (!autoAccept && settings.autoAcceptFromFriendsOfFriends) {
    const allAccepted = await getAcceptedConnectedPeers(prisma);
    // Exclude the requesting peer itself — it can't vouch for itself
    const vouchPeers = allAccepted.filter((p) => p.peerNodeId !== peer.nodeId);
    if (vouchPeers.length > 0) {
      autoAccept = await queryVouch(peer.nodeId, vouchPeers, sendToPeer, vouchTimeoutMs);
    }
  }

  if (autoAccept) {
    await acceptFriendRequest(prisma, friend.id);
    const name = settings.name.trim().slice(0, 200) || undefined;
    sendResponse({ type: 'friend-response', accepted: true, name });
  }
  // No response when queued for manual review — the user will accept/reject via the UI.
}
