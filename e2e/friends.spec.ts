import { expect, test } from '@playwright/test';

import {
  CONVERSATIONS,
  FRIENDS,
  FRIENDS_WITH_INCOMING_REQUEST,
  mockBaseApp,
  mockFriends,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
});

test('renders accepted friends', async ({ page }) => {
  await page.goto('/friends');
  await expect(page.getByText('Alice')).toBeVisible();
  await expect(page.getByText('Bob')).toBeVisible();
});

test('shows online indicator for connected friends', async ({ page }) => {
  await page.goto('/friends');
  // Alice is online; Bob is not — both names visible, Alice has online indicator
  const aliceRow = page.getByText('Alice').locator('..');
  await expect(aliceRow).toBeVisible();
});

test('shows incoming pending request with accept and decline buttons', async ({ page }) => {
  await mockFriends(page, FRIENDS_WITH_INCOMING_REQUEST);
  await page.goto('/friends');
  // Exact match: the shell's global notification toast ("Carol wants to be
  // your friend") also contains the substring "Carol", so a non-exact
  // getByText('Carol') would match both it and the friend-list row.
  await expect(page.getByText('Carol', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /accept/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /decline/i }).first()).toBeVisible();
});

test('accepting a friend request calls the API and refreshes', async ({ page }) => {
  const accepted = { ...FRIENDS[2], status: 'ACCEPTED', acceptedAt: new Date().toISOString() };
  let hasAccepted = false;
  await page.route('/api/friends/friend-3', (route) => {
    if (route.request().method() === 'PUT') {
      hasAccepted = true;
      return route.fulfill({ json: accepted });
    }
    return route.continue();
  });
  // Key off whether the PUT actually happened, not a raw GET call count —
  // the shell's own friend-request-notification poll and this page's poll
  // both hit this same route independently, so a naive counter can't tell
  // "before the user clicked" from "after".
  await page.route('/api/friends', (route) => {
    if (route.request().method() === 'GET') {
      const list = hasAccepted ? [...FRIENDS.slice(0, 2), accepted] : FRIENDS_WITH_INCOMING_REQUEST;
      return route.fulfill({ json: list });
    }
    return route.continue();
  });

  await page.goto('/friends');
  await page
    .getByRole('button', { name: /accept/i })
    .first()
    .click();
  // Carol should no longer show accept/reject buttons after accepting
  await expect(page.getByRole('button', { name: /accept/i })).toHaveCount(0);
});

test('rejecting a friend request removes them from the list', async ({ page }) => {
  let hasRejected = false;
  await page.route('/api/friends/friend-3', (route) => {
    if (route.request().method() === 'PUT') {
      hasRejected = true;
      return route.fulfill({ status: 200, body: '' });
    }
    return route.continue();
  });
  await page.route('/api/friends', (route) => {
    if (route.request().method() === 'GET') {
      const list = hasRejected ? FRIENDS.slice(0, 2) : FRIENDS_WITH_INCOMING_REQUEST;
      return route.fulfill({ json: list });
    }
    return route.continue();
  });

  await page.goto('/friends');
  await page
    .getByRole('button', { name: /decline/i })
    .first()
    .click();
  // Exact match: after rejecting, the friend-list row for Carol is gone, but
  // the shell's global notification toast ("Carol wants to be your friend")
  // may still be visible/fading from this same fixture — it also contains
  // the substring "Carol", so a non-exact match would false-negative here.
  await expect(page.getByText('Carol', { exact: true })).not.toBeVisible();
});

test('add friend form submits to the API', async ({ page }) => {
  let posted: unknown;
  await page.route('/api/friends', (route) => {
    if (route.request().method() === 'POST') {
      posted = route.request().postDataJSON();
      return route.fulfill({
        json: {
          ...FRIENDS[0],
          id: 'friend-new',
          name: 'Dave',
          address: '10.0.0.99',
          status: 'OUTGOING_PENDING',
        },
      });
    }
    return route.fulfill({ json: FRIENDS });
  });

  await page.goto('/friends');
  await page.getByRole('button', { name: /\+ add friend/i }).click();
  await page.getByLabel(/^name$/i).fill('Dave');
  await page.getByLabel(/^address$/i).fill('10.0.0.99');
  await page.getByRole('button', { name: /^add friend$/i }).click();

  expect((posted as { name: string }).name).toBe('Dave');
  expect((posted as { address: string }).address).toBe('10.0.0.99');
});

test('shows remove button and prompts confirmation', async ({ page }) => {
  await page.goto('/friends');
  await expect(page.getByRole('button', { name: /remove/i }).first()).toBeVisible();
});

test('starting a DM posts peerNodeId and navigates to Chat with it in the URL', async ({
  page,
}) => {
  let posted: unknown;
  await page.route('/api/conversations', (route) => {
    if (route.request().method() === 'POST') {
      posted = route.request().postDataJSON();
      return route.fulfill({
        json: {
          id: 'dm:node-alice:self',
          type: 'DM',
          name: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          messages: [],
        },
      });
    }
    return route.fulfill({ json: CONVERSATIONS });
  });

  await page.goto('/friends');
  await page
    .getByRole('button', { name: /^message$/i })
    .first()
    .click();

  await expect(page).toHaveURL(/\/chat\?conv=dm%3Anode-alice%3Aself/);
  expect((posted as { peerNodeId: string }).peerNodeId).toBe('node-alice');
});

test('shows an inline error and re-enables the button when starting a DM fails', async ({
  page,
}) => {
  await page.route('/api/conversations', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 403, body: 'peerNodeId must be an accepted friend' });
    }
    return route.fulfill({ json: CONVERSATIONS });
  });

  await page.goto('/friends');
  const messageBtn = page.getByRole('button', { name: /^message$/i }).first();
  await messageBtn.click();

  await expect(page.getByText('peerNodeId must be an accepted friend')).toBeVisible();
  await expect(messageBtn).toBeEnabled();
  await expect(page).toHaveURL(/\/friends$/);
});

test('shows empty state when no friends', async ({ page }) => {
  await mockFriends(page, []);
  await page.goto('/friends');
  await expect(page.getByText(/no friends/i)).toBeVisible();
});
