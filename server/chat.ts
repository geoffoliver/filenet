import type { PrismaClient } from '@prisma/client';

import type { ChatMessage } from './types';

export function dmConversationId(nodeA: string, nodeB: string): string {
  return `dm:${[nodeA, nodeB].sort().join(':')}`;
}

export async function handleChatMessage(
  msg: ChatMessage,
  senderNodeId: string,
  prisma: PrismaClient,
  localNodeId: string,
): Promise<void> {
  const { conversationId } = msg;

  if (conversationId.startsWith('dm:')) {
    // Enforce the canonical sorted form — prevents duplicate threads from non-sorted IDs.
    if (conversationId !== dmConversationId(senderNodeId, localNodeId)) {
      return;
    }
  } else if (!conversationId.startsWith('group:')) {
    return; // unknown prefix — drop
  }

  const isGroup = conversationId.startsWith('group:');

  const sentAt = new Date(msg.sentAt);
  if (isNaN(sentAt.getTime())) return;

  await prisma.conversation.upsert({
    where: { id: conversationId },
    create: {
      id: conversationId,
      type: isGroup ? 'GROUP' : 'DM',
      name: isGroup ? (msg.conversationName ?? null) : null,
    },
    update: {
      updatedAt: new Date(),
      ...(isGroup && msg.conversationName ? { name: msg.conversationName } : {}),
    },
  });

  // Always use the authenticated senderNodeId — never trust the self-reported fromNodeId.
  await prisma.message.upsert({
    where: { id: msg.messageId },
    create: {
      id: msg.messageId,
      conversationId,
      fromNodeId: senderNodeId,
      body: msg.body,
      sentAt,
    },
    update: {}, // first write wins — deduplication
  });
}
