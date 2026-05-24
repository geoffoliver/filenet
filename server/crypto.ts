import crypto from 'crypto';

export function sign(data: Buffer, privateKeyDer: Buffer): Buffer {
  const key = crypto.createPrivateKey({
    key: privateKeyDer, format: 'der', type: 'pkcs8', 
  });
  return crypto.sign(null, data, key);
}

export function verify(data: Buffer, signature: Buffer, publicKeyDer: Buffer): boolean {
  const key = crypto.createPublicKey({
    key: publicKeyDer, format: 'der', type: 'spki', 
  });
  return crypto.verify(null, data, key, signature);
}

export function generateEphemeralKeypair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return { publicKey: publicKey as unknown as Buffer, privateKey: privateKey as unknown as Buffer };
}

export function deriveSessionKey(
  myEphemeralPrivateDer: Buffer,
  theirEphemeralPublicDer: Buffer,
  salt: Buffer,
): Buffer {
  const myKey = crypto.createPrivateKey({
    key: myEphemeralPrivateDer, format: 'der', type: 'pkcs8', 
  });
  const theirKey = crypto.createPublicKey({
    key: theirEphemeralPublicDer, format: 'der', type: 'spki', 
  });
  const sharedSecret = crypto.diffieHellman({ privateKey: myKey, publicKey: theirKey });
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.alloc(0), 32));
}

// Returns: iv (12 bytes) + auth tag (16 bytes) + ciphertext
export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

// Input: iv (12) + auth tag (16) + ciphertext
export function decrypt(payload: Buffer, key: Buffer): Buffer {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
