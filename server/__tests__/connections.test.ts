import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';

import {
  createHello,
  createHelloAck as createHelloAck_forTest,
  decodeMessage,
  encodeMessage,
  generateEphemeralKeypair,
  processHelloAck,
} from '../handshake';
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
