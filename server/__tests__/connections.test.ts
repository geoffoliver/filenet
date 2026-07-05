import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { unlinkSync } from 'fs';

import {
  type ConnectedPeer,
  closeAndUnregisterPeer,
  connectToPeer,
  getConnectedPeer,
  handleInboundFriendRequest,
  notifyFriendAccepted,
  notifyFriendRejected,
  queryVouch,
  registerPeer,
  resetVouchesForTesting,
  resolveVouch,
  unregisterPeer,
  updatePeerPort,
} from '../connections';
import { type Db, applyMigrations, createDb } from '../db';
import {
  createHello,
  createHelloAck as createHelloAck_forTest,
  decodeMessage,
  decryptMessage,
  encodeMessage,
  generateEphemeralKeypair,
  processHelloAck,
} from '../handshake';
import { dispatchMessage, handleMessage } from '../peer';
import { friends, identity as identityTable, settings } from '../schema';
import { getOrCreateSettings, updateSettings } from '../config';
import type { InnerMessage } from '../types';
import type { PeerData } from '../peer';
import { generateIdentity } from '../identity';

const TEST_DB_URL = 'file:./data/test-connections.db';
let db: Db;

beforeAll(() => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
});

afterAll(() => {
  db.$client.close();
  try {
    unlinkSync('./data/test-connections.db');
  } catch {}
});

beforeEach(() => {
  db.delete(identityTable).run();
  db.delete(friends).run();
  db.delete(settings).run();
});

describe('initiator handshake side (processHelloAck)', () => {
  it('produces a session key and encrypted ready message', () => {
    const initiator = generateIdentity();
    const responder = generateIdentity();
    const initiatorEph = generateEphemeralKeypair();
    const hello = createHello(initiator, initiatorEph);
    const { ack } = createHelloAck_forTest(responder, hello);
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
    const { ack } = createHelloAck_forTest(attacker, hello);
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
    const sentMessages: string[] = [];
    const ws = makeFakeWs(responder, sentMessages);
    handleMessage(ws as any, encodeMessage(hello));
    expect(sentMessages.length).toBe(1);
    const ack = decodeMessage(sentMessages[0]);
    expect(ack.type).toBe('hello-ack');
    if (ack.type !== 'hello-ack') throw new Error('unreachable');
    const { sessionKey, ready } = processHelloAck(initiator, initiatorEph, hello, ack);
    const readyWire = { type: 'encrypted' as const, payload: ready.toString('base64') };
    handleMessage(ws as any, encodeMessage(readyWire));
    expect(ws.data.state.phase).toBe('authenticated');
    if (ws.data.state.phase !== 'authenticated') throw new Error('unreachable');
    expect(ws.data.state.peerNodeId).toBe(initiator.nodeId);
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

  it('registerPeer closes the old socket when a peer reconnects with the same nodeId', () => {
    const peer1 = generateIdentity();
    const sessionKey = Buffer.alloc(32, 0xab);
    const closeCalls: string[] = [];
    const oldWs = { send: (_m: string) => {}, close: () => closeCalls.push('old') } as any;
    const newWs = { send: (_m: string) => {}, close: () => closeCalls.push('new') } as any;
    registerPeer(oldWs, sessionKey, peer1.nodeId, peer1.publicKey, '10.0.0.2', 7734);
    registerPeer(newWs, sessionKey, peer1.nodeId, peer1.publicKey, '10.0.0.2', 7734);
    expect(closeCalls).toEqual(['old']);
    expect(getConnectedPeer(peer1.nodeId)?.ws).toBe(newWs);
    unregisterPeer(peer1.nodeId);
  });

  it('closeAndUnregisterPeer closes the socket and removes it from the registry', () => {
    const peer1 = generateIdentity();
    const sessionKey = Buffer.alloc(32, 0xcd);
    const closed: boolean[] = [];
    const fakeWs = { send: (_m: string) => {}, close: () => closed.push(true) } as any;
    registerPeer(fakeWs, sessionKey, peer1.nodeId, peer1.publicKey, '10.0.0.4', 7734);
    closeAndUnregisterPeer(peer1.nodeId);
    expect(closed.length).toBe(1);
    expect(getConnectedPeer(peer1.nodeId)).toBeUndefined();
  });

  it('updatePeerPort corrects the port after a friend-request reveals the listening port', () => {
    const peer1 = generateIdentity();
    const sessionKey = Buffer.alloc(32, 0xcd);
    const fakeWs = { send: (_m: string) => {} } as any;
    registerPeer(fakeWs, sessionKey, peer1.nodeId, peer1.publicKey, '10.0.0.3', 0);
    expect(getConnectedPeer(peer1.nodeId)?.port).toBe(0);
    updatePeerPort(peer1.nodeId, 7734);
    expect(getConnectedPeer(peer1.nodeId)?.port).toBe(7734);
    unregisterPeer(peer1.nodeId);
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
    await getOrCreateSettings(db);
    const responses: unknown[] = [];
    await handleInboundFriendRequest(identity, db, msg, peer, (r) => responses.push(r));
    expect(responses.length).toBe(0);
    const rows = db.select().from(friends).all();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('INCOMING_PENDING');
  });

  it('accepts and sends friend-response when autoAcceptFromAnyone is on', async () => {
    await updateSettings(db, { autoAcceptFromAnyone: true });
    const responses: unknown[] = [];
    await handleInboundFriendRequest(identity, db, msg, peer, (r) => responses.push(r));
    expect(responses).toHaveLength(1);
    expect((responses[0] as any).type).toBe('friend-response');
    expect((responses[0] as any).accepted).toBe(true);
    const rows = db.select().from(friends).all();
    expect(rows[0].status).toBe('ACCEPTED');
  });

  it('accepts when correct password provided', async () => {
    await updateSettings(db, { invitePassword: 'sesame' });
    const msgWithPass = { ...msg, password: 'sesame' };
    const responses: unknown[] = [];
    await handleInboundFriendRequest(identity, db, msgWithPass, peer, (r) => responses.push(r));
    expect((responses[0] as any).accepted).toBe(true);
  });

  it('sends no response and does not accept when the matched friend is BLOCKED', async () => {
    await updateSettings(db, { autoAcceptFromAnyone: true });
    const now = new Date();
    db.insert(friends)
      .values({
        id: randomUUID(),
        name: 'Blocked',
        nodeId: peer.nodeId,
        publicKey: peer.publicKey.toString('base64'),
        address: peer.address,
        port: peer.port,
        status: 'BLOCKED',
        addedAt: now,
        updatedAt: now,
      })
      .run();
    const responses: unknown[] = [];
    await handleInboundFriendRequest(identity, db, msg, peer, (r) => responses.push(r));
    expect(responses.length).toBe(0);
    const rows = db.select().from(friends).all();
    expect(rows[0].status).toBe('BLOCKED');
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

describe('peer.ts dispatchMessage — inbound friend-response', () => {
  it('accepts OUTGOING_PENDING friend and updates name when accepted=true', async () => {
    const sessionKey = Buffer.alloc(32, 0x50);
    const peerIdentity = generateIdentity();
    const localIdentity = generateIdentity();
    const now = new Date();
    db.insert(friends)
      .values({
        id: randomUUID(),
        name: 'Old Name',
        nodeId: peerIdentity.nodeId,
        publicKey: peerIdentity.publicKey.toString('base64'),
        address: '10.0.0.20',
        port: 7734,
        status: 'OUTGOING_PENDING',
        addedAt: now,
        updatedAt: now,
      })
      .run();
    const ws = makeFakeWsAuthenticated(localIdentity, db, sessionKey, peerIdentity.nodeId);
    await dispatchMessage(ws as any, { type: 'friend-response', accepted: true, name: 'New Name' });
    const friend = db.select().from(friends).where(eq(friends.nodeId, peerIdentity.nodeId)).get();
    expect(friend?.status).toBe('ACCEPTED');
    expect(friend?.name).toBe('New Name');
  });

  it('keeps existing name when accepted=true and name is absent', async () => {
    const sessionKey = Buffer.alloc(32, 0x51);
    const peerIdentity = generateIdentity();
    const localIdentity = generateIdentity();
    const now = new Date();
    db.insert(friends)
      .values({
        id: randomUUID(),
        name: 'Keep Me',
        nodeId: peerIdentity.nodeId,
        publicKey: peerIdentity.publicKey.toString('base64'),
        address: '10.0.0.21',
        port: 7734,
        status: 'OUTGOING_PENDING',
        addedAt: now,
        updatedAt: now,
      })
      .run();
    const ws = makeFakeWsAuthenticated(localIdentity, db, sessionKey, peerIdentity.nodeId);
    await dispatchMessage(ws as any, { type: 'friend-response', accepted: true });
    const friend = db.select().from(friends).where(eq(friends.nodeId, peerIdentity.nodeId)).get();
    expect(friend?.status).toBe('ACCEPTED');
    expect(friend?.name).toBe('Keep Me');
  });

  it('deletes friend record and closes peer when accepted=false', async () => {
    const sessionKey = Buffer.alloc(32, 0x52);
    const peerIdentity = generateIdentity();
    const localIdentity = generateIdentity();
    const now = new Date();
    db.insert(friends)
      .values({
        id: randomUUID(),
        name: 'Rejected',
        nodeId: peerIdentity.nodeId,
        publicKey: peerIdentity.publicKey.toString('base64'),
        address: '10.0.0.22',
        port: 7734,
        status: 'OUTGOING_PENDING',
        addedAt: now,
        updatedAt: now,
      })
      .run();
    const fakeWs = { send: (_m: string) => {}, close: () => {} } as any;
    registerPeer(
      fakeWs,
      sessionKey,
      peerIdentity.nodeId,
      peerIdentity.publicKey,
      '10.0.0.22',
      7734,
    );
    const ws = makeFakeWsAuthenticated(localIdentity, db, sessionKey, peerIdentity.nodeId);
    await dispatchMessage(ws as any, { type: 'friend-response', accepted: false });
    const friend = db.select().from(friends).where(eq(friends.nodeId, peerIdentity.nodeId)).get();
    expect(friend).toBeUndefined();
    expect(getConnectedPeer(peerIdentity.nodeId)).toBeUndefined();
  });

  it('ignores friend-response when no matching friend record exists', async () => {
    const sessionKey = Buffer.alloc(32, 0x53);
    const peerIdentity = generateIdentity();
    const localIdentity = generateIdentity();
    const ws = makeFakeWsAuthenticated(localIdentity, db, sessionKey, peerIdentity.nodeId);
    await dispatchMessage(ws as any, { type: 'friend-response', accepted: true, name: 'Ghost' });
    expect(db.select().from(friends).all().length).toBe(0);
  });
});

describe('peer.ts handleMessage — onAuthenticated ordering', () => {
  it('invokes onAuthenticated only after dispatchMessage has committed DB changes', async () => {
    const sessionKey = Buffer.alloc(32, 0x60);
    const peerIdentity = generateIdentity();
    const localIdentity = generateIdentity();
    const now = new Date();
    db.insert(friends)
      .values({
        id: randomUUID(),
        name: 'Ordering Test',
        nodeId: peerIdentity.nodeId,
        publicKey: peerIdentity.publicKey.toString('base64'),
        address: '10.0.0.30',
        port: 7734,
        status: 'OUTGOING_PENDING',
        addedAt: now,
        updatedAt: now,
      })
      .run();
    const ws = makeFakeWsAuthenticated(localIdentity, db, sessionKey, peerIdentity.nodeId);
    let dbStatusAtCallback: string | null | undefined;
    const { encryptMessage } = await import('../handshake');
    await new Promise<void>((resolve) => {
      handleMessage(
        ws as any,
        encodeMessage(encryptMessage({ type: 'friend-response', accepted: true }, sessionKey)),
        async () => {
          const friend = db
            .select()
            .from(friends)
            .where(eq(friends.nodeId, peerIdentity.nodeId))
            .get();
          dbStatusAtCallback = friend?.status;
          resolve();
        },
      );
    });
    expect(dbStatusAtCallback).toBe('ACCEPTED');
  });
});

describe('queryVouch', () => {
  afterEach(() => {
    resetVouchesForTesting();
  });

  it('returns false immediately when peers list is empty', async () => {
    expect(await queryVouch('candidate', [])).toBe(false);
  });

  it('returns false after timeout when no peer responds', async () => {
    const fakePeer = makeFakePeer('voucher1');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const result = await queryVouch(
      'candidate',
      [fakePeer],
      (p, m) => sent.push({ peer: p, msg: m }),
      50,
    );
    expect(result).toBe(false);
    expect(sent.length).toBe(1);
    expect(sent[0].msg.type).toBe('friend-vouch-request');
  });

  it('returns true when resolveVouch is called with vouched=true before timeout', async () => {
    const fakePeer = makeFakePeer('voucher2');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const queryPromise = queryVouch(
      'candidate',
      [fakePeer],
      (p, m) => sent.push({ peer: p, msg: m }),
      2_000,
    );
    await Bun.sleep(10);
    resolveVouch('voucher2', 'candidate', true);
    expect(await queryPromise).toBe(true);
  });

  it('returns false once all queried peers respond with vouched=false', async () => {
    const peer1 = makeFakePeer('voucher3a');
    const peer2 = makeFakePeer('voucher3b');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const queryPromise = queryVouch(
      'candidate',
      [peer1, peer2],
      (p, m) => sent.push({ peer: p, msg: m }),
      2_000,
    );
    await Bun.sleep(10);
    resolveVouch('voucher3a', 'candidate', false);
    resolveVouch('voucher3b', 'candidate', false);
    expect(await queryPromise).toBe(false);
  });

  it('resolves true as soon as the first peer vouches, before others respond', async () => {
    const peer1 = makeFakePeer('voucher4a');
    const peer2 = makeFakePeer('voucher4b');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const queryPromise = queryVouch(
      'candidate',
      [peer1, peer2],
      (p, m) => sent.push({ peer: p, msg: m }),
      2_000,
    );
    await Bun.sleep(10);
    resolveVouch('voucher4a', 'candidate', true);
    expect(await queryPromise).toBe(true);
  });

  it('ignores vouch responses from peers that were not queried', async () => {
    const fakePeer = makeFakePeer('voucher5');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const queryPromise = queryVouch(
      'candidate',
      [fakePeer],
      (p, m) => sent.push({ peer: p, msg: m }),
      2_000,
    );
    await Bun.sleep(10);
    resolveVouch('stranger-not-queried', 'candidate', true);
    resolveVouch('voucher5', 'candidate', false);
    expect(await queryPromise).toBe(false);
  });

  it('ignores responses for a candidateNodeId that has no pending vouch', () => {
    resolveVouch('some-peer', 'no-pending-candidate', true);
  });

  it('ignores a second false response from the same peer (double-response attack)', async () => {
    const peer1 = makeFakePeer('voucher6a');
    const peer2 = makeFakePeer('voucher6b');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const queryPromise = queryVouch(
      'candidate',
      [peer1, peer2],
      (p, m) => sent.push({ peer: p, msg: m }),
      2_000,
    );
    await Bun.sleep(10);
    resolveVouch('voucher6a', 'candidate', false);
    resolveVouch('voucher6a', 'candidate', false);
    resolveVouch('voucher6b', 'candidate', true);
    expect(await queryPromise).toBe(true);
  });

  it('returns false when all peers respond false exactly once each', async () => {
    const peer1 = makeFakePeer('voucher7a');
    const peer2 = makeFakePeer('voucher7b');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const queryPromise = queryVouch(
      'candidate',
      [peer1, peer2],
      (p, m) => sent.push({ peer: p, msg: m }),
      2_000,
    );
    await Bun.sleep(10);
    resolveVouch('voucher7a', 'candidate', false);
    resolveVouch('voucher7b', 'candidate', false);
    expect(await queryPromise).toBe(false);
  });

  it('returns false immediately when MAX_PENDING_VOUCHES is reached', async () => {
    const { MAX_PENDING_VOUCHES: cap } = await import('../connections');
    for (let i = 0; i < cap; i++) {
      void queryVouch(`flood-candidate-${i}`, [makeFakePeer(`flood-peer-${i}`)], () => {}, 60_000);
    }
    const result = await queryVouch(
      'overflow-candidate',
      [makeFakePeer('overflow-peer')],
      () => {},
      50,
    );
    expect(result).toBe(false);
  });

  it('returns false immediately for a duplicate candidateNodeId already in flight', async () => {
    const peer1 = makeFakePeer('collision-peer-1');
    const peer2 = makeFakePeer('collision-peer-2');
    const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
    const firstPromise = queryVouch(
      'collision-candidate',
      [peer1],
      (p, m) => sent.push({ peer: p, msg: m }),
      2_000,
    );
    const secondResult = await queryVouch(
      'collision-candidate',
      [peer2],
      (p, m) => sent.push({ peer: p, msg: m }),
      2_000,
    );
    expect(secondResult).toBe(false);
    resolveVouch('collision-peer-1', 'collision-candidate', false);
    expect(await firstPromise).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe('handleInboundFriendRequest — friends-of-friends auto-accept', () => {
  const identity = generateIdentity();

  afterEach(() => {
    resetVouchesForTesting();
    db.delete(friends).run();
  });

  it('auto-accepts when an accepted connected peer vouches the candidate', async () => {
    await updateSettings(db, { autoAcceptFromFriendsOfFriends: true });
    const voucherPeer = makeFakePeer('fof-voucher-1');
    registerPeer(
      voucherPeer.ws,
      voucherPeer.sessionKey,
      'fof-voucher-1',
      voucherPeer.peerPublicKey,
      '127.0.0.1',
      7734,
    );
    const now = new Date();
    db.insert(friends)
      .values({
        id: randomUUID(),
        name: 'Voucher',
        nodeId: 'fof-voucher-1',
        publicKey: 'fakekey',
        address: '127.0.0.1',
        port: 7734,
        status: 'ACCEPTED',
        addedAt: now,
        updatedAt: now,
      })
      .run();
    const candidatePeer = {
      nodeId: 'fof-candidate-1',
      publicKey: Buffer.from('fakekey'),
      address: '10.0.0.1',
      port: 7734,
    };
    const responses: unknown[] = [];
    const requestPromise = handleInboundFriendRequest(
      identity,
      db,
      { type: 'friend-request', name: 'Candidate', port: 7734 },
      candidatePeer,
      (r) => responses.push(r),
      2_000,
    );
    await Bun.sleep(20);
    resolveVouch('fof-voucher-1', 'fof-candidate-1', true);
    await requestPromise;
    expect(responses).toHaveLength(1);
    expect((responses[0] as any).type).toBe('friend-response');
    expect((responses[0] as any).accepted).toBe(true);
    const friend = db.select().from(friends).where(eq(friends.nodeId, 'fof-candidate-1')).get();
    expect(friend?.status).toBe('ACCEPTED');
    unregisterPeer('fof-voucher-1');
  });

  it('leaves as INCOMING_PENDING when no peer vouches within timeout', async () => {
    await updateSettings(db, { autoAcceptFromFriendsOfFriends: true });
    const voucherPeer = makeFakePeer('fof-voucher-2');
    registerPeer(
      voucherPeer.ws,
      voucherPeer.sessionKey,
      'fof-voucher-2',
      voucherPeer.peerPublicKey,
      '127.0.0.1',
      7734,
    );
    const now = new Date();
    db.insert(friends)
      .values({
        id: randomUUID(),
        name: 'Voucher2',
        nodeId: 'fof-voucher-2',
        publicKey: 'fakekey2',
        address: '127.0.0.1',
        port: 7734,
        status: 'ACCEPTED',
        addedAt: now,
        updatedAt: now,
      })
      .run();
    const candidatePeer = {
      nodeId: 'fof-candidate-2',
      publicKey: Buffer.from('fakekey'),
      address: '10.0.0.2',
      port: 7734,
    };
    const responses: unknown[] = [];
    await handleInboundFriendRequest(
      identity,
      db,
      { type: 'friend-request', name: 'Candidate2', port: 7734 },
      candidatePeer,
      (r) => responses.push(r),
      50,
    );
    expect(responses).toHaveLength(0);
    const friend = db.select().from(friends).where(eq(friends.nodeId, 'fof-candidate-2')).get();
    expect(friend?.status).toBe('INCOMING_PENDING');
    unregisterPeer('fof-voucher-2');
  });

  it('leaves as INCOMING_PENDING when no accepted peers are connected', async () => {
    await updateSettings(db, { autoAcceptFromFriendsOfFriends: true });
    const candidatePeer = {
      nodeId: 'fof-candidate-3',
      publicKey: Buffer.from('fakekey'),
      address: '10.0.0.3',
      port: 7734,
    };
    const responses: unknown[] = [];
    await handleInboundFriendRequest(
      identity,
      db,
      { type: 'friend-request', name: 'Candidate3', port: 7734 },
      candidatePeer,
      (r) => responses.push(r),
    );
    expect(responses).toHaveLength(0);
    const friend = db.select().from(friends).where(eq(friends.nodeId, 'fof-candidate-3')).get();
    expect(friend?.status).toBe('INCOMING_PENDING');
  });

  it('skips vouch query when autoAcceptFromAnyone already triggers auto-accept', async () => {
    await updateSettings(db, { autoAcceptFromAnyone: true, autoAcceptFromFriendsOfFriends: true });
    const voucherPeer = makeFakePeer('fof-voucher-4');
    const sent: InnerMessage[] = [];
    const sentWs = {
      send: (m: string | Uint8Array) => {
        sent.push(m as any);
      },
      close: () => {},
    };
    registerPeer(
      sentWs,
      voucherPeer.sessionKey,
      'fof-voucher-4',
      voucherPeer.peerPublicKey,
      '127.0.0.1',
      7734,
    );
    const now = new Date();
    db.insert(friends)
      .values({
        id: randomUUID(),
        name: 'Voucher4',
        nodeId: 'fof-voucher-4',
        publicKey: 'fakekey4',
        address: '127.0.0.1',
        port: 7734,
        status: 'ACCEPTED',
        addedAt: now,
        updatedAt: now,
      })
      .run();
    const responses: unknown[] = [];
    await handleInboundFriendRequest(
      identity,
      db,
      { type: 'friend-request', name: 'Candidate4', port: 7734 },
      {
        nodeId: 'fof-candidate-4',
        publicKey: Buffer.from('fakekey'),
        address: '10.0.0.4',
        port: 7734,
      },
      (r) => responses.push(r),
    );
    expect(responses).toHaveLength(1);
    expect((responses[0] as any).accepted).toBe(true);
    expect(sent).toHaveLength(0);
    unregisterPeer('fof-voucher-4');
  });

  it('excludes the requesting peer itself from vouch candidates', async () => {
    await updateSettings(db, { autoAcceptFromFriendsOfFriends: true });
    const candidateNodeId = 'fof-candidate-5';
    const candidatePeerObj = makeFakePeer(candidateNodeId);
    registerPeer(
      candidatePeerObj.ws,
      candidatePeerObj.sessionKey,
      candidateNodeId,
      candidatePeerObj.peerPublicKey,
      '10.0.0.5',
      7734,
    );
    const now = new Date();
    db.insert(friends)
      .values({
        id: randomUUID(),
        name: 'Self-Voucher',
        nodeId: candidateNodeId,
        publicKey: 'fakekey5',
        address: '10.0.0.5',
        port: 7734,
        status: 'ACCEPTED',
        addedAt: now,
        updatedAt: now,
      })
      .run();
    const responses: unknown[] = [];
    await handleInboundFriendRequest(
      identity,
      db,
      { type: 'friend-request', name: 'Candidate5', port: 7734 },
      {
        nodeId: candidateNodeId,
        publicKey: Buffer.from('fakekey'),
        address: '10.0.0.5',
        port: 7734,
      },
      (r) => responses.push(r),
      50,
    );
    expect(responses).toHaveLength(0);
    unregisterPeer(candidateNodeId);
    db.delete(friends).where(eq(friends.nodeId, candidateNodeId)).run();
  });
});

function makeFakePeer(nodeId: string): ConnectedPeer {
  return {
    ws: { send: () => {}, close: () => {} },
    sessionKey: Buffer.alloc(32),
    peerNodeId: nodeId,
    peerPublicKey: Buffer.alloc(32),
    address: '127.0.0.1',
    port: 7734,
  };
}

function makeFakeWs(identity: ReturnType<typeof generateIdentity>, sent: string[]) {
  return {
    data: { identity, state: { phase: 'pending' } as PeerData['state'] },
    send(msg: string) {
      sent.push(msg);
    },
    close(_code: number, _reason: string) {},
  };
}

function makeFakeWsAuthenticated(
  identity: ReturnType<typeof generateIdentity>,
  db: Db,
  sessionKey: Buffer,
  peerNodeId: string,
) {
  return {
    data: {
      identity,
      db,
      localPort: 7734,
      state: {
        phase: 'authenticated' as const,
        sessionKey,
        peerNodeId,
        peerPublicKey: Buffer.alloc(32),
      },
    },
    send(_msg: string) {},
    close(_code: number, _reason: string) {},
    remoteAddress: '10.0.0.1',
  };
}

describe('connectToPeer — handshake timeout', () => {
  it('rejects when the peer accepts the socket but never completes the handshake', async () => {
    const identity = generateIdentity();
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response('Not Found', { status: 404 });
      },
      websocket: { message() {} },
    });
    try {
      const start = Date.now();
      await expect(
        connectToPeer(identity, db, '127.0.0.1', server.port!, 7734, undefined, undefined, 300),
      ).rejects.toThrow(/Handshake timeout/);
      expect(Date.now() - start).toBeLessThan(2_000);
    } finally {
      server.stop(true);
    }
  });

  it('never registers the peer when the hello-ack arrives after the timeout', async () => {
    const initiator = generateIdentity();
    const responder = generateIdentity();
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response('Not Found', { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const wire = decodeMessage(typeof raw === 'string' ? raw : Buffer.from(raw));
          if (wire.type === 'hello') {
            const { ack } = createHelloAck_forTest(responder, wire);
            setTimeout(() => {
              try {
                ws.send(encodeMessage(ack));
              } catch {}
            }, 500);
          }
        },
      },
    });
    try {
      await expect(
        connectToPeer(initiator, db, '127.0.0.1', server.port!, 7734, undefined, undefined, 200),
      ).rejects.toThrow(/Handshake timeout/);
      await new Promise<void>((r) => setTimeout(r, 500));
      expect(getConnectedPeer(responder.nodeId)).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it('closes socket and discards subsequent messages when onmessage throws before handshake completes', async () => {
    const initiator = generateIdentity();
    const responder = generateIdentity();
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response('Not Found', { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const wire = decodeMessage(typeof raw === 'string' ? raw : Buffer.from(raw));
          if (wire.type === 'hello') {
            ws.send('not-valid-json');
            const { ack } = createHelloAck_forTest(responder, wire);
            setTimeout(() => {
              try {
                ws.send(encodeMessage(ack));
              } catch {}
            }, 200);
          }
        },
      },
    });
    try {
      const start = Date.now();
      await expect(
        connectToPeer(initiator, db, '127.0.0.1', server.port!, 7734, undefined, undefined, 5_000),
      ).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(2_000);
      await new Promise<void>((r) => setTimeout(r, 300));
      expect(getConnectedPeer(responder.nodeId)).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it('wraps IPv6 addresses in brackets so the WebSocket URL is valid', async () => {
    const identity = generateIdentity();

    let server: any;
    try {
      server = Bun.serve({
        hostname: '::1',
        port: 0,
        fetch(req, srv) {
          if (srv.upgrade(req)) return undefined;
          return new Response('Not Found', { status: 404 });
        },
        websocket: { message() {} },
      });
    } catch {
      return;
    }
    try {
      await expect(
        connectToPeer(identity, db, '::1', server.port, 7734, undefined, undefined, 300),
      ).rejects.toThrow(/Handshake timeout/);
    } finally {
      server.stop(true);
    }
  });

  it('does not double-bracket an already-bracketed IPv6 address', async () => {
    const identity = generateIdentity();

    let server: any;
    try {
      server = Bun.serve({
        hostname: '::1',
        port: 0,
        fetch(req, srv) {
          if (srv.upgrade(req)) return undefined;
          return new Response('Not Found', { status: 404 });
        },
        websocket: { message() {} },
      });
    } catch {
      return;
    }
    try {
      await expect(
        connectToPeer(identity, db, '[::1]', server.port, 7734, undefined, undefined, 300),
      ).rejects.toThrow(/Handshake timeout/);
    } finally {
      server.stop(true);
    }
  });

  it('rejects via onerror (not the timeout) when the server refuses the WebSocket upgrade', async () => {
    const identity = generateIdentity();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('Not a WebSocket', { status: 400 });
      },
      websocket: { message() {} },
    });
    try {
      const start = Date.now();
      await expect(
        connectToPeer(identity, db, '127.0.0.1', server.port!, 7734, undefined, undefined, 5_000),
      ).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(2_000);
    } finally {
      server.stop(true);
    }
  });
});
