#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prettier = path.join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
if (!fs.existsSync(prettier)) {
  console.error('Prettier is not installed. Run `npm install` first.');
  process.exit(1);
}

const write = process.argv.includes('--write');
const args = [prettier, write ? '--write' : '--check', '.', '--ignore-path', '.prettierignore'];
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
