import crypto from 'crypto';

import type { PrismaClient } from '@prisma/client';

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

export async function saveIdentity(identity: Identity, prisma: PrismaClient): Promise<void> {
  await prisma.identity.upsert({
    where: { nodeId: identity.nodeId },
    create: {
      nodeId: identity.nodeId,
      publicKey: identity.publicKey.toString('base64'),
      privateKey: identity.privateKey.toString('base64'),
    },
    update: {},
  });
}

export async function loadIdentity(prisma: PrismaClient): Promise<Identity | null> {
  const record = await prisma.identity.findFirst();
  if (!record) return null;
  return {
    nodeId: record.nodeId,
    publicKey: Buffer.from(record.publicKey, 'base64'),
    privateKey: Buffer.from(record.privateKey, 'base64'),
  };
}

export async function getOrCreateIdentity(prisma: PrismaClient): Promise<Identity> {
  const existing = await loadIdentity(prisma);
  if (existing) return existing;
  const identity = generateIdentity();
  await saveIdentity(identity, prisma);
  return identity;
}
