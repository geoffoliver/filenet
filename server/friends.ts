import type { Friend, FriendStatus, PrismaClient, Settings } from '@prisma/client';

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
  if (existing) throw new Error(`Already have a friend at ${params.address}:${params.port}`);
  return prisma.friend.create({
    data: {
      name: params.name,
      address: params.address,
      port: params.port,
      status: 'OUTGOING_PENDING',
    },
  });
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
    return prisma.friend.update({
      where: { id: byAddress.id },
      data: {
        nodeId: params.nodeId,
        publicKey: params.publicKey,
        status: 'INCOMING_PENDING',
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

export async function acceptFriendRequest(prisma: PrismaClient, friendId: string): Promise<Friend> {
  const friend = await prisma.friend.findUnique({ where: { id: friendId } });
  if (!friend) throw new Error(`Friend ${friendId} not found`);
  return prisma.friend.update({
    where: { id: friendId },
    data: {
      status: 'ACCEPTED',
      acceptedAt: friend.acceptedAt ?? new Date(),
    },
  });
}

export async function rejectFriendRequest(prisma: PrismaClient, friendId: string): Promise<void> {
  await prisma.friend.delete({ where: { id: friendId } });
}

export async function removeFriend(prisma: PrismaClient, friendId: string): Promise<void> {
  const friend = await prisma.friend.findUnique({ where: { id: friendId } });
  if (!friend) throw new Error(`Friend ${friendId} not found`);
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
  if (settings.invitePassword && providedPassword === settings.invitePassword) return true;
  return false;
}
