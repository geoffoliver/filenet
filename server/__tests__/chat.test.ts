import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import { conversations, messages } from '../schema';
import { dmConversationId, handleChatMessage } from '../chat';

const TEST_DB_URL = 'file:./data/test-chat.db';
let db: Db;

beforeAll(() => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
});

afterAll(() => {
  db.$client.close();
  try {
    unlinkSync('./data/test-chat.db');
  } catch {}
});

beforeEach(() => {
  db.delete(messages).run();
  db.delete(conversations).run();
});

const NODE_A = 'aaaa1111';
const NODE_B = 'bbbb2222';
const NODE_C = 'cccc3333';

describe('dmConversationId', () => {
  test('sorts nodeIds deterministically', () => {
    expect(dmConversationId(NODE_A, NODE_B)).toBe(dmConversationId(NODE_B, NODE_A));
  });

  test('produces dm: prefix', () => {
    expect(dmConversationId(NODE_A, NODE_B)).toMatch(/^dm:/);
  });
});

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
      NODE_A,
      db,
      NODE_B,
    );

    const conv = db.select().from(conversations).where(eq(conversations.id, convId)).get();
    expect(conv).not.toBeUndefined();
    expect(conv!.type).toBe('DM');

    const msg = db.select().from(messages).where(eq(messages.id, msgId)).get();
    expect(msg).not.toBeUndefined();
    expect(msg!.body).toBe('Hello!');
    expect(msg!.fromNodeId).toBe(NODE_A);
  });

  test('trims leading/trailing whitespace from body before storing', async () => {
    const msgId = randomUUID();
    const convId = dmConversationId(NODE_A, NODE_B);
    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: convId,
        fromNodeId: NODE_A,
        body: '  hello  ',
        sentAt: Date.now(),
      },
      NODE_A,
      db,
      NODE_B,
    );
    const msg = db.select().from(messages).where(eq(messages.id, msgId)).get();
    expect(msg!.body).toBe('hello');
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
      db,
      NODE_B,
    );
    const msg = db.select().from(messages).where(eq(messages.id, msgId)).get();
    expect(msg!.fromNodeId).toBe(NODE_A);
  });

  test('drops DM with non-canonical (unsorted) conversationId', async () => {
    const msgId = randomUUID();
    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: `dm:${NODE_B}:${NODE_A}`,
        fromNodeId: NODE_A,
        body: 'Split history attack',
        sentAt: Date.now(),
      },
      NODE_A,
      db,
      NODE_B,
    );
    const msg = db.select().from(messages).where(eq(messages.id, msgId)).get();
    expect(msg).toBeUndefined();
  });

  test('drops DM whose conversationId does not contain the authenticated sender', async () => {
    const msgId = randomUUID();
    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: dmConversationId(NODE_A, NODE_C),
        fromNodeId: NODE_B,
        body: 'Sneaky',
        sentAt: Date.now(),
      },
      NODE_B,
      db,
      NODE_A,
    );
    const msg = db.select().from(messages).where(eq(messages.id, msgId)).get();
    expect(msg).toBeUndefined();
  });

  test('drops DM whose conversationId does not contain the local node', async () => {
    const msgId = randomUUID();
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
      db,
      NODE_B,
    );
    const msg = db.select().from(messages).where(eq(messages.id, msgId)).get();
    expect(msg).toBeUndefined();
  });

  test('bumps conversation updatedAt when a new message arrives', async () => {
    const convId = dmConversationId(NODE_A, NODE_B);
    const now = new Date();
    db.insert(conversations)
      .values({ id: convId, type: 'DM', createdAt: now, updatedAt: now })
      .run();
    const before = db.select().from(conversations).where(eq(conversations.id, convId)).get()!;

    await new Promise((r) => setTimeout(r, 20));

    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: randomUUID(),
        conversationId: convId,
        fromNodeId: NODE_A,
        body: 'Bump',
        sentAt: Date.now(),
      },
      NODE_A,
      db,
      NODE_B,
    );

    const after = db.select().from(conversations).where(eq(conversations.id, convId)).get()!;
    expect(after.updatedAt!.getTime()).toBeGreaterThan(before.updatedAt!.getTime());
  });

  test('ignores conversationName on DM conversations', async () => {
    const convId = dmConversationId(NODE_A, NODE_B);
    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: randomUUID(),
        conversationId: convId,
        fromNodeId: NODE_A,
        body: 'Hello',
        sentAt: Date.now(),
        conversationName: 'Should Be Ignored',
      },
      NODE_A,
      db,
      NODE_B,
    );
    const conv = db.select().from(conversations).where(eq(conversations.id, convId)).get()!;
    expect(conv.name).toBeNull();
  });

  test('drops message with out-of-range sentAt (invalid Date)', async () => {
    const msgId = randomUUID();
    const convId = dmConversationId(NODE_A, NODE_B);
    await handleChatMessage(
      {
        type: 'chat-message',
        messageId: msgId,
        conversationId: convId,
        fromNodeId: NODE_A,
        body: 'Bad date',
        sentAt: 8_640_000_000_000_001,
      },
      NODE_A,
      db,
      NODE_B,
    );
    expect(db.select().from(messages).where(eq(messages.id, msgId)).get()).toBeUndefined();
    expect(
      db.select().from(conversations).where(eq(conversations.id, convId)).get(),
    ).toBeUndefined();
  });

  test('deduplicates — replayed messageId is a complete no-op (no conversation bump)', async () => {
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

    await handleChatMessage(base, NODE_A, db, NODE_B);
    const convAfterFirst = db
      .select()
      .from(conversations)
      .where(eq(conversations.id, convId))
      .get()!;

    await new Promise((r) => setTimeout(r, 20));
    await handleChatMessage({ ...base, body: 'Second' }, NODE_A, db, NODE_B);

    const msg = db.select().from(messages).where(eq(messages.id, msgId)).get()!;
    expect(msg.body).toBe('First');

    const convAfterReplay = db
      .select()
      .from(conversations)
      .where(eq(conversations.id, convId))
      .get()!;
    expect(convAfterReplay.updatedAt!.getTime()).toBe(convAfterFirst.updatedAt!.getTime());
  });
});

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
      db,
      NODE_B,
    );

    const conv = db.select().from(conversations).where(eq(conversations.id, convId)).get()!;
    expect(conv.type).toBe('GROUP');
    expect(conv.name).toBe('Dev Chat');

    const msg = db.select().from(messages).where(eq(messages.id, msgId)).get()!;
    expect(msg.body).toBe('Hey group');
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
      db,
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
      db,
      NODE_B,
    );

    const conv = db.select().from(conversations).where(eq(conversations.id, convId)).get()!;
    expect(conv.name).toBe('New Name');
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
      db,
      NODE_B,
    );
    expect(db.select().from(messages).where(eq(messages.id, msgId)).get()).toBeUndefined();
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
      db,
      NODE_A,
    );
    expect(db.select().from(messages).where(eq(messages.id, msgId)).get()).not.toBeUndefined();
  });
});
