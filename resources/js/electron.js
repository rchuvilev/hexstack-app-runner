/* AUTO-GENERATED from src/electron.js by scripts/sync-resources.js — do not edit. */
(function (root, factory) {
  var m = { exports: {} };
  function localRequire(id) {
    var map = {"./registry":"Registry","./commands":"Commands","./electron":"Electron","./catalog":"Catalog"};
    var g = map[id];
    if (g && root[g]) return root[g];
    throw new Error('sync-resources: unmapped require(' + id + ') in electron.js');
  }
  factory(m, m.exports, localRequire);
  if (typeof module === 'object' && module.exports) module.exports = m.exports;
  else root["Electron"] = m.exports;
})(typeof self !== 'undefined' ? self : this, function (module, exports, require) {
/**
 * Global Electron management.
 *
 * The runner installs ONE Electron globally (`npm i -g electron`) and launches
 * every app's source with it, so apps run up-to-date code straight from the
 * checkout — no per-app `npm run build`, no packaged executable.
 *
 * Why a version check matters: the apps do not all want the same major.
 * At time of writing three ai-mentat apps declare `electron ^44` while
 * ai-mentat-interviews declares `^30`. Running an app on the wrong major is a
 * real failure mode (native module ABI, removed APIs), so the runner reports
 * the mismatch instead of pretending one binary fits all.
 *
 * Pure module: builds command strings and compares versions. No side effects.
 */
'use strict';

const { q, qWin } = require('./commands');

/** `npm i -g electron` (optionally pinned to a major). */
function installGlobalCmd(version) {
  const spec = version ? `electron@${version}` : 'electron';
  return `npm install -g ${spec}`;
}

/** Print the global electron version, or MISSING. */
function versionCmd(platform) {
  if (platform === 'windows') {
    return 'where electron >nul 2>&1 && (electron --version) || (echo MISSING)';
  }
  return 'if command -v electron >/dev/null 2>&1; then electron --version 2>&1 | head -1; else echo MISSING; fi';
}

/** Parse `v44.1.0` / `44.1.0` / `MISSING` -> {installed, version, major}. */
function parseVersion(stdout) {
  const s = String(stdout || '').trim();
  if (!s || /MISSING/i.test(s)) return { installed: false, version: '', major: null };
  const m = s.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { installed: false, version: s, major: null };
  return { installed: true, version: `${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]) };
}

/**
 * The Electron major an app asks for, from its package.json dependency range.
 * Handles `^44.0.0`, `~30.1.2`, `>=28 <30`, `44.x`, `latest`.
 * @returns {number|null} null when unknown/unpinned.
 */
function requiredMajor(pkgJson) {
  if (!pkgJson || typeof pkgJson !== 'object') return null;
  const dev = pkgJson.devDependencies || {};
  const dep = pkgJson.dependencies || {};
  const range = dev.electron || dep.electron;
  if (typeof range !== 'string') return null;
  const m = range.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Is the installed global Electron acceptable for this app?
 * Unknown requirement = allowed (we do not block on missing metadata).
 */
function isCompatible(installedMajor, requiredMaj) {
  if (requiredMaj == null) return true;
  if (installedMajor == null) return false;
  return installedMajor === requiredMaj;
}

function compatibilityNote(appName, installedMajor, requiredMaj) {
  if (isCompatible(installedMajor, requiredMaj)) return '';
  if (installedMajor == null) return `${appName}: Electron is not installed.`;
  return `${appName} expects Electron ${requiredMaj}.x but ${installedMajor}.x is installed globally. ` +
         `It may fail to start. Install a matching Electron, or run this app with its own local copy.`;
}

/**
 * Launch an app's SOURCE with the global electron binary.
 * `main` comes from the app's package.json; when it points at a build artifact
 * the caller is responsible for producing it first (see needsBundle).
 */
function launchCmd(platform, dir, entry) {
  const Q = platform === 'windows' ? qWin : q;
  const cd = platform === 'windows' ? `cd /d ${Q(dir)}` : `cd ${Q(dir)}`;
  const target = entry ? ` ${Q(entry)}` : ' .';
  if (platform === 'windows') return `${cd} && start "" electron${target}`;
  return `${cd} && electron${target} >/dev/null 2>&1 &`;
}

/**
 * Does this app need a bundle step before its `main` exists?
 * True when package.json main names a *.bundle.js that the repo does not track.
 */
function needsBundle(pkgJson) {
  const main = pkgJson && typeof pkgJson.main === 'string' ? pkgJson.main : '';
  return /\.bundle\.js$/.test(main);
}

/** The entry Electron should be given: the source main when we skip bundling. */
function sourceEntry(pkgJson) {
  const main = pkgJson && typeof pkgJson.main === 'string' ? pkgJson.main : '';
  if (!main) return '.';
  // electron-main.bundle.js -> electron-main.js
  return needsBundle(pkgJson) ? main.replace(/\.bundle\.js$/, '.js') : main;
}

/**
 * How to launch this app: build the bundle first, or hand Electron an entry.
 *
 * 🔴 The unbundled entry beside a `*.bundle.js` main is NOT reliably runnable.
 * ai-mentat-local-studio's electron-main.js does `require('./ai/advisor')`,
 * and that file is `ai/advisor.ts` — TypeScript, using ESM `export`, in a
 * package with no `"type"` field. Node resolves neither the extension nor the
 * module system, so launching it dies immediately with
 * `Cannot find module './ai/advisor'`. Three of its modules are like this.
 * Only the app's own bundler transpiles and resolves them.
 *
 * So when `main` is a build artifact AND the app exposes a `bundle` script,
 * run that and launch the real `main`. `npm run run` would also work but
 * resolves its own electron, which defeats the one-global-Electron design
 * this runner exists for — `bundle` is the surgical step.
 *
 * Apps with no `bundle` script keep the previous behaviour, which is correct
 * for anything whose source entry really does run unbundled.
 */
function launchPlan(pkgJson) {
  const scripts = (pkgJson && pkgJson.scripts) || {};
  const canBundle = typeof scripts.bundle === 'string' && scripts.bundle.trim() !== '';
  if (needsBundle(pkgJson) && canBundle) {
    const main = pkgJson && typeof pkgJson.main === 'string' ? pkgJson.main : '';
    return { build: 'bundle', entry: main };
  }
  return { build: null, entry: sourceEntry(pkgJson) };
}

/** Install only what the app needs to RUN (skip electron itself: it is global). */
function installDepsCmd(platform, dir) {
  const Q = platform === 'windows' ? qWin : q;
  const cd = platform === 'windows' ? `cd /d ${Q(dir)}` : `cd ${Q(dir)}`;
  return `${cd} && npm install --omit=optional --no-audit --no-fund`;
}

module.exports = {
  installGlobalCmd, versionCmd, parseVersion,
  requiredMajor, isCompatible, compatibilityNote,
  launchCmd, needsBundle, sourceEntry, launchPlan, installDepsCmd,
};

});
