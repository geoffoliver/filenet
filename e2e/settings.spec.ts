import { expect, test } from '@playwright/test';

import { SETTINGS, mockBaseApp } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
});

test('renders current name', async ({ page }) => {
  await page.goto('/settings');
  // Name input is inside a label with text "Display name"
  await expect(page.locator('input[type="text"]').first()).toHaveValue('Test User');
});

test('renders listen port', async ({ page }) => {
  await page.goto('/settings');
  // Port field has min="1" max="65535"
  await expect(page.locator('input[type="number"][min="1"]')).toHaveValue('7734');
});

test('renders shared folders', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('/shared')).toBeVisible();
});

test('renders download folder', async ({ page }) => {
  await page.goto('/settings');
  // The download FolderPicker input has placeholder="/path/to/downloads"
  await expect(page.locator('input[placeholder="/path/to/downloads"]')).toHaveValue('/downloads');
});

test('saving settings calls the API with updated values', async ({ page }) => {
  let patched: unknown;
  await page.route('/api/settings', (route) => {
    if (route.request().method() === 'PATCH' || route.request().method() === 'PUT') {
      patched = route.request().postDataJSON();
      return route.fulfill({ json: { ...SETTINGS, name: 'Updated Name' } });
    }
    return route.fulfill({ json: SETTINGS });
  });

  await page.goto('/settings');
  // Update the name field (first text input, inside the Profile section)
  const nameInput = page.locator('input[type="text"]').first();
  await nameInput.clear();
  await nameInput.fill('Updated Name');
  await page
    .getByRole('button', { name: /^save$/i })
    .first()
    .click();

  expect(patched).toBeDefined();
  expect((patched as { name: string }).name).toBe('Updated Name');
});

test('rescan button exists', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: /rescan now/i })).toBeVisible();
});

test('rescan now calls the API', async ({ page }) => {
  let called = false;
  await page.route('/api/rescan', (route) => {
    called = true;
    return route.fulfill({ json: { indexed: 5, removed: 0 } });
  });

  await page.goto('/settings');
  await page.getByRole('button', { name: /rescan now/i }).click();
  expect(called).toBe(true);
});

test('auto-accept toggles are rendered', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('Auto-accept friend requests from anyone')).toBeVisible();
  await expect(page.getByText('Auto-accept friend requests from friends of friends')).toBeVisible();
});

test('rescan interval field is rendered', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('Rescan interval')).toBeVisible();
  // Default value from SETTINGS is 60 minutes
  await expect(
    page.getByRole('spinbutton', { name: 'Rescan interval minutes (0 = disabled)' }),
  ).toHaveValue('60');
});

test('startup toggle is rendered with the correct default', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('Automatically open the app in your browser on start')).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Automatically open the app in your browser on start' }),
  ).toBeChecked();
});

test('unchecking the startup toggle calls the API with autoOpenBrowser: false', async ({
  page,
}) => {
  let patched: unknown;
  await page.route('/api/settings', (route) => {
    if (route.request().method() === 'PATCH' || route.request().method() === 'PUT') {
      patched = route.request().postDataJSON();
      return route.fulfill({ json: { ...SETTINGS, autoOpenBrowser: false } });
    }
    return route.fulfill({ json: SETTINGS });
  });

  await page.goto('/settings');
  await page
    .getByRole('checkbox', { name: 'Automatically open the app in your browser on start' })
    .uncheck();
  const startupSection = page.locator('section', {
    has: page.getByText('Automatically open the app in your browser on start'),
  });
  await startupSection.getByRole('button', { name: /^save$/i }).click();

  expect(patched).toEqual({ autoOpenBrowser: false });
});

test('shows enable button when notification permission is default', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).Notification = class {
      static permission = 'default';
      static requestPermission = async () => 'granted';
    };
  });
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: /enable desktop notifications/i })).toBeVisible();
});

test('shows an enabled message when notification permission is granted', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).Notification = class {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
    };
  });
  await page.goto('/settings');
  await expect(page.getByText(/desktop notifications are enabled/i)).toBeVisible();
});

test('shows a blocked message when notification permission is denied', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).Notification = class {
      static permission = 'denied';
      static requestPermission = async () => 'denied';
    };
  });
  await page.goto('/settings');
  await expect(page.getByText(/desktop notifications are blocked/i)).toBeVisible();
});

test('shows an unsupported message when the Notification API is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).Notification = undefined;
  });
  await page.goto('/settings');
  await expect(page.getByText(/not supported/i)).toBeVisible();
});

test('clicking enable requests permission and updates the UI', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).Notification = class {
      static permission = 'default';
      static requestPermission = async () => 'granted';
    };
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: /enable desktop notifications/i }).click();
  await expect(page.getByText(/desktop notifications are enabled/i)).toBeVisible();
});
