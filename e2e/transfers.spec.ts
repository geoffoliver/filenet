import { expect, test } from '@playwright/test';

import { TRANSFERS, mockBaseApp, mockTransfers } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
});

test('renders active download with filename', async ({ page }) => {
  await page.goto('/transfers');
  await expect(page.getByText('movie.mp4')).toBeVisible();
  // Progress bar is rendered with aria attributes (not as percentage text)
  await expect(
    page.getByRole('progressbar', { name: 'movie.mp4 download progress' }),
  ).toBeVisible();
});

test('renders completed download', async ({ page }) => {
  await page.goto('/transfers');
  await expect(page.getByText('song.mp3')).toBeVisible();
  // Completed transfer shows the "completed" badge (state lowercased)
  await expect(page.getByText('completed')).toBeVisible();
});

test('shows source count for active download', async ({ page }) => {
  await page.goto('/transfers');
  await expect(page.getByText(/2 sources?/i)).toBeVisible();
});

test('shows speed for active download', async ({ page }) => {
  await page.goto('/transfers');
  // 5242880 Bps → formatBytes(5242880)/s = "5.0 MB/s"
  await expect(page.getByText('5.0 MB/s')).toBeVisible();
});

test('shows ETA for active download', async ({ page }) => {
  await page.goto('/transfers');
  // etaSeconds = 102 → "1m 42s"
  await expect(page.getByText('ETA 1m 42s')).toBeVisible();
});

test('active download has pause and cancel buttons', async ({ page }) => {
  await page.goto('/transfers');
  await expect(page.getByRole('button', { name: /pause/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /cancel/i })).toBeVisible();
});

test('completed download does not have cancel button', async ({ page }) => {
  await mockTransfers(page, [TRANSFERS[1]]); // completed only
  await page.goto('/transfers');
  await expect(page.getByRole('button', { name: /cancel/i })).not.toBeVisible();
});

test('pausing a download calls the API and updates state', async ({ page }) => {
  await page.route('/api/transfers/transfer-1', (route) => {
    if (route.request().method() === 'PUT') {
      return route.fulfill({
        json: { ...TRANSFERS[0], state: 'PAUSED' },
      });
    }
    return route.continue();
  });

  let callCount = 0;
  await page.route('/api/transfers', (route) => {
    callCount++;
    const list = callCount === 1 ? TRANSFERS : [{ ...TRANSFERS[0], state: 'PAUSED' }, TRANSFERS[1]];
    return route.fulfill({ json: list });
  });

  await page.goto('/transfers');
  await page.getByRole('button', { name: /pause/i }).click();
  await expect(page.getByRole('button', { name: /resume/i })).toBeVisible();
});

test('shows empty state when no transfers', async ({ page }) => {
  await mockTransfers(page, []);
  await page.goto('/transfers');
  await expect(page.getByText(/no downloads yet/i)).toBeVisible();
});

test('bytes received and total size are formatted for active download', async ({ page }) => {
  await page.goto('/transfers');
  // bytesReceived = 536870912 = 512.0 MB, size = 1073741824 = 1.00 GB
  await expect(page.getByText(/512\.0 MB \/ 1\.00 GB/)).toBeVisible();
});
