import { expect, test } from '@playwright/test';

test('shows the foundation shell and a live health check', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'K2 Group' })).toBeVisible();
  await expect(page.getByText('does not provide accounts, payments, or trading')).toBeVisible();
  const status = page.getByRole('status');
  await expect(status).toContainText('Operational');
  await expect(status).toContainText('0001');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
});
