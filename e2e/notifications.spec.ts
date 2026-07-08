import { expect, test } from '@playwright/test';

import { FRIENDS, FRIENDS_WITH_INCOMING_REQUEST, mockBaseApp, mockFriends } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
});

test('shows a toast and a nav badge when an incoming friend request appears', async ({ page }) => {
  await mockFriends(page, FRIENDS_WITH_INCOMING_REQUEST);

  // Navigate to a page that has nothing to do with Friends, to prove this
  // works globally, not just on the Friends page itself.
  await page.goto('/home');

  await expect(page.getByText('Carol wants to be your friend')).toBeVisible();
  await expect(page.getByRole('link', { name: /friends/i }).getByText('1')).toBeVisible();
});

test('does not show a toast when there are no incoming pending requests', async ({ page }) => {
  await mockFriends(page, FRIENDS);
  await page.goto('/home');
  await page.waitForTimeout(500);
  await expect(page.getByText(/wants to be your friend/i)).toHaveCount(0);
});

test('the toast auto-dismisses', async ({ page }) => {
  await mockFriends(page, FRIENDS_WITH_INCOMING_REQUEST);
  await page.goto('/home');
  await expect(page.getByText('Carol wants to be your friend')).toBeVisible();
  await expect(page.getByText('Carol wants to be your friend')).not.toBeVisible({ timeout: 7_000 });
});

test('does not re-notify for a request already seen in this browser', async ({ page }) => {
  await mockFriends(page, FRIENDS_WITH_INCOMING_REQUEST);
  await page.goto('/home');
  await expect(page.getByText('Carol wants to be your friend')).toBeVisible();
  await expect(page.getByText('Carol wants to be your friend')).not.toBeVisible({ timeout: 7_000 });

  // Reload — same browser context, same localStorage. The poll fires again
  // on mount; Carol must not be re-notified.
  await page.reload();
  await page.waitForTimeout(500);
  await expect(page.getByText('Carol wants to be your friend')).toHaveCount(0);
  // The badge, however, is derived fresh from the poll every time and
  // should still reflect the still-pending request.
  await expect(page.getByRole('link', { name: /friends/i }).getByText('1')).toBeVisible();
});
