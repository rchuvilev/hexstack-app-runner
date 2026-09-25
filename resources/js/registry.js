/* AUTO-GENERATED from src/registry.js by scripts/sync-resources.js — do not edit. */
(function (root, factory) {
  var m = { exports: {} };
  function localRequire(id) {
    var map = {"./registry":"Registry","./commands":"Commands","./electron":"Electron","./catalog":"Catalog"};
    var g = map[id];
    if (g && root[g]) return root[g];
    throw new Error('sync-resources: unmapped require(' + id + ') in registry.js');
  }
  factory(m, m.exports, localRequire);
  if (typeof module === 'object' && module.exports) module.exports = m.exports;
  else root["Registry"] = m.exports;
})(typeof self !== 'undefined' ? self : this, function (module, exports, require) {
/**
 * App registry — the catalogue of installable apps and the user's wiring.
 *
 * Two sources, deliberately kept separate:
 *
 *   apps.json      shipped catalogue, `{ "<app-name>": "<repo url>" }`
 *   wired.json     user additions, written to the data dir at runtime.
 *                  Entries are either a remote repo URL or a local path.
 *
 * This module is PURE: it parses, validates and merges. Nothing here touches
 * the filesystem or spawns a process, so it runs under `node --test` with no
 * Neutralino present.
 */
'use strict';

const APP_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Remote repo URL we are willing to clone (https or ssh, git hosts). */
function isRepoUrl(s) {
  if (typeof s !== 'string' || !s.trim()) return false;
  return /^https:\/\/[^\s]+$/.test(s) || /^git@[^\s:]+:[^\s]+$/.test(s);
}

/** An app name must be safe to use as a directory component. */
function isValidAppName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 100
    && APP_NAME_RE.test(name)
    && name !== '.' && name !== '..';
}

/**
 * Parse a catalogue.
 *
 * Three shapes are accepted, because all three exist in the wild and rejecting
 * one only produces "my json didn't load" reports:
 *
 *   1. `{ "apps": [ {name, url, description?, electron?, …} ] }`
 *      — base-apps-list.json, the canonical published format.
 *   2. `[ {name, url} ]`                — a bare list.
 *   3. `{ "<name>": "<url>" }`          — the original flat map.
 *
 * Extra per-app metadata (description, homepage, branch, electron) is carried
 * through when present so the UI can show it without a second fetch.
 *
 * @returns {{apps: Array<object>, errors: string[], meta: object}}
 */
function parseCatalog(text) {
  const errors = [];
  let raw;
  try {
    raw = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    return { apps: [], errors: [`catalogue is not valid JSON: ${e.message}`], meta: {} };
  }

  const meta = {};
  let entries = [];

  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.apps)) {
    // canonical base-apps-list.json
    entries = raw.apps;
    if (raw.version !== undefined) meta.version = raw.version;
    if (raw.updated) meta.updated = raw.updated;
  } else if (raw && typeof raw === 'object') {
    // flat { name: url } map — skip the metadata keys a richer file may carry
    entries = Object.entries(raw)
      .filter(([k]) => !k.startsWith('$') && !['version', 'updated', 'description', 'apps'].includes(k))
      .map(([name, url]) => ({ name, url }));
  } else {
    return { apps: [], errors: ['catalogue must be an object or an array'], meta };
  }

  const apps = [];
  const seen = new Set();
  for (const item of entries) {
    if (!item || typeof item !== 'object') {
      errors.push(`ignored entry that is not an object: ${JSON.stringify(item)}`);
      continue;
    }
    const name = item.name ?? item.app ?? item.appName;
    const url = item.url ?? item.repo ?? item.repoUrl;
    if (!isValidAppName(name)) { errors.push(`invalid app name: ${JSON.stringify(name)}`); continue; }
    if (!isRepoUrl(url))       { errors.push(`invalid repo url for ${name}: ${JSON.stringify(url)}`); continue; }
    if (seen.has(name))        { errors.push(`duplicate app name: ${name}`); continue; }
    seen.add(name);
    const app = { name, url, source: 'catalog', kind: 'remote' };
    if (item.description) app.description = String(item.description);
    if (item.homepage) app.homepage = String(item.homepage);
    if (item.branch) app.branch = String(item.branch);
    if (Number.isInteger(item.electron)) app.electron = item.electron;
    apps.push(app);
  }
  return { apps, errors, meta };
}

/**
 * Parse user-wired entries.
 * `{ "<name>": {"url": "..."} }` for remote, `{"path": "..."}` for local.
 * A bare string is treated as a URL, matching apps.json.
 */
function parseWired(text) {
  const errors = [];
  let raw;
  try {
    raw = typeof text === 'string' ? (text.trim() ? JSON.parse(text) : {}) : (text || {});
  } catch (e) {
    return { apps: [], errors: [`wired.json is not valid JSON: ${e.message}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { apps: [], errors: ['wired.json must be an object'] };
  }

  const apps = [];
  for (const [name, v] of Object.entries(raw)) {
    if (!isValidAppName(name)) { errors.push(`invalid app name: ${JSON.stringify(name)}`); continue; }
    if (typeof v === 'string') {
      if (!isRepoUrl(v)) { errors.push(`invalid repo url for ${name}`); continue; }
      apps.push({ name, url: v, source: 'wired', kind: 'remote' });
    } else if (v && typeof v === 'object' && typeof v.path === 'string' && v.path.trim()) {
      apps.push({ name, path: v.path, source: 'wired', kind: 'local' });
    } else if (v && typeof v === 'object' && isRepoUrl(v.url)) {
      apps.push({ name, url: v.url, source: 'wired', kind: 'remote' });
    } else {
      errors.push(`entry ${name} needs a repo "url" or a local "path"`);
    }
  }
  return { apps, errors };
}

/**
 * Merge catalogue + wired. User entries win on name collision, so a user can
 * point a catalogue name at their own fork without editing shipped files.
 */
function mergeRegistry(catalogApps, wiredApps) {
  const byName = new Map();
  for (const a of catalogApps) byName.set(a.name, a);
  for (const a of wiredApps) byName.set(a.name, a);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Decide which action a row offers.
 *  remote + not installed -> install
 *  remote + installed     -> update / uninstall
 *  local                  -> unwire (never delete a user's own directory)
 */
function actionsFor(app, installed) {
  if (app.kind === 'local') return installed ? ['open', 'unwire'] : ['unwire'];
  return installed ? ['update', 'open', 'uninstall'] : ['install'];
}

/* ── app icons ───────────────────────────────────────────────────────────── */

/**
 * Conventional locations of an Electron app's icon inside its own repo.
 *
 * Ordered by how the Hexstack apps actually declare it. Most published apps
 * set electron-builder's `build.<os>.icon` to `icon.png` at the repo root;
 * ai-mentat-interviews declares no icon and keeps `src/assets/logo.png`;
 * ai-mentat-dejavu is a web app with no electron-builder config at all, so its
 * icon is the PWA manifest one under `site/`. `build/icon.png` is
 * electron-builder's own default when nothing is declared.
 *
 * PNG only — `.icns` and `.ico` sit beside these in several repos but no
 * webview renders them in an `<img>`, so listing them would only produce
 * candidates that always fail.
 *
 * Why not read `build.icon` out of the app's package.json? That is one extra
 * network round-trip per app to learn a path already first in this list. If an
 * app ever declares something exotic, add it here.
 */
const ICON_PATHS = [
  'icon.png',
  'build/icon.png',
  'assets/icon.png',
  'resources/icon.png',
  'src/assets/logo.png',
  'site/icon-512.png',
];

/**
 * GitHub `owner/repo` for a clone URL, or null when it is not GitHub.
 * Handles both `https://github.com/o/r.git` and `git@github.com:o/r.git`.
 */
function githubSlug(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
         || url.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Candidate icon URLs for an app, best guess first.
 *
 * Served from GitHub raw rather than the cloned checkout, so the list shows an
 * icon BEFORE the app is installed — which is when it is most useful. The
 * webview caches them, and a failed load falls through to the next candidate
 * and finally to the UI's placeholder.
 *
 * Empty for local (user-wired path) apps and for non-GitHub remotes: there is
 * no raw URL to build, and guessing one would 404 on every candidate.
 */
function iconUrls(app) {
  if (!app || app.kind === 'local') return [];
  const slug = githubSlug(app.url);
  if (!slug) return [];
  const branch = (typeof app.branch === 'string' && app.branch.trim()) || 'main';
  return ICON_PATHS.map((f) => `https://raw.githubusercontent.com/${slug}/${branch}/${f}`);
}

module.exports = {
  isRepoUrl, isValidAppName,
  parseCatalog, parseWired, mergeRegistry, actionsFor,
  iconUrls, githubSlug, ICON_PATHS,
};

});
