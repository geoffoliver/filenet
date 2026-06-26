import crypto from 'crypto';
import { randomUUID } from 'node:crypto';

import type { Db } from './db';
import { identity as identityTable } from './schema';

export type Identity = {
  nodeId: string;
  publicKey: Buffer; // SPKI DER Ed25519
  privateKey: Buffer; // PKCS8 DER Ed25519
};

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const pubBuf = publicKey as unknown as Buffer;
  return {
    nodeId: deriveNodeId(pubBuf),
    publicKey: pubBuf,
    privateKey: privateKey as unknown as Buffer,
  };
}

export function deriveNodeId(publicKeyDer: Buffer): string {
  return crypto.createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32);
}

export async function saveIdentity(id: Identity, db: Db): Promise<void> {
  db.insert(identityTable)
    .values({
      id: randomUUID(),
      nodeId: id.nodeId,
      publicKey: id.publicKey.toString('base64'),
      privateKey: id.privateKey.toString('base64'),
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .run();
}

export async function loadIdentity(db: Db): Promise<Identity | null> {
  const record = db.select().from(identityTable).get();
  if (!record) return null;
  return {
    nodeId: record.nodeId,
    publicKey: Buffer.from(record.publicKey, 'base64'),
    privateKey: Buffer.from(record.privateKey, 'base64'),
  };
}

export async function getOrCreateIdentity(db: Db): Promise<Identity> {
  const existing = await loadIdentity(db);
  if (existing) return existing;
  const id = generateIdentity();
  await saveIdentity(id, db);
  return id;
}
