import { expect, test } from '@playwright/test';

import { MESSAGES, mockBaseApp, mockConversations, mockMessages } from './helpers';

const DM_ID = 'dm:node-alice:self';

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
  await mockMessages(page, DM_ID);
});

test('renders conversation list with DM', async ({ page }) => {
  await page.goto('/chat');
  // convLabel strips the 'dm:' prefix and shows the peer node id not matching 'self'
  await expect(page.getByText('node-alice')).toBeVisible();
});

test('shows last message preview', async ({ page }) => {
  await page.goto('/chat');
  // The latest embedded message in CONVERSATIONS is 'Hi Alice!'
  await expect(page.getByText('Hi Alice!')).toBeVisible();
});

test('opens DM when conversation is clicked', async ({ page }) => {
  await page.goto('/chat');
  await page.getByText('node-alice').click();
  // Both messages should appear in the message pane; scope to the bubble body elements
  const bubbles = page.locator('[class*="bubbleBody"]');
  await expect(bubbles.filter({ hasText: 'Hey there!' })).toBeVisible();
  await expect(bubbles.filter({ hasText: 'Hi Alice!' })).toBeVisible();
});

test('messages are displayed oldest-first (newest at bottom)', async ({ page }) => {
  await page.goto('/chat');
  await page.getByText('node-alice').click();

  const bubbles = page.locator('[class*="bubbleBody"]');
  await bubbles.first().waitFor();
  const firstText = await bubbles.first().textContent();
  const lastText = await bubbles.last().textContent();

  expect(firstText).toContain(MESSAGES[0].body);
  expect(lastText).toContain(MESSAGES[1].body);
});

test('send button is visible in the message pane', async ({ page }) => {
  await page.goto('/chat');
  await page.getByText('node-alice').click();
  await expect(page.getByRole('button', { name: /send/i })).toBeVisible();
});

test('sending a message calls the API', async ({ page }) => {
  let sent: unknown;
  await page.route(`/api/conversations/${DM_ID}/messages`, (route) => {
    if (route.request().method() === 'POST') {
      sent = route.request().postDataJSON();
      return route.fulfill({
        json: {
          id: 'msg-new',
          conversationId: DM_ID,
          senderNodeId: 'self',
          body: 'New message',
          sentAt: new Date().toISOString(),
        },
      });
    }
    return route.fulfill({ json: MESSAGES });
  });

  await page.goto('/chat');
  await page.getByText('node-alice').click();
  await page.getByRole('textbox', { name: /message/i }).fill('New message');
  await page.getByRole('button', { name: /send/i }).click();

  expect((sent as { body: string }).body).toBe('New message');
});

test('shows friend display name (not raw node id) next to incoming messages', async ({ page }) => {
  await page.goto('/chat');
  await page.getByText('node-alice').click();
  await expect(page.getByText('Alice', { exact: true })).toBeVisible();
});

test('DM delete button shows a delete confirmation', async ({ page }) => {
  let dialogMessage = '';
  page.once('dialog', (dialog) => {
    dialogMessage = dialog.message();
    dialog.dismiss();
  });

  await page.goto('/chat');
  await page.getByText('node-alice').click();
  await page.getByRole('button', { name: /delete/i }).click();

  expect(dialogMessage.toLowerCase()).toContain('delete');
});

test('group conversations show a leave button and confirmation, not a delete one', async ({
  page,
}) => {
  const GROUP_ID = 'group:room-1';
  await mockConversations(page, [
    {
      id: GROUP_ID,
      type: 'GROUP',
      name: 'Dev Chat',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      messages: [],
    },
  ]);
  await mockMessages(page, GROUP_ID, []);

  let dialogMessage = '';
  page.once('dialog', (dialog) => {
    dialogMessage = dialog.message();
    dialog.dismiss();
  });

  await page.goto('/chat');
  await page.getByText('Dev Chat').click();
  await expect(page.getByRole('button', { name: /leave/i })).toBeVisible();
  await page.getByRole('button', { name: /leave/i }).click();

  expect(dialogMessage.toLowerCase()).toContain('leave');
});

test('long message lists scroll within the message pane, not the whole page', async ({ page }) => {
  const manyMessages = Array.from({ length: 60 }).map((_, i) => ({
    id: `msg-long-${i}`,
    conversationId: DM_ID,
    fromNodeId: i % 2 === 0 ? 'node-alice' : 'self',
    body: `Message number ${i}`,
    sentAt: new Date(2024, 0, 1, 0, i).toISOString(),
  }));
  await mockMessages(page, DM_ID, manyMessages);

  await page.goto('/chat');
  await page.getByText('node-alice').click();
  await page.locator('[class*="bubbleBody"]').first().waitFor();

  await page.mouse.wheel(0, 2000);

  // The page/document itself must not have scrolled...
  const windowScrollY = await page.evaluate(() => window.scrollY);
  expect(windowScrollY).toBe(0);

  // ...and the sidebar + input bar must still be on-screen, since only the
  // messages pane should have scrolled internally.
  await expect(page.getByRole('button', { name: /node-alice/i })).toBeInViewport();
  await expect(page.getByRole('textbox', { name: /message/i })).toBeInViewport();
});

test('input field regains focus after sending a message', async ({ page }) => {
  await page.route(`/api/conversations/${DM_ID}/messages`, (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        json: {
          id: 'msg-new',
          conversationId: DM_ID,
          fromNodeId: 'self',
          body: 'New message',
          sentAt: new Date().toISOString(),
        },
      });
    }
    return route.fulfill({ json: MESSAGES });
  });

  await page.goto('/chat');
  await page.getByText('node-alice').click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('New message');
  await page.getByRole('button', { name: /send/i }).click();

  await expect(textbox).toBeFocused();
});

test('shows empty state when no conversation is selected', async ({ page }) => {
  await page.goto('/chat');
  // No conversation selected — right pane should show placeholder
  await expect(page.getByText(/select a conversation/i)).toBeVisible();
});

test('opens the conversation from a ?conv= query param and clears it from the URL', async ({
  page,
}) => {
  await page.goto('/chat?conv=dm:node-alice:self');

  const bubbles = page.locator('[class*="bubbleBody"]');
  await expect(bubbles.filter({ hasText: 'Hey there!' })).toBeVisible();
  await expect(bubbles.filter({ hasText: 'Hi Alice!' })).toBeVisible();
  await expect(page).toHaveURL(/\/chat$/);
});
