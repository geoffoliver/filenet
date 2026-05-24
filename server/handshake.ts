import crypto from 'crypto';

import type { HelloAckMessage, HelloMessage, InnerMessage, WireMessage } from './types';
import {
  decrypt,
  deriveSessionKey,
  encrypt,
  generateEphemeralKeypair,
  sign,
  verify,
} from './crypto';
import type { Identity } from './identity';

type EphemeralKeypair = ReturnType<typeof generateEphemeralKeypair>;

export { generateEphemeralKeypair };

export function createHello(identity: Identity, ephemeral: EphemeralKeypair): HelloMessage {
  return {
    type: 'hello',
    nodeId: identity.nodeId,
    publicKey: identity.publicKey.toString('base64'),
    ephemeralKey: ephemeral.publicKey.toString('base64'),
    nonce: crypto.randomBytes(32).toString('base64'),
  };
}

export function createHelloAck(
  identity: Identity,
  hello: HelloMessage,
): { ack: HelloAckMessage; ephemeral: EphemeralKeypair } {
  const ephemeral = generateEphemeralKeypair();
  const nonce = crypto.randomBytes(32).toString('base64');
  const sigData = Buffer.concat([Buffer.from(hello.nonce, 'base64'), Buffer.from(nonce, 'base64')]);
  return {
    ack: {
      type: 'hello-ack',
      nodeId: identity.nodeId,
      publicKey: identity.publicKey.toString('base64'),
      ephemeralKey: ephemeral.publicKey.toString('base64'),
      nonce,
      signature: sign(sigData, identity.privateKey).toString('base64'),
    },
    ephemeral,
  };
}

export function processHelloAck(
  identity: Identity,
  myEphemeral: EphemeralKeypair,
  hello: HelloMessage,
  ack: HelloAckMessage,
): { sessionKey: Buffer; ready: Buffer } {
  const receiverPubKey = Buffer.from(ack.publicKey, 'base64');
  const sigData = Buffer.concat([
    Buffer.from(hello.nonce, 'base64'),
    Buffer.from(ack.nonce, 'base64'),
  ]);

  if (!verify(sigData, Buffer.from(ack.signature, 'base64'), receiverPubKey)) {
    throw new Error('Invalid hello-ack signature');
  }

  const salt = Buffer.concat([
    Buffer.from(hello.nonce, 'base64'),
    Buffer.from(ack.nonce, 'base64'),
  ]);
  const sessionKey = deriveSessionKey(
    myEphemeral.privateKey,
    Buffer.from(ack.ephemeralKey, 'base64'),
    salt,
  );

  const readyPayload: InnerMessage = {
    type: 'ready',
    signature: sign(sigData, identity.privateKey).toString('base64'),
  };
  const ready = encrypt(Buffer.from(JSON.stringify(readyPayload)), sessionKey);

  return { sessionKey, ready };
}

export function finalizeHandshake(
  identity: Identity,
  myEphemeral: EphemeralKeypair,
  hello: HelloMessage,
  ack: HelloAckMessage,
  initiatorPublicKey: Buffer,
  encryptedReady: Buffer,
): Buffer {
  const salt = Buffer.concat([
    Buffer.from(hello.nonce, 'base64'),
    Buffer.from(ack.nonce, 'base64'),
  ]);
  const sessionKey = deriveSessionKey(
    myEphemeral.privateKey,
    Buffer.from(hello.ephemeralKey, 'base64'),
    salt,
  );

  const readyJson = decrypt(encryptedReady, sessionKey);
  const ready = JSON.parse(readyJson.toString()) as InnerMessage;
  if (ready.type !== 'ready') throw new Error('Expected ready message');

  const sigData = Buffer.concat([
    Buffer.from(hello.nonce, 'base64'),
    Buffer.from(ack.nonce, 'base64'),
  ]);

  if (!verify(sigData, Buffer.from(ready.signature, 'base64'), initiatorPublicKey)) {
    throw new Error('Invalid ready signature — initiator identity check failed');
  }

  return sessionKey;
}

export function encodeMessage(msg: WireMessage): string {
  return JSON.stringify(msg);
}

export function decodeMessage(raw: string | Buffer): WireMessage {
  return JSON.parse(typeof raw === 'string' ? raw : raw.toString());
}

export function encryptMessage(msg: InnerMessage, sessionKey: Buffer): WireMessage {
  const payload = encrypt(Buffer.from(JSON.stringify(msg)), sessionKey);
  return { type: 'encrypted', payload: payload.toString('base64') };
}

export function decryptMessage(wire: WireMessage, sessionKey: Buffer): InnerMessage {
  if (wire.type !== 'encrypted') throw new Error('Expected encrypted message');
  const payload = decrypt(Buffer.from(wire.payload, 'base64'), sessionKey);
  return JSON.parse(payload.toString());
}
