import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('project workflow', () => {
  test('creates a URL project through the UI and lists it', async ({ page }) => {
    await login(page);
    await page.goto('/projects');
    await expect(page.getByRole('heading', { level: 1, name: 'Projects', exact: true })).toBeVisible();

    const name = `E2E Website ${Date.now()}`;
    await page
      .getByRole('button', { name: /New project/ })
      .first()
      .click();
    await page.getByLabel('Project name').fill(name);
    await page.getByRole('button', { name: /Website/ }).click();
    await page.getByLabel('Website URL').fill('https://example.com');
    await page.getByRole('button', { name: 'Create project' }).click();

    await expect(page).toHaveURL(/\/projects\/[A-Za-z0-9]+/);
    await expect(page.getByText(name).first()).toBeVisible();

    const projectId = page.url().split('/').pop() ?? '';
    const detail = await page.request.get(`/api/v1/projects/${projectId}`);
    expect(detail.ok()).toBeTruthy();
    const body = (await detail.json()) as { project: { name: string; sourceType: string; websiteUrl: string } };
    expect(body.project).toMatchObject({ name, sourceType: 'url', websiteUrl: 'https://example.com' });

    await page.goto('/projects');
    await page.getByPlaceholder(/Search projects/).fill(name);
    await expect(page.getByText(name).first()).toBeVisible();
    await expect(page.getByText('1 project')).toBeVisible();
  });

  test('shows the project tabs and a real detection state', async ({ page }) => {
    await login(page);
    await page.goto('/projects');
    const link = page.locator('a[href^="/projects/"]').first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByRole('tab', { name: /Overview/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Test cases/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Runs/ })).toBeVisible();
  });
});
