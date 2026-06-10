import { timingSafeEqual } from 'node:crypto';

import type { Friend, FriendStatus, Prisma, PrismaClient, Settings } from '@prisma/client';

import { ConflictError, NotFoundError } from './errors';

export type AddOutgoingFriendParams = {
  name: string;
  address: string;
  port: number;
};

export type IncomingFriendRequestParams = {
  nodeId: string;
  publicKey: string;
  name: string;
  address: string;
  port: number;
};

export async function addOutgoingFriend(
  prisma: PrismaClient,
  params: AddOutgoingFriendParams,
): Promise<Friend> {
  const existing = await prisma.friend.findFirst({
    where: { address: params.address, port: params.port },
  });
  if (existing)
    throw new ConflictError(`Already have a friend at ${params.address}:${params.port}`);
  try {
    return await prisma.friend.create({
      data: {
        name: params.name,
        address: params.address,
        port: params.port,
        status: 'OUTGOING_PENDING',
      },
    });
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'P2002') {
      throw new ConflictError(`Already have a friend at ${params.address}:${params.port}`);
    }
    throw err;
  }
}

export async function handleIncomingFriendRequest(
  prisma: PrismaClient,
  params: IncomingFriendRequestParams,
): Promise<Friend> {
  const byNodeId = await prisma.friend.findUnique({ where: { nodeId: params.nodeId } });
  if (byNodeId) {
    const isStale =
      byNodeId.name !== params.name ||
      byNodeId.address !== params.address ||
      byNodeId.port !== params.port;
    if (!isStale) return byNodeId;
    return prisma.friend.update({
      where: { id: byNodeId.id },
      data: { name: params.name, address: params.address, port: params.port },
    });
  }

  // If we have an outgoing record for the same address+port, upgrade it rather than create a duplicate.
  const byAddress = await prisma.friend.findFirst({
    where: { address: params.address, port: params.port },
  });
  if (byAddress) {
    if (byAddress.status === 'BLOCKED') return byAddress;
    return prisma.friend.update({
      where: { id: byAddress.id },
      data: {
        nodeId: params.nodeId,
        publicKey: params.publicKey,
        name: params.name,
        status: 'INCOMING_PENDING',
        acceptedAt: null,
      },
    });
  }

  return prisma.friend.create({
    data: {
      name: params.name,
      nodeId: params.nodeId,
      publicKey: params.publicKey,
      address: params.address,
      port: params.port,
      status: 'INCOMING_PENDING',
    },
  });
}

export async function acceptFriendRequest(
  prisma: PrismaClient | Prisma.TransactionClient,
  friendId: string,
): Promise<Friend> {
  const friend = await prisma.friend.findUnique({ where: { id: friendId } });
  if (!friend) throw new NotFoundError(`Friend ${friendId} not found`);
  if (friend.status === 'ACCEPTED') return friend;
  if (friend.status === 'BLOCKED') throw new ConflictError(`Cannot accept a BLOCKED friend`);
  return prisma.friend.update({
    where: { id: friendId },
    data: {
      status: 'ACCEPTED',
      acceptedAt: friend.acceptedAt ?? new Date(),
    },
  });
}

export async function rejectFriendRequest(prisma: PrismaClient, friendId: string): Promise<void> {
  const friend = await prisma.friend.findUnique({ where: { id: friendId } });
  if (!friend) throw new NotFoundError(`Friend ${friendId} not found`);
  if (friend.status !== 'INCOMING_PENDING' && friend.status !== 'OUTGOING_PENDING') {
    throw new ConflictError(`Cannot reject a friend with status ${friend.status}`);
  }
  await prisma.friend.delete({ where: { id: friendId } });
}

export async function removeFriend(prisma: PrismaClient, friendId: string): Promise<void> {
  const friend = await prisma.friend.findUnique({ where: { id: friendId } });
  if (!friend) throw new NotFoundError(`Friend ${friendId} not found`);
  await prisma.friend.delete({ where: { id: friendId } });
}

export async function getFriends(prisma: PrismaClient, status?: FriendStatus): Promise<Friend[]> {
  return prisma.friend.findMany({
    where: status ? { status } : undefined,
    orderBy: { addedAt: 'asc' },
  });
}

export function shouldAutoAccept(
  settings: Settings,
  providedPassword: string | undefined,
): boolean {
  if (settings.autoAcceptFromAnyone) return true;
  // Always run the timing-safe comparison when a password is configured so that
  // omitting the password field doesn't create a measurable short-circuit that
  // leaks whether a password is set at all.
  if (settings.invitePassword !== null) {
    const a = Buffer.from(providedPassword ?? '');
    const b = Buffer.from(settings.invitePassword);
    const len = Math.max(a.length, b.length) || 1;
    const paddedA = Buffer.alloc(len);
    const paddedB = Buffer.alloc(len);
    a.copy(paddedA);
    b.copy(paddedB);
    // Always run timingSafeEqual before checking length equality so the crypto
    // executes in constant time regardless of whether lengths match. The length
    // check is a non-secret integer comparison and does not leak password content.
    if (timingSafeEqual(paddedA, paddedB) && a.length === b.length) return true;
  }
  return false;
}
