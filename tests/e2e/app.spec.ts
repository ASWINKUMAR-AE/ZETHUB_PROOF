import { test, expect } from '@playwright/test';
import { login, OWNER } from './helpers';

test.describe('public API and sign-in', () => {
  test('health endpoint reports API and database readiness', async ({ request }) => {
    const response = await request.get('/api/v1/system/health');
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { api: string; database: string; version: string };
    expect(body.api).toBe('ok');
    expect(body.database).toBe('ok');
    expect(body.version).toBeTruthy();
  });

  test('sets local security headers', async ({ request }) => {
    const response = await request.get('/api/v1/system/health');
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('denies project access without a session', async ({ request }) => {
    const response = await request.get('/api/v1/projects');
    expect(response.status()).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  test('rejects a wrong password and then signs in', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill('Wrong!Password2026');
    await page.getByRole('button', { name: /Sign in/ }).click();
    await expect(page.getByText('Could not continue')).toBeVisible();

    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: /Sign in/ }).click();
    await expect(page.getByRole('heading', { name: 'Verification overview' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test('renders a real not-found page for unknown routes', async ({ page }) => {
    await login(page);
    await page.goto('/does-not-exist');
    await expect(page.getByText(/not found|does not exist|404/i).first()).toBeVisible();
  });
});
