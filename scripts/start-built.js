#!/usr/bin/env node
/** `npm run check` (second half) — start the binary `neu build` produced. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'hexstack-app-runner');

const name = process.platform === 'win32' ? 'hexstack-app-runner-win_x64.exe'
           : process.platform === 'darwin'
             ? (process.arch === 'arm64' ? 'hexstack-app-runner-mac_arm64' : 'hexstack-app-runner-mac_x64')
             : (process.arch === 'arm64' ? 'hexstack-app-runner-linux_arm64' : 'hexstack-app-runner-linux_x64');

const bin = path.join(DIST, name);
if (!fs.existsSync(bin)) {
  console.error(`No build found at ${bin}`);
  console.error('Run `npm run build` first. Built artifacts present:');
  try { fs.readdirSync(DIST).forEach((f) => console.error('  ' + f)); }
  catch { console.error('  (dist/ is empty)'); }
  process.exit(1);
}

if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
console.log(`==> starting ${bin}`);
const child = spawn(bin, [], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (e) => { console.error(`failed to start: ${e.message}`); process.exit(1); });
