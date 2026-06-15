import { expect, test } from '@playwright/test';

import { SETTINGS, mockBaseApp } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
});

test('displays shared file count and size from API', async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByText('42', { exact: true })).toBeVisible();
  await expect(page.getByText(/1\.0+ GB/).first()).toBeVisible();
});

test('displays friends online count', async ({ page }) => {
  await page.goto('/home');
  // Stats card shows "2 / 3"
  await expect(page.getByText(/2 \/ 3/)).toBeVisible();
});

test('displays download stats', async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByText('7', { exact: true })).toBeVisible();
  // 536870912 bytes = 512 MB
  await expect(page.getByText(/512\.0+ MB/).first()).toBeVisible();
});

test('shows zero stats gracefully when all counts are zero', async ({ page }) => {
  await page.route('/api/stats', (route) =>
    route.fulfill({
      json: {
        sharedFiles: { count: 0, totalSize: '0' },
        friends: { total: 0, online: 0 },
        downloads: { count: 0, totalSize: '0' },
      },
    }),
  );
  await page.goto('/home');
  await expect(page.getByText(/0 B/).first()).toBeVisible();
});

test('redirects to /setup when name is not configured', async ({ page }) => {
  await page.route('/api/settings', (route) => route.fulfill({ json: { ...SETTINGS, name: '' } }));
  await page.goto('/');
  await page.waitForURL('**/setup');
});

test('redirects to /home when name is configured', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL('**/home');
});
