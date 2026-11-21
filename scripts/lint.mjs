#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fix = process.argv.includes('--fix');

const eslint = new ESLint({ cwd: root, fix });
const results = await eslint.lintFiles(['.']);

if (fix) {
  await ESLint.outputFixes(results);
}

const formatter = await eslint.loadFormatter('stylish');
const output = formatter.format(results);
if (output.trim()) {
  process.stdout.write(output);
}

const errors = results.reduce((total, result) => total + result.errorCount, 0);
const warnings = results.reduce((total, result) => total + result.warningCount, 0);
const files = results.length;

console.log(`\nESLint: ${errors} error(s), ${warnings} warning(s) across ${files} linted file(s).`);
process.exitCode = errors > 0 ? 1 : 0;
