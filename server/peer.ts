import type { PrismaClient } from '@prisma/client';
import type { ServerWebSocket } from 'bun';

import type { HelloAckMessage, HelloMessage, InnerMessage } from './types';
import {
  createHelloAck,
  decodeMessage,
  decryptMessage,
  encodeMessage,
  encryptMessage,
  finalizeHandshake,
  generateEphemeralKeypair,
} from './handshake';
import { handleInboundFriendRequest, registerPeer, updatePeerPort } from './connections';
import { FriendRequestMessageSchema } from './schemas';
import type { Identity } from './identity';

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
        dispatchMessage(ws, msg).catch(() => ws.close(1011, 'Internal error'));
        onAuthenticated?.(ws, msg);
      } catch {
        ws.close(1008, 'Decryption failed');
      }
    }
  }
}

async function dispatchMessage(ws: ServerWebSocket<PeerData>, msg: InnerMessage): Promise<void> {
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
  }
}

export function sendEncrypted(ws: ServerWebSocket<PeerData>, msg: InnerMessage): void {
  const state = ws.data.state;
  if (state.phase !== 'authenticated') throw new Error('Not authenticated');
  ws.send(encodeMessage(encryptMessage(msg, state.sessionKey)));
}
