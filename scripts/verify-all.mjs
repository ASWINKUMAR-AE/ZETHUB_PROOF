#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipE2e = process.argv.includes('--skip-e2e');
const hasE2e = fs.existsSync(path.join(root, 'tests', 'e2e', 'playwright.config.ts'));

const steps = [
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'lint', command: 'npm', args: ['run', 'lint'] },
  { name: 'format:check', command: 'npm', args: ['run', 'format:check'] },
  { name: 'test', command: 'npm', args: ['test'] },
  { name: 'build', command: 'npm', args: ['run', 'build'] },
];

if (!skipE2e && hasE2e) {
  steps.push({ name: 'test:e2e', command: 'npm', args: ['run', 'test:e2e'] });
}

const results = [];
for (const step of steps) {
  const started = Date.now();
  console.log(`\n=== ${step.name} ===`);
  const result = spawnSync(step.command, step.args, { cwd: root, stdio: 'inherit', shell: true });
  const durationMs = Date.now() - started;
  const ok = result.status === 0;
  results.push({ name: step.name, ok, durationMs, status: result.status });
  if (!ok) {
    console.error(`\n${step.name} failed after ${(durationMs / 1000).toFixed(1)}s.`);
  }
}

console.log('\n=== verification summary ===');
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(14)} ${(result.durationMs / 1000).toFixed(1)}s`);
}
if (skipE2e || !hasE2e) {
  console.log(`SKIP  ${'test:e2e'.padEnd(14)} ${skipE2e ? 'disabled by --skip-e2e' : 'no Playwright config present'}`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} step(s) failed: ${failed.map((result) => result.name).join(', ')}`);
  process.exit(1);
}
console.log('\nAll configured verification steps passed.');
