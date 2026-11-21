import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('owner sessions and device tokens', () => {
  test('generates a device token that authenticates a bearer request', async ({ page }) => {
    await login(page);
    await page.goto('/settings?tab=sessions');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: /Generate device token/ }).click();
    await expect(page.getByRole('heading', { name: 'Device token created' })).toBeVisible();

    const token = (await page.locator('.font-mono.text-slate-300').first().textContent())?.trim() ?? '';
    expect(token.length).toBeGreaterThanOrEqual(20);

    const response = await page.request.get('/api/v1/projects', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });
});
