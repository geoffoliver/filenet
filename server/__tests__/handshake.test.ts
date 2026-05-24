import {
  createHello,
  createHelloAck,
  decodeMessage,
  encodeMessage,
  finalizeHandshake,
  processHelloAck,
} from '../handshake';
import { describe, expect, it } from 'bun:test';
import { generateEphemeralKeypair, verify } from '../crypto';
import { generateIdentity } from '../identity';

describe('createHello', () => {
  it('produces a valid hello message', () => {
    const identity = generateIdentity();
    const ephemeral = generateEphemeralKeypair();
    const hello = createHello(identity, ephemeral);

    expect(hello.type).toBe('hello');
    expect(hello.nodeId).toBe(identity.nodeId);
    expect(hello.publicKey).toBeTypeOf('string');
    expect(hello.ephemeralKey).toBeTypeOf('string');
    expect(hello.nonce).toBeTypeOf('string');
    expect(Buffer.from(hello.nonce, 'base64').length).toBe(32);
  });

  it('produces a unique nonce each call', () => {
    const identity = generateIdentity();
    const ephemeral = generateEphemeralKeypair();
    const a = createHello(identity, ephemeral);
    const b = createHello(identity, ephemeral);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('createHelloAck', () => {
  it("signs both nonces with the receiver's identity key", () => {
    const initiator = generateIdentity();
    const receiver = generateIdentity();
    const initEph = generateEphemeralKeypair();
    const hello = createHello(initiator, initEph);

    const { ack } = createHelloAck(receiver, hello);

    expect(ack.type).toBe('hello-ack');
    expect(ack.nodeId).toBe(receiver.nodeId);
    expect(ack.signature).toBeTypeOf('string');

    const sigData = Buffer.concat([
      Buffer.from(hello.nonce, 'base64'),
      Buffer.from(ack.nonce, 'base64'),
    ]);
    expect(verify(sigData, Buffer.from(ack.signature, 'base64'), receiver.publicKey)).toBe(true);
  });
});

describe('full handshake', () => {
  it('both sides derive the same session key', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aliceEph = generateEphemeralKeypair();

    const hello = createHello(alice, aliceEph);
    const { ack, ephemeral: bobEph } = createHelloAck(bob, hello);

    const { sessionKey: aliceKey, ready } = processHelloAck(alice, aliceEph, hello, ack);

    const bobKey = finalizeHandshake(bob, bobEph, hello, ack, alice.publicKey, ready);

    expect(aliceKey.toString('hex')).toBe(bobKey.toString('hex'));
    expect(aliceKey.length).toBe(32);
  });

  it('rejects a tampered hello-ack signature', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aliceEph = generateEphemeralKeypair();

    const hello = createHello(alice, aliceEph);
    const { ack } = createHelloAck(bob, hello);

    const tampered = { ...ack, signature: Buffer.alloc(64).toString('base64') };

    expect(() => processHelloAck(alice, aliceEph, hello, tampered)).toThrow();
  });

  it('rejects a ready message with a bad signature', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const eve = generateIdentity(); // impersonator
    const aliceEph = generateEphemeralKeypair();

    const hello = createHello(alice, aliceEph);
    const { ack, ephemeral: bobEph } = createHelloAck(bob, hello);
    const { ready } = processHelloAck(alice, aliceEph, hello, ack);

    expect(() => finalizeHandshake(bob, bobEph, hello, ack, eve.publicKey, ready)).toThrow();
  });
});

describe('encodeMessage / decodeMessage', () => {
  it('round-trips a wire message', () => {
    const msg = { type: 'encrypted' as const, payload: 'abc123' };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });
});
