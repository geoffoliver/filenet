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
    // Validate both the authenticated sender and the local node are the two participants.
    const parts = conversationId.slice(3).split(':');
    if (parts.length !== 2 || !parts.includes(senderNodeId) || !parts.includes(localNodeId)) {
      return;
    }
  } else if (!conversationId.startsWith('group:')) {
    return; // unknown prefix — drop
  }

  const isGroup = conversationId.startsWith('group:');

  await prisma.conversation.upsert({
    where: { id: conversationId },
    create: {
      id: conversationId,
      type: isGroup ? 'GROUP' : 'DM',
      name: msg.conversationName ?? null,
    },
    update: msg.conversationName ? { name: msg.conversationName } : {},
  });

  // Always use the authenticated senderNodeId — never trust the self-reported fromNodeId.
  await prisma.message.upsert({
    where: { id: msg.messageId },
    create: {
      id: msg.messageId,
      conversationId,
      fromNodeId: senderNodeId,
      body: msg.body,
      sentAt: new Date(msg.sentAt),
    },
    update: {}, // first write wins — deduplication
  });
}
