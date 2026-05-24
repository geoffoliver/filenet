import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';

import {
  createHello,
  createHelloAck as createHelloAck_forTest,
  decodeMessage,
  decryptMessage,
  encodeMessage,
  generateEphemeralKeypair,
  processHelloAck,
} from '../handshake';
import {
  getConnectedPeer,
  handleInboundFriendRequest,
  notifyFriendAccepted,
  notifyFriendRejected,
  registerPeer,
  unregisterPeer,
} from '../connections';
import { getOrCreateSettings, updateSettings } from '../config';
import { createPrismaClient } from '../db';
import { generateIdentity } from '../identity';
import { handleMessage } from '../peer';

const TEST_DB_URL = 'file:./data/test-connections.db';
let prisma: PrismaClient;

beforeAll(() => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    unlinkSync('./data/test-connections.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.identity.deleteMany();
  await prisma.friend.deleteMany();
  await prisma.settings.deleteMany();
});

describe('initiator handshake side (processHelloAck)', () => {
  it('produces a session key and encrypted ready message', () => {
    const initiator = generateIdentity();
    const responder = generateIdentity();
    const initiatorEph = generateEphemeralKeypair();

    const hello = createHello(initiator, initiatorEph);

    // Simulate responder generating hello-ack
    const { ack } = createHelloAck_forTest(responder, hello, initiatorEph);

    const { sessionKey, ready } = processHelloAck(initiator, initiatorEph, hello, ack);
    expect(sessionKey).toBeInstanceOf(Buffer);
    expect(sessionKey.length).toBe(32);
    expect(ready).toBeInstanceOf(Buffer);
    expect(ready.length).toBeGreaterThan(0);
  });

  it('throws when hello-ack has a bad signature', () => {
    const initiator = generateIdentity();
    const attacker = generateIdentity();
    const initiatorEph = generateEphemeralKeypair();

    const hello = createHello(initiator, initiatorEph);
    const { ack } = createHelloAck_forTest(attacker, hello, initiatorEph);

    // Swap in initiator's public key to fake identity (attacker signed with wrong key)
    const tamperedAck = { ...ack, publicKey: initiator.publicKey.toString('base64') };

    expect(() => processHelloAck(initiator, initiatorEph, hello, tamperedAck)).toThrow();
  });
});

describe('full two-party handshake via handleMessage', () => {
  it('both sides reach authenticated state', async () => {
    const initiator = generateIdentity();
    const responder = generateIdentity();

    const initiatorEph = generateEphemeralKeypair();
    const hello = createHello(initiator, initiatorEph);

    // Simulate server receiving hello and responding with hello-ack
    const sentMessages: string[] = [];
    const ws = makeFakeWs(responder, sentMessages);

    handleMessage(ws as any, encodeMessage(hello));
    expect(sentMessages.length).toBe(1);
    const ack = decodeMessage(sentMessages[0]);
    expect(ack.type).toBe('hello-ack');
    if (ack.type !== 'hello-ack') throw new Error('unreachable');

    // Initiator processes hello-ack and sends encrypted ready
    const { sessionKey, ready } = processHelloAck(initiator, initiatorEph, hello, ack);

    // Server processes encrypted ready
    const readyWire = { type: 'encrypted' as const, payload: ready.toString('base64') };
    handleMessage(ws as any, encodeMessage(readyWire));

    // Server should now be authenticated
    expect(ws.data.state.phase).toBe('authenticated');
    if (ws.data.state.phase !== 'authenticated') throw new Error('unreachable');
    expect(ws.data.state.peerNodeId).toBe(initiator.nodeId);

    // Session keys should match
    expect(ws.data.state.sessionKey.toString('hex')).toBe(sessionKey.toString('hex'));
  });

  it('registerPeer adds peer to registry and getConnectedPeer finds it', () => {
    const peer1 = generateIdentity();
    const sessionKey = Buffer.alloc(32, 0xab);
    const fakeWs = { send: (_m: string) => {} } as any;

    registerPeer(fakeWs, sessionKey, peer1.nodeId, peer1.publicKey, '10.0.0.2', 7734);
    const found = getConnectedPeer(peer1.nodeId);
    expect(found).toBeDefined();
    expect(found?.peerNodeId).toBe(peer1.nodeId);
    expect(found?.sessionKey.toString('hex')).toBe(sessionKey.toString('hex'));

    unregisterPeer(peer1.nodeId);
    expect(getConnectedPeer(peer1.nodeId)).toBeUndefined();
  });
});

describe('handleInboundFriendRequest', () => {
  const peer = {
    nodeId: 'peer-node-id-abc123',
    publicKey: Buffer.from('fake-pub-key'),
    address: '10.0.0.1',
    port: 7734,
  };
  const identity = generateIdentity();
  const msg = { type: 'friend-request' as const, name: 'Alice', port: 7734 };

  it('stores INCOMING_PENDING and sends no response when auto-accept is off', async () => {
    await getOrCreateSettings(prisma);
    const responses: unknown[] = [];
    await handleInboundFriendRequest(identity, prisma, msg, peer, (r) => responses.push(r));
    expect(responses.length).toBe(0);
    const friends = await prisma.friend.findMany();
    expect(friends.length).toBe(1);
    expect(friends[0].status).toBe('INCOMING_PENDING');
  });

  it('accepts and sends friend-response when autoAcceptFromAnyone is on', async () => {
    await updateSettings(prisma, { autoAcceptFromAnyone: true });
    const responses: unknown[] = [];
    await handleInboundFriendRequest(identity, prisma, msg, peer, (r) => responses.push(r));
    expect(responses).toHaveLength(1);
    expect((responses[0] as any).type).toBe('friend-response');
    expect((responses[0] as any).accepted).toBe(true);
    const friends = await prisma.friend.findMany();
    expect(friends[0].status).toBe('ACCEPTED');
  });

  it('accepts when correct password provided', async () => {
    await updateSettings(prisma, { invitePassword: 'sesame' });
    const msgWithPass = { ...msg, password: 'sesame' };
    const responses: unknown[] = [];
    await handleInboundFriendRequest(identity, prisma, msgWithPass, peer, (r) => responses.push(r));
    expect((responses[0] as any).accepted).toBe(true);
  });
});

describe('notifyFriendAccepted / notifyFriendRejected', () => {
  it('sends friend-response accepted to a connected peer', () => {
    const sessionKey = Buffer.alloc(32, 0x42);
    const sent: string[] = [];
    const fakePeer = {
      ws: { send: (m: string) => sent.push(m) } as any,
      sessionKey,
      peerNodeId: 'fake-node',
      peerPublicKey: Buffer.alloc(32),
      address: '10.0.0.1',
      port: 7734,
    };

    notifyFriendAccepted(fakePeer, 'Bob');
    expect(sent.length).toBe(1);
    const wire = decodeMessage(sent[0]);
    if (wire.type !== 'encrypted') throw new Error('expected encrypted');
    const inner = decryptMessage(wire, sessionKey);
    expect(inner.type).toBe('friend-response');
    expect((inner as any).accepted).toBe(true);
    expect((inner as any).name).toBe('Bob');
  });

  it('sends friend-response rejected to a connected peer', () => {
    const sessionKey = Buffer.alloc(32, 0x42);
    const sent: string[] = [];
    const fakePeer = {
      ws: { send: (m: string) => sent.push(m) } as any,
      sessionKey,
      peerNodeId: 'fake-node',
      peerPublicKey: Buffer.alloc(32),
      address: '10.0.0.1',
      port: 7734,
    };

    notifyFriendRejected(fakePeer);
    expect(sent.length).toBe(1);
    const wire = decodeMessage(sent[0]);
    if (wire.type !== 'encrypted') throw new Error('expected encrypted');
    const inner = decryptMessage(wire, sessionKey);
    expect(inner.type).toBe('friend-response');
    expect((inner as any).accepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeWs(identity: ReturnType<typeof generateIdentity>, sent: string[]) {
  return {
    data: {
      identity,
      state: { phase: 'pending' as const },
    },
    send(msg: string) {
      sent.push(msg);
    },
    close(_code: number, _reason: string) {},
  };
}
