import { expect, test } from '@playwright/test';

import { MESSAGES, mockBaseApp, mockMessages } from './helpers';

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

test('shows empty state when no conversation is selected', async ({ page }) => {
  await page.goto('/chat');
  // No conversation selected — right pane should show placeholder
  await expect(page.getByText(/select a conversation/i)).toBeVisible();
});
