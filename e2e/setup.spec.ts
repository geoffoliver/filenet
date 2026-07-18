import { expect, test } from '@playwright/test';

import { SETTINGS, mockSettingsUnconfigured } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockSettingsUnconfigured(page);
});

test('renders welcome page with "Get started"', async ({ page }) => {
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: /welcome to filenet/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /get started/i })).toBeVisible();
});

test('shows name field on step 2', async ({ page }) => {
  await page.goto('/setup');
  await page.getByRole('button', { name: /get started/i }).click();
  await expect(page.getByLabel(/display name/i)).toBeVisible();
});

test('shows download folder field on step 4', async ({ page }) => {
  await page.goto('/setup');
  // Navigate: Welcome → Name → Shared folders → Download folder
  await page.getByRole('button', { name: /get started/i }).click();
  // Step 2: enter name and proceed
  await page.getByLabel(/display name/i).fill('Test');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  // Step 3: shared folders — skip
  await page.getByRole('button', { name: /skip/i }).click();
  // Step 4: download folder
  await expect(page.getByRole('heading', { name: /where should downloads go/i })).toBeVisible();
  await expect(page.getByLabel(/download folder/i)).toBeVisible();
});

test('shows port field on step 5', async ({ page }) => {
  await page.goto('/setup');
  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByLabel(/display name/i).fill('Test');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: /skip/i }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: /which port/i })).toBeVisible();
  await expect(page.getByLabel(/listening port/i)).toBeVisible();
});

test('submitting setup with a name saves settings and redirects', async ({ page }) => {
  let saved: unknown;
  await page.route('/api/settings', (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { ...SETTINGS, name: 'My Node' } });
    }
    return route.fulfill({ json: { ...SETTINGS, name: '' } });
  });

  await page.goto('/setup');
  // Step 1 → 2
  await page.getByRole('button', { name: /get started/i }).click();
  // Step 2: name
  await page.getByLabel(/display name/i).fill('My Node');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  // Step 3: shared folders — skip
  await page.getByRole('button', { name: /skip/i }).click();
  // Step 4: download folder — skip
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  // Step 5: port — keep default, proceed
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  // Step 6: preferences — finish
  await page.getByRole('button', { name: /finish setup/i }).click();

  await page.waitForURL('**/home');
  expect(saved).toBeDefined();
  expect((saved as { name: string }).name).toBe('My Node');
});

test('empty name prevents advancing from step 2', async ({ page }) => {
  await page.goto('/setup');
  await page.getByRole('button', { name: /get started/i }).click();
  // The Next button should be disabled when name is empty
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});

test('default port value is 7734 on step 5', async ({ page }) => {
  await page.goto('/setup');
  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByLabel(/display name/i).fill('Test');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: /skip/i }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel(/listening port/i)).toHaveValue('7734');
});
