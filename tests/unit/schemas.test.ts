import { describe, expect, it } from 'vitest';
import {
  ApiScenarioSchema,
  BrowserScenarioSchema,
  DbScenarioSchema,
  ProjectInputSchema,
  TestCaseInputSchema,
  UserSettingsSchema,
} from '@zethub/shared-types';

describe('shared schemas', () => {
  it('applies safe browser defaults', () => {
    const scenario = BrowserScenarioSchema.parse({
      name: 'Smoke',
      steps: [{ action: 'goto', url: 'https://example.test' }],
    });
    expect(scenario.browser).toBe('chromium');
    expect(scenario.viewport).toEqual({ width: 1440, height: 900 });
    expect(scenario.trace).toBe(false);
    expect(scenario.timeoutMs).toBe(60_000);
  });

  it('requires at least one browser step', () => {
    expect(BrowserScenarioSchema.safeParse({ name: 'Empty', steps: [] }).success).toBe(false);
  });

  it('requires explicit API expectations and defaults to no mutation', () => {
    expect(
      ApiScenarioSchema.safeParse({ name: 'No expectations', request: { url: '/health' }, expectations: [] }).success,
    ).toBe(false);
    const scenario = ApiScenarioSchema.parse({
      name: 'Health',
      request: { url: '/health' },
      expectations: [{ type: 'status', equals: 200 }],
    });
    expect(scenario.request.method).toBe('GET');
    expect(scenario.request.allowMutation).toBe(false);
  });

  it('defaults database scenarios to read-only', () => {
    const scenario = DbScenarioSchema.parse({
      name: 'Tables',
      integrationId: 'db-1',
      checks: [{ type: 'query', sql: 'SELECT 1' }],
    });
    expect(scenario.allowWrites).toBe(false);
  });

  it('validates project input and rejects unsafe test keys', () => {
    expect(ProjectInputSchema.parse({ name: 'Demo' }).sourceType).toBe('LOCAL');
    expect(TestCaseInputSchema.safeParse({ key: 'bad key', title: 'x', kind: 'unit' }).success).toBe(false);
    expect(TestCaseInputSchema.safeParse({ key: 'custom:smoke-1', title: 'x', kind: 'unit' }).success).toBe(true);
  });

  it('parses user settings defaults', () => {
    const settings = UserSettingsSchema.parse({});
    expect(settings.defaultTimeoutMs).toBeGreaterThan(0);
    expect(settings.defaultBrowser).toBe('chromium');
    expect(settings.requireCommandApproval).toBe(true);
  });
});
