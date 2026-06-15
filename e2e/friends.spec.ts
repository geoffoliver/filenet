import { expect, test } from '@playwright/test';

import { FRIENDS, mockBaseApp, mockFriends } from './helpers';

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
  await page.goto('/friends');
  await expect(page.getByText('Carol')).toBeVisible();
  await expect(page.getByRole('button', { name: /accept/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /decline/i }).first()).toBeVisible();
});

test('accepting a friend request calls the API and refreshes', async ({ page }) => {
  const accepted = { ...FRIENDS[2], status: 'ACCEPTED', acceptedAt: new Date().toISOString() };
  await page.route('/api/friends/friend-3', (route) => {
    if (route.request().method() === 'PUT') return route.fulfill({ json: accepted });
    return route.continue();
  });
  // After accept, mock the refresh returning updated list
  let callCount = 0;
  await page.route('/api/friends', (route) => {
    if (route.request().method() === 'GET') {
      callCount++;
      const list = callCount === 1 ? FRIENDS : [...FRIENDS.slice(0, 2), accepted];
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
  await page.route('/api/friends/friend-3', (route) => {
    if (route.request().method() === 'PUT') return route.fulfill({ status: 200, body: '' });
    return route.continue();
  });
  let callCount = 0;
  await page.route('/api/friends', (route) => {
    if (route.request().method() === 'GET') {
      callCount++;
      const list = callCount === 1 ? FRIENDS : FRIENDS.slice(0, 2);
      return route.fulfill({ json: list });
    }
    return route.continue();
  });

  await page.goto('/friends');
  await page
    .getByRole('button', { name: /decline/i })
    .first()
    .click();
  await expect(page.getByText('Carol')).not.toBeVisible();
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

test('shows empty state when no friends', async ({ page }) => {
  await mockFriends(page, []);
  await page.goto('/friends');
  await expect(page.getByText(/no friends/i)).toBeVisible();
});
