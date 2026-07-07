import { and, eq } from 'drizzle-orm';
import type { ServerWebSocket } from 'bun';

import {
  ChatMessageSchema,
  FriendRequestMessageSchema,
  FriendResponseMessageSchema,
  FriendVouchRequestMessageSchema,
  FriendVouchResponseMessageSchema,
  GroupCreateMessageSchema,
  SearchRequestMessageSchema,
  SearchResultMessageSchema,
} from './schemas';
import type { HelloAckMessage, HelloMessage, InnerMessage } from './types';
import {
  closeAndUnregisterPeer,
  getAcceptedConnectedPeers,
  getConnectedPeer,
  handleInboundFriendRequest,
  registerPeer,
  resolveVouch,
  sendToPeer,
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
import { handleChatMessage, handleGroupCreate } from './chat';
import { handleSearchRequest, handleSearchResult } from './search-protocol';
import type { Db } from './db';
import type { Identity } from './identity';
import { acceptFriendRequest } from './friends';
import { dispatchTransferMessage } from './transfer-protocol';
import { friends } from './schema';

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
  db: Db;
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
    ws.data.state = { phase: 'ack-sent', hello: wire, ack, ephemeral };
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
  const db = ws.data.db;

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
      db,
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
    const friend = db.select().from(friends).where(eq(friends.nodeId, state.peerNodeId)).get();
    if (!friend) return;

    if (accepted) {
      db.transaction((tx) => {
        acceptFriendRequest(tx as unknown as Db, friend.id);
        if (name) {
          tx.update(friends)
            .set({ name, updatedAt: new Date() })
            .where(eq(friends.id, friend.id))
            .run();
        }
      });
    } else {
      db.delete(friends).where(eq(friends.id, friend.id)).run();
      closeAndUnregisterPeer(state.peerNodeId);
    }
    return;
  }

  if (msg.type === 'search-request' || msg.type === 'search-result') {
    await dispatchSearchMessage(msg, state.peerNodeId, db, ws.data.identity);
    return;
  }

  if (msg.type === 'chunk-request' || msg.type === 'chunk-response' || msg.type === 'chunk-error') {
    await dispatchTransferMessage(msg, state.peerNodeId, db);
    return;
  }

  if (msg.type === 'chat-message') {
    await dispatchChatMessage(msg, state.peerNodeId, db, ws.data.identity.nodeId);
    return;
  }

  if (msg.type === 'group-create') {
    await dispatchGroupCreateMessage(msg, state.peerNodeId, db);
    return;
  }

  if (msg.type === 'friend-vouch-request' || msg.type === 'friend-vouch-response') {
    await dispatchVouchMessage(msg, state.peerNodeId, db);
    return;
  }
}

export async function dispatchSearchMessage(
  msg: InnerMessage,
  senderNodeId: string,
  db: Db,
  identity: Identity,
): Promise<void> {
  if (msg.type === 'search-request') {
    const result = SearchRequestMessageSchema.safeParse(msg);
    if (!result.success) return;
    const senderFriend = db
      .select()
      .from(friends)
      .where(and(eq(friends.nodeId, senderNodeId), eq(friends.status, 'ACCEPTED')))
      .get();
    if (!senderFriend) return;
    const fromPeer = getConnectedPeer(senderNodeId);
    if (!fromPeer) return;
    const acceptedPeers = result.data.ttl > 1 ? await getAcceptedConnectedPeers(db) : [];
    await handleSearchRequest(result.data, db, identity, fromPeer, acceptedPeers);
  } else if (msg.type === 'search-result') {
    const result = SearchResultMessageSchema.safeParse(msg);
    if (!result.success) return;
    const isFriend = db
      .select()
      .from(friends)
      .where(and(eq(friends.nodeId, senderNodeId), eq(friends.status, 'ACCEPTED')))
      .get();
    if (!isFriend) return;
    handleSearchResult({ ...result.data, viaNodeId: senderNodeId });
  }
}

export async function dispatchChatMessage(
  msg: InnerMessage,
  senderNodeId: string,
  db: Db,
  localNodeId: string,
): Promise<void> {
  if (msg.type !== 'chat-message') return;
  const result = ChatMessageSchema.safeParse(msg);
  if (!result.success) return;
  const isFriend = db
    .select()
    .from(friends)
    .where(and(eq(friends.nodeId, senderNodeId), eq(friends.status, 'ACCEPTED')))
    .get();
  if (!isFriend) return;
  await handleChatMessage(result.data, senderNodeId, db, localNodeId);
}

export async function dispatchGroupCreateMessage(
  msg: InnerMessage,
  senderNodeId: string,
  db: Db,
): Promise<void> {
  if (msg.type !== 'group-create') return;
  const result = GroupCreateMessageSchema.safeParse(msg);
  if (!result.success) return;
  const isFriend = db
    .select()
    .from(friends)
    .where(and(eq(friends.nodeId, senderNodeId), eq(friends.status, 'ACCEPTED')))
    .get();
  if (!isFriend) return;
  await handleGroupCreate(result.data, db);
}

export function sendEncrypted(ws: ServerWebSocket<PeerData>, msg: InnerMessage): void {
  const state = ws.data.state;
  if (state.phase !== 'authenticated') throw new Error('Not authenticated');
  ws.send(encodeMessage(encryptMessage(msg, state.sessionKey)));
}

export async function dispatchVouchMessage(
  msg: InnerMessage,
  senderNodeId: string,
  db: Db,
): Promise<void> {
  if (msg.type === 'friend-vouch-request') {
    const result = FriendVouchRequestMessageSchema.safeParse(msg);
    if (!result.success) return;
    const isFriend = db
      .select()
      .from(friends)
      .where(and(eq(friends.nodeId, senderNodeId), eq(friends.status, 'ACCEPTED')))
      .get();
    if (!isFriend) return;
    const isVouched = db
      .select()
      .from(friends)
      .where(and(eq(friends.nodeId, result.data.nodeId), eq(friends.status, 'ACCEPTED')))
      .get();
    const senderPeer = getConnectedPeer(senderNodeId);
    if (!senderPeer) return;
    try {
      sendToPeer(senderPeer, {
        type: 'friend-vouch-response',
        nodeId: result.data.nodeId,
        vouched: !!isVouched,
      });
    } catch {
      // peer disconnected between lookup and send
    }
  } else if (msg.type === 'friend-vouch-response') {
    const result = FriendVouchResponseMessageSchema.safeParse(msg);
    if (!result.success) return;
    const isFriend = db
      .select()
      .from(friends)
      .where(and(eq(friends.nodeId, senderNodeId), eq(friends.status, 'ACCEPTED')))
      .get();
    if (!isFriend) return;
    resolveVouch(senderNodeId, result.data.nodeId, result.data.vouched);
  }
}
