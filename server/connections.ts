import type { PrismaClient } from '@prisma/client';

import type { FriendRequestMessage, FriendResponseMessage, InnerMessage } from './types';
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
import type { Identity } from './identity';
import { getOrCreateSettings } from './config';

export type ConnectedPeer = {
  ws: WebSocket;
  sessionKey: Buffer;
  peerNodeId: string;
  peerPublicKey: Buffer;
  address: string;
  port: number;
};

const peers = new Map<string, ConnectedPeer>();

export function getConnectedPeer(nodeId: string): ConnectedPeer | undefined {
  return peers.get(nodeId);
}

export function getAllConnectedPeers(): ConnectedPeer[] {
  return Array.from(peers.values());
}

export function sendToPeer(peer: ConnectedPeer, msg: InnerMessage): void {
  peer.ws.send(encodeMessage(encryptMessage(msg, peer.sessionKey)));
}

export async function connectToPeer(
  identity: Identity,
  prisma: PrismaClient,
  address: string,
  port: number,
  localPort: number,
  friendRequest?: { name: string; password?: string },
): Promise<ConnectedPeer> {
  const url = `ws://${address}:${port}`;
  const ws = new WebSocket(url);

  return new Promise((resolve, reject) => {
    const ephemeral = generateEphemeralKeypair();
    const hello = createHello(identity, ephemeral);
    let sessionKey: Buffer | null = null;
    let peerNodeId: string | null = null;
    let peerPublicKey: Buffer | null = null;

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

          const peer: ConnectedPeer = {
            ws,
            sessionKey: sk,
            peerNodeId: wire.nodeId,
            peerPublicKey: Buffer.from(wire.publicKey, 'base64'),
            address,
            port,
          };
          peers.set(wire.nodeId, peer);

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
        }
      } catch (err) {
        reject(err);
      }
    };

    ws.onerror = (err) => reject(err);
    ws.onclose = (event) => {
      if (peerNodeId) peers.delete(peerNodeId);
      if (!sessionKey) reject(new Error(`Connection closed before handshake: ${event.reason}`));
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
    const response = msg as FriendResponseMessage;
    if (response.accepted) {
      const existing = await prisma.friend.findFirst({
        where: { address: peer.address, port: peer.port },
      });
      if (existing) {
        await acceptFriendRequest(prisma, existing.id);
        await prisma.friend.update({
          where: { id: existing.id },
          data: {
            nodeId: peer.nodeId,
            publicKey: peer.publicKey.toString('base64'),
            ...(response.name ? { name: response.name } : {}),
          },
        });
      }
    }
  }
}

export async function handleInboundFriendRequest(
  identity: Identity,
  prisma: PrismaClient,
  msg: FriendRequestMessage,
  peer: { nodeId: string; publicKey: Buffer; address: string; port: number },
  sendResponse: (msg: InnerMessage) => void,
): Promise<void> {
  const settings = await getOrCreateSettings(prisma);
  const autoAccept = shouldAutoAccept(settings, msg.password);

  const friend = await handleIncomingFriendRequest(prisma, {
    nodeId: peer.nodeId,
    publicKey: peer.publicKey.toString('base64'),
    name: msg.name,
    address: peer.address,
    port: msg.port,
  });

  if (autoAccept) {
    await acceptFriendRequest(prisma, friend.id);
    sendResponse({
      type: 'friend-response',
      accepted: true,
      name: settings.name || undefined,
    });
  } else {
    sendResponse({ type: 'friend-response', accepted: false });
  }
}
