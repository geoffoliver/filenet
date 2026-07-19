import { expect, test } from '@playwright/test';

import {
  UPDATE_STATUS_READY,
  UPDATE_STATUS_SOURCE_MODE,
  mockBaseApp,
  mockUpdateStatus,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
});

test('shows up-to-date status and no restart button by default', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Updates' }).click();
  await expect(page.getByText(/Up to date/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /restart to update/i })).toHaveCount(0);
});

test('shows a restart button and version when an update is ready', async ({ page }) => {
  await mockUpdateStatus(page, UPDATE_STATUS_READY);
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Updates' }).click();
  await expect(page.getByText(/Update ready: v0\.2\.0/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /restart to update v0\.2\.0/i })).toBeVisible();
});

test('source mode shows a passive message instead of check/restart controls', async ({ page }) => {
  await mockUpdateStatus(page, UPDATE_STATUS_SOURCE_MODE);
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Updates' }).click();
  await expect(page.getByText(/running from source/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /check for updates/i })).toHaveCount(0);
});

test('shows an error instead of silently disappearing when the status load fails', async ({
  page,
}) => {
  await page.route('/api/update-status', (route) => route.fulfill({ status: 500 }));
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Updates' }).click();
  await expect(page.getByText(/could not load update status/i)).toBeVisible();
});

test('shows a toast when an update becomes ready to install', async ({ page }) => {
  await mockUpdateStatus(page, UPDATE_STATUS_READY);
  // Navigate to a page that has nothing to do with Settings, to prove the
  // notification hook works globally, matching notifications.spec.ts's
  // pattern for the equivalent friend-request test.
  await page.goto('/home');
  await expect(page.getByText(/v0\.2\.0 is ready to install/i)).toBeVisible();
});
