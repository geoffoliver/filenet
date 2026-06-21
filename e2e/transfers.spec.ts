import { expect, test } from '@playwright/test';

import { TRANSFERS, mockBaseApp, mockTransfers, mockUploads } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
});

test('renders active download with filename', async ({ page }) => {
  await page.goto('/transfers');
  await expect(page.getByText('movie.mp4')).toBeVisible();
  await expect(
    page.getByRole('progressbar', { name: 'movie.mp4 download progress' }),
  ).toBeVisible();
});

test('renders completed download', async ({ page }) => {
  await page.goto('/transfers');
  await expect(page.getByText('song.mp3')).toBeVisible();
  // Completed row has a Dismiss button (no cancel/pause)
  await expect(page.getByRole('button', { name: /dismiss/i })).toBeVisible();
});

test('shows source count for active download', async ({ page }) => {
  await page.goto('/transfers');
  await expect(page.getByText('2 src')).toBeVisible();
});

test('shows speed for active download', async ({ page }) => {
  await page.goto('/transfers');
  // 5242880 Bps → "5.0 MB/s"
  await expect(page.getByText('5.0 MB/s')).toBeVisible();
});

test('shows ETA for active download', async ({ page }) => {
  await page.goto('/transfers');
  // etaSeconds = 102 → formatEta → "1m 42s"
  await expect(page.getByText('1m 42s')).toBeVisible();
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
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ json: { ...TRANSFERS[0], state: 'PAUSED' } });
    }
    return route.continue();
  });

  let callCount = 0;
  await page.route('/api/transfers', (route) => {
    if (route.request().method() === 'GET') {
      callCount++;
      const list =
        callCount === 1 ? TRANSFERS : [{ ...TRANSFERS[0], state: 'PAUSED' }, TRANSFERS[1]];
      return route.fulfill({ json: list });
    }
    return route.continue();
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

test('status bar shows concurrent download and upload counts', async ({ page }) => {
  await page.goto('/transfers');
  // 1 active download (movie.mp4 DOWNLOADING), 0 uploads
  await expect(page.getByText(/Concurrent Downloads: 1/)).toBeVisible();
  await expect(page.getByText(/Concurrent Uploads: 0/)).toBeVisible();
});

test('Clear Finished button dismisses completed transfers', async ({ page }) => {
  let dismissed: string | null = null;
  await page.route('/api/transfers/transfer-2', (route) => {
    if (route.request().method() === 'DELETE') {
      dismissed = 'transfer-2';
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });

  // After dismiss, refresh returns only the active transfer
  let callCount = 0;
  await page.route('/api/transfers', (route) => {
    if (route.request().method() === 'GET') {
      callCount++;
      return route.fulfill({ json: callCount === 1 ? TRANSFERS : [TRANSFERS[0]] });
    }
    return route.continue();
  });

  await page.goto('/transfers');
  await page.getByRole('button', { name: /clear finished/i }).click();
  expect(dismissed).toBe('transfer-2');
  await expect(page.getByText('song.mp3')).not.toBeVisible();
});

test('upload row is shown when uploads are active', async ({ page }) => {
  await mockUploads(page, [
    {
      id: 'friend-1:aabbcc',
      sha256: 'aabbcc',
      filename: 'shared-video.mkv',
      size: '2147483648',
      peerNodeId: 'node-alice',
      bytesServed: '104857600',
      speedBps: 2097152,
    },
  ]);

  await page.goto('/transfers');
  await expect(page.getByText('shared-video.mkv')).toBeVisible();
  await expect(page.getByText(/Concurrent Uploads: 1/)).toBeVisible();
});
