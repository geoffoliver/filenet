import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import { ConflictError, NotFoundError } from './errors';
import type { Friend, FriendStatus, Settings } from './schema';
import type { Db } from './db';
import { friends } from './schema';

export type { Friend, FriendStatus };

export type AddOutgoingFriendParams = {
  name: string;
  address: string;
  port: number;
  password?: string;
};

export type IncomingFriendRequestParams = {
  nodeId: string;
  publicKey: string;
  name: string;
  address: string;
  port: number;
};

export async function addOutgoingFriend(db: Db, params: AddOutgoingFriendParams): Promise<Friend> {
  const existing = db.select().from(friends).where(eq(friends.address, params.address)).get();
  // Check address+port match specifically
  const exactMatch = existing && existing.port === params.port ? existing : null;
  if (exactMatch)
    throw new ConflictError(`Already have a friend at ${params.address}:${params.port}`);

  const now = new Date();
  try {
    const row = db
      .insert(friends)
      .values({
        id: randomUUID(),
        name: params.name,
        address: params.address,
        port: params.port,
        status: 'OUTGOING_PENDING',
        remotePassword: params.password ?? null,
        addedAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return row!;
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      throw new ConflictError(`Already have a friend at ${params.address}:${params.port}`);
    }
    throw err;
  }
}

export async function handleIncomingFriendRequest(
  db: Db,
  params: IncomingFriendRequestParams,
): Promise<Friend> {
  const byNodeId = db.select().from(friends).where(eq(friends.nodeId, params.nodeId)).get();
  if (byNodeId) {
    const isStale =
      byNodeId.name !== params.name ||
      byNodeId.address !== params.address ||
      byNodeId.port !== params.port;
    if (!isStale) return byNodeId;
    const updated = db
      .update(friends)
      .set({ name: params.name, address: params.address, port: params.port, updatedAt: new Date() })
      .where(eq(friends.id, byNodeId.id))
      .returning()
      .get();
    return updated!;
  }

  // If we have an outgoing record for the same address+port, upgrade it.
  const byAddress = db.select().from(friends).where(eq(friends.address, params.address)).get();
  const byAddressAndPort = byAddress && byAddress.port === params.port ? byAddress : null;
  if (byAddressAndPort) {
    if (byAddressAndPort.status === 'BLOCKED') return byAddressAndPort;
    const updated = db
      .update(friends)
      .set({
        nodeId: params.nodeId,
        publicKey: params.publicKey,
        name: params.name,
        status: 'INCOMING_PENDING',
        acceptedAt: null,
        remotePassword: null,
        updatedAt: new Date(),
      })
      .where(eq(friends.id, byAddressAndPort.id))
      .returning()
      .get();
    return updated!;
  }

  const now = new Date();
  const row = db
    .insert(friends)
    .values({
      id: randomUUID(),
      name: params.name,
      nodeId: params.nodeId,
      publicKey: params.publicKey,
      address: params.address,
      port: params.port,
      status: 'INCOMING_PENDING',
      addedAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return row!;
}

// Accepts a Db or a Drizzle transaction (same interface)
export async function acceptFriendRequest(db: Db, friendId: string): Promise<Friend> {
  const friend = db.select().from(friends).where(eq(friends.id, friendId)).get();
  if (!friend) throw new NotFoundError(`Friend ${friendId} not found`);
  if (friend.status === 'ACCEPTED') return friend;
  if (friend.status === 'BLOCKED') throw new ConflictError(`Cannot accept a BLOCKED friend`);
  const updated = db
    .update(friends)
    .set({
      status: 'ACCEPTED',
      acceptedAt: friend.acceptedAt ?? new Date(),
      remotePassword: null,
      updatedAt: new Date(),
    })
    .where(eq(friends.id, friendId))
    .returning()
    .get();
  return updated!;
}

export async function rejectFriendRequest(db: Db, friendId: string): Promise<void> {
  const friend = db.select().from(friends).where(eq(friends.id, friendId)).get();
  if (!friend) throw new NotFoundError(`Friend ${friendId} not found`);
  if (friend.status !== 'INCOMING_PENDING' && friend.status !== 'OUTGOING_PENDING') {
    throw new ConflictError(`Cannot reject a friend with status ${friend.status}`);
  }
  db.delete(friends).where(eq(friends.id, friendId)).run();
}

export async function removeFriend(db: Db, friendId: string): Promise<void> {
  const friend = db.select().from(friends).where(eq(friends.id, friendId)).get();
  if (!friend) throw new NotFoundError(`Friend ${friendId} not found`);
  db.delete(friends).where(eq(friends.id, friendId)).run();
}

export async function getFriends(db: Db, status?: FriendStatus): Promise<Friend[]> {
  const query = db.select().from(friends).orderBy(asc(friends.addedAt));
  if (status) return query.where(eq(friends.status, status)).all();
  return query.all();
}

export function shouldAutoAccept(s: Settings, providedPassword: string | undefined): boolean {
  if (s.autoAcceptFromAnyone) return true;
  if (s.invitePassword !== null) {
    const MAX_PASSWORD_BYTES = 1024;
    const rawA = providedPassword !== undefined ? providedPassword : '\0';
    const rawB = s.invitePassword;
    if (
      Buffer.byteLength(rawA) > MAX_PASSWORD_BYTES ||
      Buffer.byteLength(rawB) > MAX_PASSWORD_BYTES
    )
      return false;
    const a = Buffer.from(rawA);
    const b = Buffer.from(rawB);
    const len = Math.max(a.length, b.length) || 1;
    const paddedA = Buffer.alloc(len);
    const paddedB = Buffer.alloc(len);
    a.copy(paddedA);
    b.copy(paddedB);
    if (timingSafeEqual(paddedA, paddedB) && a.length === b.length) return true;
  }
  return false;
}
