import { eq } from 'drizzle-orm';

import { conversations, messages } from './schema';
import type { ChatMessage } from './types';
import type { Db } from './db';

export function dmConversationId(nodeA: string, nodeB: string): string {
  return `dm:${[nodeA, nodeB].sort().join(':')}`;
}

export async function handleChatMessage(
  msg: ChatMessage,
  senderNodeId: string,
  db: Db,
  localNodeId: string,
): Promise<void> {
  const { conversationId } = msg;

  if (conversationId.startsWith('dm:')) {
    if (conversationId !== dmConversationId(senderNodeId, localNodeId)) return;
  } else if (!conversationId.startsWith('group:')) {
    return;
  }

  const isGroup = conversationId.startsWith('group:');

  const sentAt = new Date(msg.sentAt);
  if (isNaN(sentAt.getTime())) return;

  const now = new Date();

  db.transaction((tx) => {
    const existing = tx.select().from(messages).where(eq(messages.id, msg.messageId)).get();
    if (existing) return;

    tx.insert(conversations)
      .values({
        id: conversationId,
        type: isGroup ? 'GROUP' : 'DM',
        name: isGroup ? (msg.conversationName ?? null) : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: conversations.id,
        set: {
          updatedAt: now,
          ...(isGroup && msg.conversationName ? { name: msg.conversationName } : {}),
        },
      })
      .run();

    tx.insert(messages)
      .values({
        id: msg.messageId,
        conversationId,
        fromNodeId: senderNodeId,
        body: msg.body.trim(),
        sentAt,
      })
      .run();
  });
}
