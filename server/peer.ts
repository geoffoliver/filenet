import type { PrismaClient } from '@prisma/client';
import type { ServerWebSocket } from 'bun';

import {
  FriendRequestMessageSchema,
  FriendResponseMessageSchema,
  SearchRequestMessageSchema,
  SearchResultMessageSchema,
} from './schemas';
import type { HelloAckMessage, HelloMessage, InnerMessage } from './types';
import {
  closeAndUnregisterPeer,
  getAllConnectedPeers,
  getConnectedPeer,
  handleInboundFriendRequest,
  registerPeer,
  updatePeerPort,
} from './connections';
import {
  createHelloAck,
  decodeMessage,
  decryptMessage,
  encodeMessage,
  encryptMessage,
  finalizeHandshake,
  generateEphemeralKeypair,
} from './handshake';
import { handleSearchRequest, handleSearchResult } from './search-protocol';
import type { Identity } from './identity';
import { acceptFriendRequest } from './friends';

type PeerState =
  | { phase: 'pending' }
  | {
      phase: 'hello-sent';
      hello: HelloMessage;
      ephemeral: ReturnType<typeof generateEphemeralKeypair>;
    }
  | {
      phase: 'ack-sent';
      hello: HelloMessage;
      ack: HelloAckMessage;
      ephemeral: ReturnType<typeof generateEphemeralKeypair>;
    }
  | { phase: 'authenticated'; sessionKey: Buffer; peerNodeId: string; peerPublicKey: Buffer };

export type PeerData = {
  identity: Identity;
  prisma: PrismaClient;
  localPort: number;
  state: PeerState;
};

export function handleOpen(ws: ServerWebSocket<PeerData>): void {
  ws.data.state = { phase: 'pending' };
}

export function handleMessage(
  ws: ServerWebSocket<PeerData>,
  raw: string | Buffer,
  onAuthenticated?: (ws: ServerWebSocket<PeerData>, msg: InnerMessage) => void,
): void {
  const { identity } = ws.data;
  const wire = decodeMessage(raw);

  if (wire.type === 'hello') {
    const { ack, ephemeral } = createHelloAck(identity, wire);
    ws.data.state = {
      phase: 'ack-sent',
      hello: wire,
      ack,
      ephemeral,
    };
    ws.send(encodeMessage(ack));
    return;
  }

  if (wire.type === 'hello-ack') {
    if (ws.data.state.phase !== 'hello-sent') return;
    return;
  }

  if (wire.type === 'encrypted') {
    const state = ws.data.state;

    if (state.phase === 'ack-sent') {
      try {
        const sessionKey = finalizeHandshake(
          identity,
          state.ephemeral,
          state.hello,
          state.ack,
          Buffer.from(state.hello.publicKey, 'base64'),
          Buffer.from(wire.payload, 'base64'),
        );
        const peerPublicKey = Buffer.from(state.hello.publicKey, 'base64');
        ws.data.state = {
          phase: 'authenticated',
          sessionKey,
          peerNodeId: state.hello.nodeId,
          peerPublicKey,
        };
        // Port is unknown for inbound connections until a friend-request arrives.
        registerPeer(ws, sessionKey, state.hello.nodeId, peerPublicKey, ws.remoteAddress, 0);
      } catch {
        ws.close(1008, 'Handshake failed');
      }
      return;
    }

    if (state.phase === 'authenticated') {
      try {
        const msg = decryptMessage(wire, state.sessionKey);
        dispatchMessage(ws, msg)
          .then(() => onAuthenticated?.(ws, msg))
          .catch(() => ws.close(1011, 'Internal error'));
      } catch {
        ws.close(1008, 'Decryption failed');
      }
    }
  }
}

export async function dispatchMessage(
  ws: ServerWebSocket<PeerData>,
  msg: InnerMessage,
): Promise<void> {
  const state = ws.data.state;
  if (state.phase !== 'authenticated') return;

  if (msg.type === 'friend-request') {
    const result = FriendRequestMessageSchema.safeParse(msg);
    if (!result.success) {
      ws.close(1008, 'Invalid friend-request');
      return;
    }
    const validated = result.data;
    updatePeerPort(state.peerNodeId, validated.port);
    await handleInboundFriendRequest(
      ws.data.identity,
      ws.data.prisma,
      validated,
      {
        nodeId: state.peerNodeId,
        publicKey: state.peerPublicKey,
        address: ws.remoteAddress,
        port: validated.port,
      },
      (response) => sendEncrypted(ws, response),
    );
    return;
  }

  if (msg.type === 'friend-response') {
    const result = FriendResponseMessageSchema.safeParse(msg);
    if (!result.success) return;
    const { accepted, name } = result.data;
    const friend = await ws.data.prisma.friend.findFirst({
      where: { nodeId: state.peerNodeId },
    });
    if (!friend) return;

    if (accepted) {
      await acceptFriendRequest(ws.data.prisma, friend.id);
      if (name) {
        await ws.data.prisma.friend.update({
          where: { id: friend.id },
          data: { name },
        });
      }
    } else {
      await ws.data.prisma.friend.delete({ where: { id: friend.id } });
      closeAndUnregisterPeer(state.peerNodeId);
    }
    return;
  }

  if (msg.type === 'search-request' || msg.type === 'search-result') {
    await dispatchSearchMessage(msg, state.peerNodeId, ws.data.prisma, ws.data.identity);
    return;
  }
}

/**
 * Handle search-request and search-result messages for any authenticated connection
 * (both inbound ServerWebSocket and outbound native WebSocket).  Exported so index.ts
 * can wire it up as the onMessage callback for outbound connections.
 */
export async function dispatchSearchMessage(
  msg: InnerMessage,
  senderNodeId: string,
  prisma: PrismaClient,
  identity: Identity,
): Promise<void> {
  if (msg.type === 'search-request') {
    const result = SearchRequestMessageSchema.safeParse(msg);
    if (!result.success) return; // malformed — drop
    // Targeted check first so non-friends can't trigger a full-table scan
    const senderFriend = await prisma.friend.findFirst({
      where: { nodeId: senderNodeId, status: 'ACCEPTED' },
    });
    if (!senderFriend) return; // not an accepted friend — drop
    const fromPeer = getConnectedPeer(senderNodeId);
    if (!fromPeer) return;
    // Only resolve accepted peers for forwarding when the request will actually be forwarded
    let acceptedPeers: ReturnType<typeof getAllConnectedPeers> = [];
    if (result.data.ttl > 1) {
      const acceptedFriends = await prisma.friend.findMany({
        where: { status: 'ACCEPTED', nodeId: { not: null } },
        select: { nodeId: true },
      });
      const acceptedNodeIds = new Set(acceptedFriends.map((f) => f.nodeId as string));
      acceptedPeers = getAllConnectedPeers().filter((p) => acceptedNodeIds.has(p.peerNodeId));
    }
    await handleSearchRequest(result.data, prisma, identity, fromPeer, acceptedPeers);
  } else if (msg.type === 'search-result') {
    const result = SearchResultMessageSchema.safeParse(msg);
    if (!result.success) return; // malformed — drop
    const isFriend = await prisma.friend.findFirst({
      where: { nodeId: senderNodeId, status: 'ACCEPTED' },
    });
    if (!isFriend) return; // not an accepted friend — drop
    // Tag viaNodeId with the authenticated sender while preserving the original producer's
    // fromNodeId so multi-hop results retain correct producer attribution.
    handleSearchResult({ ...result.data, viaNodeId: senderNodeId });
  }
}

export function sendEncrypted(ws: ServerWebSocket<PeerData>, msg: InnerMessage): void {
  const state = ws.data.state;
  if (state.phase !== 'authenticated') throw new Error('Not authenticated');
  ws.send(encodeMessage(encryptMessage(msg, state.sessionKey)));
}
