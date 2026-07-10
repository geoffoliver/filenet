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

  // The visible badge concatenated straight into the link's text would give
  // an ambiguous accessible name like "Friends1" — assert the real
  // accessible name is well-formed instead of just checking for the digit.
  await expect(
    page.getByRole('link', { name: /friends.*1 pending friend request/i }),
  ).toBeVisible();
});

test('does not show a toast when there are no incoming pending requests', async ({ page }) => {
  await mockFriends(page, FRIENDS);
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().endsWith('/api/friends') && res.request().method() === 'GET',
    ),
    page.goto('/home'),
  ]);
  // The poll's response has definitely arrived at this point (unlike a blind
  // sleep); this last bit just gives React a moment to commit the resulting
  // state update before we assert on the DOM.
  await page.waitForTimeout(100);
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
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().endsWith('/api/friends') && res.request().method() === 'GET',
    ),
    page.reload(),
  ]);
  await page.waitForTimeout(100);
  await expect(page.getByText('Carol wants to be your friend')).toHaveCount(0);
  // The badge, however, is derived fresh from the poll every time and
  // should still reflect the still-pending request.
  await expect(page.getByRole('link', { name: /friends/i }).getByText('1')).toBeVisible();
});

test('re-notifies for the same friend id if it leaves and re-enters the pending state', async ({
  page,
}) => {
  // Simulates a friend whose request was accepted (or declined) and later
  // re-sends a request that lands on the same underlying friend id — e.g.
  // server/friends.ts upgrading an existing row back to INCOMING_PENDING.
  let phase: 'pending' | 'accepted' = 'pending';
  await page.route('/api/friends', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ json: phase === 'pending' ? FRIENDS_WITH_INCOMING_REQUEST : FRIENDS });
  });

  await page.goto('/home');
  await expect(page.getByText('Carol wants to be your friend')).toBeVisible();
  await expect(page.getByText('Carol wants to be your friend')).not.toBeVisible({ timeout: 7_000 });

  // Flip to accepted and wait for a poll response that actually reflects
  // that state — not just any /api/friends response. POLL_MS and
  // TOAST_DURATION_MS are both exactly 5s, so a poll can be in flight
  // (dispatched under the old 'pending' phase) at the exact moment we flip
  // the variable; that in-flight response would still satisfy a URL-only
  // predicate without the hook ever having observed 'accepted'. Inspecting
  // the body makes this deterministic regardless of that overlap.
  phase = 'accepted';
  await page.waitForResponse(async (res) => {
    if (!res.url().endsWith('/api/friends') || res.request().method() !== 'GET') return false;
    const body: unknown = await res.json().catch(() => null);
    return Array.isArray(body) && !body.some((f) => f.status === 'INCOMING_PENDING');
  });

  // Flip back to pending — the next poll should treat this as new again.
  phase = 'pending';
  await expect(page.getByText('Carol wants to be your friend')).toBeVisible({ timeout: 7_000 });
});
