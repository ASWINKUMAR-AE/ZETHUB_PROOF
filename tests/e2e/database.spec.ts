import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { login } from './helpers';

const repoRoot = process.cwd();

test.describe('database dashboard', () => {
  test('reports a live connection and verifies setup non-destructively', async ({ page }) => {
    await login(page);
    await page.goto('/database');
    await expect(page.getByRole('heading', { name: 'Database' })).toBeVisible();
    await expect(page.getByText('Connection', { exact: true })).toBeVisible();
    await expect(page.getByText('Online', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /Verify setup/ }).click();
    await expect(page.getByRole('heading', { name: 'Setup verification' })).toBeVisible();
    await expect(page.getByText('passed', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  });
});

test.describe('browser extension build', () => {
  test('ships a least-privilege MV3 manifest and bundled scripts', () => {
    const dist = path.join(repoRoot, 'apps', 'browser-extension', 'dist');
    const manifestPath = path.join(dist, 'manifest.json');
    expect(fs.existsSync(manifestPath), 'run npm run extension:build first').toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      manifest_version: number;
      permissions: string[];
      host_permissions: string[];
      background: { service_worker: string };
      action: { default_popup: string };
    };
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).not.toContain('<all_urls>');
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.host_permissions.length).toBeGreaterThan(0);
    for (const host of manifest.host_permissions) {
      expect(host.startsWith('http://127.0.0.1') || host.startsWith('http://localhost')).toBe(true);
    }
    expect(fs.existsSync(path.join(dist, manifest.background.service_worker))).toBe(true);
    expect(fs.existsSync(path.join(dist, manifest.action.default_popup))).toBe(true);
    const html = fs.readFileSync(path.join(dist, manifest.action.default_popup), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
  });
});
