#!/usr/bin/env node
/**
 * `npm run setup` for the runner itself.
 *
 * Installs npm deps, the Neutralino CLI + binaries, and the global Electron the
 * runner hands to every app it launches.
 */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
const probe = (cmd) => {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
};

console.log('==> setup: hexstack-app-runner');

// Submodules first: nothing else can build if a submodule is missing.
// The runner has none today, but this repo is vendored as a submodule
// elsewhere and may gain its own — keeping the step means setup stays correct
// if that happens, instead of failing in a confusing way later.
if (fs.existsSync(path.join(ROOT, '.gitmodules'))) {
  console.log('--> git submodules');
  try { sh('git submodule update --init --recursive'); }
  catch { console.warn('    could not init submodules — check repo access'); }
}

console.log('--> npm dependencies');
sh(fs.existsSync(path.join(ROOT, 'package-lock.json')) ? 'npm ci' : 'npm install');

// Neutralino binaries are downloaded by the CLI, not shipped in npm.
console.log('--> neutralino binaries');
try {
  sh('npx --no-install neu update');
} catch {
  try { sh('npx @neutralinojs/neu update'); }
  catch { console.warn('    could not run `neu update` — run it manually before `npm run run`'); }
}

// One global Electron runs every app from source; no per-app build.
console.log('--> global electron');
const ev = probe('electron --version');
if (ev) {
  console.log(`    already installed: ${ev}`);
} else {
  try {
    sh('npm install -g electron');
    console.log(`    installed: ${probe('electron --version') || 'unknown'}`);
  } catch {
    console.warn('    global install failed. Either run it with elevated permissions:');
    console.warn('      sudo npm install -g electron');
    console.warn('    or use a user-owned npm prefix:');
    console.warn('      npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:$PATH');
  }
}

// Non-npm tools the runner shells out to.
const missing = ['git', 'node', 'npm'].filter((t) => !probe(`command -v ${t}`));
if (missing.length) console.warn(`--> missing system dependencies: ${missing.join(', ')}`);
else console.log('--> system dependencies present');

console.log('==> setup complete');
