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

test('renders results as a table with core columns', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Type' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Size' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Sources' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Details' })).toBeVisible();
});

test('shows source count and details column in the row', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  const row = page.getByRole('row', { name: /awesome-song.mp3/ });
  await expect(row.getByRole('cell').nth(4)).toHaveText('1'); // Sources column
  await expect(row.getByRole('cell').nth(5)).toHaveText('3:30'); // Details: 210s duration
});

test('search via navbar navigates to search page', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/home');
  await page.locator('nav input[type="search"]').fill('navbar query');
  await page.locator('nav button[type="submit"]').click();
  await page.waitForURL('**/search?**q=navbar+query**');
});

// progress is 0..1 fraction, matching the real /api/transfers response
const TRANSFER_ROW = (state: string, progress: number, completedAt: string | null = null) => ({
  id: 'dl-1',
  sha256: 'a'.repeat(64),
  filename: 'awesome-song.mp3',
  size: '5242880',
  mimeType: 'audio/mpeg',
  state,
  bytesReceived: String(Math.floor(5242880 * progress)),
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
      return route.fulfill({ json: [TRANSFER_ROW('DOWNLOADING', 0.5)] });
    return route.continue();
  });

  await page.goto('/search?q=song&type=all');
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('button', { name: /\d+%/ })).toBeVisible({ timeout: 8000 });
});

test('download button shows Done after completion', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.route('/api/transfers', (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ json: { id: 'dl-1' } });
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: [TRANSFER_ROW('COMPLETED', 1, '2024-01-01T01:00:00.000Z')],
      });
    return route.continue();
  });

  await page.goto('/search?q=song&type=all');
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('button', { name: 'Done ✓' })).toBeVisible({ timeout: 8000 });
});

test('info icon opens a drawer with full metadata', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  await page.getByRole('button', { name: /details for awesome-song.mp3/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Test Artist')).toBeVisible();
  await expect(dialog.getByText('Test Album')).toBeVisible();
  await expect(dialog.getByText('3:30')).toBeVisible(); // 210s duration
});

test('drawer moves focus to the Close button on open', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  await page.getByRole('button', { name: /details for awesome-song.mp3/i }).click();
  await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
});

test('drawer closes on Escape, X button, and backdrop click', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');

  await page.getByRole('button', { name: /details for awesome-song.mp3/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await page.getByRole('button', { name: /details for awesome-song.mp3/i }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await page.getByRole('button', { name: /details for awesome-song.mp3/i }).click();
  // Click outside the drawer panel itself (top-left corner of the backdrop)
  await page.mouse.click(5, 5);
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

const NETWORK_FILE_2 = {
  sha256: 'b'.repeat(64),
  filename: 'another-song.mp3',
  size: '2097152',
  mimeType: 'audio/mpeg',
  metadata: JSON.stringify({ duration: 90 }),
  nodeId: 'node-bob',
  viaNodeId: null,
};

test('selecting rows shows a bulk-action toolbar with the right count', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE, NETWORK_FILE_2] });
  await page.goto('/search?q=song&type=all');

  await page.getByRole('checkbox', { name: 'Select awesome-song.mp3' }).check();
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select another-song.mp3' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText(/selected/)).not.toBeVisible();
});

test('Download All fires a download for every selected row', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE, NETWORK_FILE_2] });
  const startedIds: string[] = [];
  await page.route('/api/transfers', (route) => {
    if (route.request().method() === 'POST') {
      const id = `dl-${startedIds.length + 1}`;
      startedIds.push(id);
      return route.fulfill({ json: { id } });
    }
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    return route.continue();
  });

  await page.goto('/search?q=song&type=all');
  await page.getByRole('checkbox', { name: 'Select awesome-song.mp3' }).check();
  await page.getByRole('checkbox', { name: 'Select another-song.mp3' }).check();
  await page.getByRole('button', { name: 'Download All' }).click();

  await expect(page.getByText(/selected/)).not.toBeVisible(); // selection clears
  await expect.poll(() => startedIds.length).toBe(2);
});

test('the select-all header checkbox selects every selectable row', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE, NETWORK_FILE_2] });
  await page.goto('/search?q=song&type=all');
  await page.getByRole('checkbox', { name: 'Select all results' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
});
