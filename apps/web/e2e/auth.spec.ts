import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

const outbox = path.resolve(process.cwd(), 'apps/api/.email-outbox');

test('registers, verifies email, and signs in', async ({ page }) => {
  rmSync(outbox, { force: true });
  const email = `e2e-${randomUUID()}@example.com`;
  const password = 'correct-horse-battery';

  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('verification message has been requested')).toBeVisible();

  let token = '';
  for (let attempt = 0; attempt < 20 && token === ''; attempt += 1) {
    try {
      const text = readFileSync(outbox, 'utf8');
      if (text.includes(email)) {
        token = /#([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? '';
      }
    } catch {
      token = '';
    }
    if (token === '') await page.waitForTimeout(250);
  }
  expect(token).not.toBe('');

  await page.goto(`/verify-email#${token}`);
  await expect(page.getByText('Email verified')).toBeVisible();

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText('ACTIVE', { exact: true })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
});
