/**
 * Where the app catalogue comes from.
 *
 * The canonical list is published at the runner repo root as
 * `base-apps-list.json` and served by GitHub raw. Nothing is bundled with the
 * app: shipping a copy means a stale list the moment the published one
 * changes, and two sources of truth to keep in step.
 *
 * Policy:
 *   • Refresh  → fetch the remote file, then write it to localStorage.
 *   • Startup / offline / failed fetch → read the localStorage copy.
 *   • Neither  → empty list, and say so. An empty catalogue is reported, never
 *                silently presented as if it were the real list.
 *
 * The cache is the ONLY fallback, so a first run with no network shows an
 * honest "press Refresh" state instead of a bundled list that may be wrong.
 *
 * Pure module: storage and network are injected, so ordering and cache policy
 * are unit-testable with no browser and no network.
 */
'use strict';

const OWNER = 'hexstack-apps';
const REPO = 'hexstack-app-runner';
const BRANCH = 'main';
const FILE = 'base-apps-list.json';

/** Canonical published URL of the catalogue. */
const REMOTE_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${FILE}`;

/** localStorage key holding the last successfully fetched catalogue. */
const CACHE_KEY = 'hexstack.appCatalog.v1';

/**
 * Read the cached catalogue.
 * @param {{getItem:(k:string)=>string|null}} storage
 * @returns {{text:string, fetchedAt:string|null}|null}
 */
function readCache(storage) {
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return null;
    const env = JSON.parse(raw);
    if (!env || typeof env.text !== 'string' || !env.text.trim()) return null;
    return { text: env.text, fetchedAt: env.fetchedAt || null };
  } catch {
    return null; // corrupt cache behaves as no cache
  }
}

/**
 * Store a freshly fetched catalogue.
 * Wrapped in an envelope so we keep the fetch time without touching the
 * published JSON itself.
 */
function writeCache(storage, text, now = () => new Date().toISOString()) {
  try {
    storage.setItem(CACHE_KEY, JSON.stringify({ text, fetchedAt: now() }));
    return true;
  } catch {
    return false; // quota/private mode — not fatal, the list still loads
  }
}

/** Forget the cached catalogue. */
function clearCache(storage) {
  try { storage.removeItem(CACHE_KEY); return true; } catch { return false; }
}

/**
 * Fetch the published catalogue and cache it. Used by the Refresh button.
 *
 * @param {object} io
 * @param {(url:string)=>Promise<string>} io.fetchText
 * @param {object} io.storage                 localStorage-like
 * @param {(text:string)=>{apps:Array,errors:Array,meta:object}} io.parse
 * @returns {Promise<{apps,errors,meta,from,cached:boolean}>}
 */
async function refreshCatalog(io) {
  let text;
  try {
    text = await io.fetchText(REMOTE_URL);
  } catch (e) {
    // Network failed — fall back to whatever we cached earlier.
    const cached = loadCachedCatalog(io);
    cached.errors = [
      `could not fetch ${REMOTE_URL}: ${e && e.message ? e.message : e}`,
      ...cached.errors,
    ];
    return cached;
  }

  const parsed = io.parse(text);
  if (!parsed.apps.length) {
    // Refuse to cache a catalogue that yields nothing; keep the previous one.
    const cached = loadCachedCatalog(io);
    return {
      ...cached,
      errors: ['fetched catalogue contained no usable apps; keeping cached copy', ...cached.errors],
    };
  }

  const stored = writeCache(io.storage, text);
  return {
    ...parsed,
    from: REMOTE_URL,
    cached: false,
    stored,
  };
}

/**
 * Load the catalogue from localStorage only. Used on startup so the UI paints
 * immediately without a network round-trip.
 */
function loadCachedCatalog(io) {
  const hit = readCache(io.storage);
  if (!hit) {
    return {
      apps: [], errors: [], meta: {}, from: null, cached: true, fetchedAt: null, empty: true,
    };
  }
  const parsed = io.parse(hit.text);
  return { ...parsed, from: CACHE_KEY, cached: true, fetchedAt: hit.fetchedAt };
}

module.exports = {
  OWNER, REPO, BRANCH, FILE, REMOTE_URL, CACHE_KEY,
  readCache, writeCache, clearCache,
  refreshCatalog, loadCachedCatalog,
};
