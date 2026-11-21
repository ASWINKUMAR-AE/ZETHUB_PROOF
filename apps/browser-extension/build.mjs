#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src');
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(src, 'background.ts'), path.join(src, 'popup.ts')],
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  sourcemap: false,
  minify: true,
  logLevel: 'info',
});

for (const file of ['manifest.json', 'popup.html', 'popup.css']) {
  fs.copyFileSync(path.join(src, file), path.join(out, file));
}

const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
if (!fs.existsSync(path.join(out, manifest.background.service_worker))) {
  throw new Error(`Missing background worker: ${manifest.background.service_worker}`);
}
if (!fs.existsSync(path.join(out, manifest.action.default_popup))) {
  throw new Error(`Missing popup: ${manifest.action.default_popup}`);
}

console.log(`Browser extension built in ${path.relative(process.cwd(), out)}`);
