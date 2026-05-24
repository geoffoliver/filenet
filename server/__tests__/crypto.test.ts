import {
  decrypt,
  deriveSessionKey,
  encrypt,
  generateEphemeralKeypair,
  sign,
  verify,
} from '../crypto';
import {
  describe, expect, it, 
} from 'bun:test';
import { generateIdentity } from '../identity';

describe('sign / verify', () => {
  it('signs and verifies a message', () => {
    const identity = generateIdentity();
    const data = Buffer.from('hello filenet');
    const sig = sign(data, identity.privateKey);
    expect(verify(data, sig, identity.publicKey)).toBe(true);
  });

  it('rejects a tampered message', () => {
    const identity = generateIdentity();
    const data = Buffer.from('hello filenet');
    const sig = sign(data, identity.privateKey);
    const tampered = Buffer.from('hello FILENET');
    expect(verify(tampered, sig, identity.publicKey)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const data = Buffer.from('hello');
    const sig = sign(data, alice.privateKey);
    expect(verify(data, sig, bob.publicKey)).toBe(false);
  });
});

describe('generateEphemeralKeypair', () => {
  it('returns a public and private key', () => {
    const kp = generateEphemeralKeypair();
    expect(kp.publicKey).toBeInstanceOf(Buffer);
    expect(kp.privateKey).toBeInstanceOf(Buffer);
    expect(kp.publicKey.length).toBeGreaterThan(0);
    expect(kp.privateKey.length).toBeGreaterThan(0);
  });

  it('produces unique keypairs', () => {
    const a = generateEphemeralKeypair();
    const b = generateEphemeralKeypair();
    expect(a.publicKey.toString('hex')).not.toBe(b.publicKey.toString('hex'));
  });
});

describe('deriveSessionKey', () => {
  it('both sides derive the same session key', () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();
    const salt = Buffer.from('test-salt');

    const aliceKey = deriveSessionKey(alice.privateKey, bob.publicKey, salt);
    const bobKey = deriveSessionKey(bob.privateKey, alice.publicKey, salt);

    expect(aliceKey.toString('hex')).toBe(bobKey.toString('hex'));
    expect(aliceKey.length).toBe(32);
  });

  it('different salts produce different keys', () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();

    const key1 = deriveSessionKey(alice.privateKey, bob.publicKey, Buffer.from('salt-1'));
    const key2 = deriveSessionKey(alice.privateKey, bob.publicKey, Buffer.from('salt-2'));

    expect(key1.toString('hex')).not.toBe(key2.toString('hex'));
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips plaintext', () => {
    const key = Buffer.alloc(32, 0xab);
    const plaintext = Buffer.from('secret message');
    const payload = encrypt(plaintext, key);
    const result = decrypt(payload, key);
    expect(result.toString()).toBe('secret message');
  });

  it('each encryption produces a unique payload (random IV)', () => {
    const key = Buffer.alloc(32, 0xab);
    const plaintext = Buffer.from('same message');
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a.toString('hex')).not.toBe(b.toString('hex'));
  });

  it('rejects tampered ciphertext', () => {
    const key = Buffer.alloc(32, 0xab);
    const payload = encrypt(Buffer.from('hello'), key);
    payload[30] ^= 0xff; // flip bits in ciphertext
    expect(() => decrypt(payload, key)).toThrow();
  });

  it('rejects the wrong key', () => {
    const key = Buffer.alloc(32, 0xab);
    const wrongKey = Buffer.alloc(32, 0xcd);
    const payload = encrypt(Buffer.from('hello'), key);
    expect(() => decrypt(payload, wrongKey)).toThrow();
  });
});
