import { expect, test } from '@playwright/test';

import { mockBaseApp, mockSearch } from './helpers';

const NETWORK_FILE = {
  sha256: 'a'.repeat(64),
  filename: 'awesome-song.mp3',
  size: '5242880',
  mimeType: 'audio/mpeg',
  metadata: JSON.stringify({ artist: 'Test Artist', album: 'Test Album', duration: 210 }),
  nodeId: 'node-alice',
  viaNodeId: null,
};

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
});

test('renders the search form', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/search');
  // The main search form (not the navbar) has a combobox and a Search button
  await expect(page.getByRole('combobox', { name: 'File type' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search' }).first()).toBeVisible();
});

test('shows results from the network', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  await expect(page.getByText('awesome-song.mp3')).toBeVisible();
  await expect(page.getByText('5.0 MB')).toBeVisible();
});

test('shows "No results found" when search returns nothing', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [] });
  await page.goto('/search?q=nothing&type=all');
  await expect(page.getByText(/no results found/i)).toBeVisible();
});

test('navigates to search page with query when form is submitted', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/search');
  // The main search input (type="search") inside the search form
  const searchInput = page.locator('main input[type="search"]');
  await searchInput.waitFor();
  await searchInput.focus();
  await page.keyboard.type('my query');
  // Submit the form by clicking the button
  await page.locator('main form button[type="submit"]').click();
  await page.waitForURL(/\/search\?.*q=my/);
});

test('expands result detail on click', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  await page.getByText('awesome-song.mp3').click();
  await expect(page.getByText('Test Artist')).toBeVisible();
  await expect(page.getByText('Test Album')).toBeVisible();
  await expect(page.getByText('3:30')).toBeVisible(); // 210s duration
});

test('shows source count in result row', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  await expect(page.getByText(/1 source/i)).toBeVisible();
});

test('search via navbar navigates to search page', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/home');
  await page.locator('nav input[type="search"]').fill('navbar query');
  await page.locator('nav button[type="submit"]').click();
  await page.waitForURL('**/search?**q=navbar+query**');
});

const TRANSFER_ROW = (state: string, progress: number, completedAt: string | null = null) => ({
  id: 'dl-1',
  sha256: 'a'.repeat(64),
  filename: 'awesome-song.mp3',
  size: '5242880',
  mimeType: 'audio/mpeg',
  state,
  bytesReceived: String(Math.floor((5242880 * progress) / 100)),
  progress,
  speedBps: state === 'COMPLETED' ? 0 : 1048576,
  etaSeconds: state === 'COMPLETED' ? null : 5,
  sources: 1,
  error: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  completedAt,
});

test('download button shows progress while downloading', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.route('/api/transfers', (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ json: { id: 'dl-1' } });
    if (route.request().method() === 'GET')
      return route.fulfill({ json: [TRANSFER_ROW('DOWNLOADING', 50)] });
    return route.continue();
  });

  await page.goto('/search?q=song&type=all');
  await page.getByText('awesome-song.mp3').click();
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('button', { name: /\d+%/ })).toBeVisible({ timeout: 8000 });
});

test('download button shows Done after completion', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.route('/api/transfers', (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ json: { id: 'dl-1' } });
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: [TRANSFER_ROW('COMPLETED', 100, '2024-01-01T01:00:00.000Z')],
      });
    return route.continue();
  });

  await page.goto('/search?q=song&type=all');
  await page.getByText('awesome-song.mp3').click();
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('button', { name: 'Done ✓' })).toBeVisible({ timeout: 8000 });
});
