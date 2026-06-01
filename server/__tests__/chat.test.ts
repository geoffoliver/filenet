import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { dmConversationId, handleChatMessage } from '../chat';
import type { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '../db';

let prisma: PrismaClient;

beforeEach(async () => {
  prisma = createPrismaClient();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
});

afterEach(async () => {
  await prisma.$disconnect();
});

const NODE_A = 'aaaa1111';
const NODE_B = 'bbbb2222';
const NODE_C = 'cccc3333';

// ---------------------------------------------------------------------------
// dmConversationId helper
// ---------------------------------------------------------------------------

describe('dmConversationId', () => {
  test('sorts nodeIds deterministically', () => {
    expect(dmConversationId(NODE_A, NODE_B)).toBe(dmConversationId(NODE_B, NODE_A));
  });

  test('produces dm: prefix', () => {
    expect(dmConversationId(NODE_A, NODE_B)).toMatch(/^dm:/);
  });
});

// ---------------------------------------------------------------------------
// handleChatMessage — DM
// ---------------------------------------------------------------------------

describe('handleChatMessage — DM', () => {
  test('stores a valid DM message and creates the conversation', async () => {
    const msgId = randomUUID();
    const convId = dmConversationId(NODE_A, NODE_B);

    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: convId,
        fromNodeId: NODE_A,
        body: 'Hello!',
        sentAt: Date.now(),
      },
      NODE_A, // authenticated sender
      prisma,
      NODE_B, // local node
    );

    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    expect(conv).not.toBeNull();
    expect(conv!.type).toBe('DM');

    const msg = await prisma.message.findUnique({ where: { id: msgId } });
    expect(msg).not.toBeNull();
    expect(msg!.body).toBe('Hello!');
    expect(msg!.fromNodeId).toBe(NODE_A);
  });

  test('ignores self-reported fromNodeId — always uses authenticated senderNodeId', async () => {
    const msgId = randomUUID();
    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: dmConversationId(NODE_A, NODE_B),
        fromNodeId: 'SPOOFED',
        body: 'Hi',
        sentAt: Date.now(),
      },
      NODE_A,
      prisma,
      NODE_B,
    );

    const msg = await prisma.message.findUnique({ where: { id: msgId } });
    expect(msg!.fromNodeId).toBe(NODE_A);
  });

  test('drops DM whose conversationId does not contain the authenticated sender', async () => {
    const msgId = randomUUID();
    // Conversation is between NODE_A and NODE_C, but sender is NODE_B — invalid
    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: dmConversationId(NODE_A, NODE_C),
        fromNodeId: NODE_B,
        body: 'Sneaky',
        sentAt: Date.now(),
      },
      NODE_B, // authenticated as NODE_B
      prisma,
      NODE_A, // local is NODE_A — not in this conversation either
    );

    const msg = await prisma.message.findUnique({ where: { id: msgId } });
    expect(msg).toBeNull();
  });

  test('drops DM whose conversationId does not contain the local node', async () => {
    const msgId = randomUUID();
    // Conversation is between NODE_A and NODE_C; local node is NODE_B — invalid
    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: dmConversationId(NODE_A, NODE_C),
        fromNodeId: NODE_A,
        body: 'Wrong recipient',
        sentAt: Date.now(),
      },
      NODE_A,
      prisma,
      NODE_B, // local is NODE_B, not NODE_C
    );

    const msg = await prisma.message.findUnique({ where: { id: msgId } });
    expect(msg).toBeNull();
  });

  test('deduplicates — second upsert with same messageId is a no-op', async () => {
    const msgId = randomUUID();
    const convId = dmConversationId(NODE_A, NODE_B);
    const base = {
      type: 'chat-message' as const,
      messageId: msgId,
      conversationId: convId,
      fromNodeId: NODE_A,
      body: 'First',
      sentAt: Date.now(),
    };

    await handleChatMessage(base, NODE_A, prisma, NODE_B);
    await handleChatMessage({ ...base, body: 'Second' }, NODE_A, prisma, NODE_B);

    const msg = await prisma.message.findUnique({ where: { id: msgId } });
    expect(msg!.body).toBe('First'); // first write wins
  });
});

// ---------------------------------------------------------------------------
// handleChatMessage — group
// ---------------------------------------------------------------------------

describe('handleChatMessage — group', () => {
  test('stores a group message and creates the conversation', async () => {
    const msgId = randomUUID();
    const convId = `group:${randomUUID()}`;

    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: convId,
        fromNodeId: NODE_A,
        body: 'Hey group',
        sentAt: Date.now(),
        conversationName: 'Dev Chat',
      },
      NODE_A,
      prisma,
      NODE_B,
    );

    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    expect(conv!.type).toBe('GROUP');
    expect(conv!.name).toBe('Dev Chat');

    const msg = await prisma.message.findUnique({ where: { id: msgId } });
    expect(msg!.body).toBe('Hey group');
  });

  test('updates group name when conversationName changes', async () => {
    const convId = `group:${randomUUID()}`;

    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: randomUUID(),
        conversationId: convId,
        fromNodeId: NODE_A,
        body: 'Hi',
        sentAt: Date.now(),
        conversationName: 'Old Name',
      },
      NODE_A,
      prisma,
      NODE_B,
    );

    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: randomUUID(),
        conversationId: convId,
        fromNodeId: NODE_A,
        body: 'Hi again',
        sentAt: Date.now(),
        conversationName: 'New Name',
      },
      NODE_A,
      prisma,
      NODE_B,
    );

    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    expect(conv!.name).toBe('New Name');
  });

  test('drops group message whose conversationId has invalid prefix', async () => {
    const msgId = randomUUID();

    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: 'bad:whatever',
        fromNodeId: NODE_A,
        body: 'Bad',
        sentAt: Date.now(),
      },
      NODE_A,
      prisma,
      NODE_B,
    );

    const msg = await prisma.message.findUnique({ where: { id: msgId } });
    expect(msg).toBeNull();
  });

  test('accepts group message for any authenticated sender', async () => {
    const msgId = randomUUID();
    const convId = `group:${randomUUID()}`;

    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: convId,
        fromNodeId: NODE_C,
        body: 'From C',
        sentAt: Date.now(),
      },
      NODE_C,
      prisma,
      NODE_A,
    );

    const msg = await prisma.message.findUnique({ where: { id: msgId } });
    expect(msg).not.toBeNull();
  });
});
