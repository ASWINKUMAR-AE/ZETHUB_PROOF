import { expect, type Page } from '@playwright/test';

export const OWNER = {
  email: 'e2e-owner@zethub.test',
  password: 'E2E!Passw0rd2026', // zethub-secret-scan:ignore test-only fixture
};

/** Signs in through the real API; the browser context keeps the session cookie. */
export async function login(page: Page): Promise<void> {
  const response = await page.request.post('/api/v1/auth/login', {
    data: { email: OWNER.email, password: OWNER.password, remember: true },
  });
  expect(response.ok(), `login failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Verification overview' })).toBeVisible();
}

export async function csrfToken(page: Page): Promise<string> {
  const response = await page.request.get('/api/v1/auth/me');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { csrfToken: string };
  return body.csrfToken;
}
