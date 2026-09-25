'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cat = require('../src/catalog');
const { parseCatalog } = require('../src/registry');

/** Minimal localStorage stand-in. */
function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => Object.fromEntries(m),
    _size: () => m.size,
  };
}
const io = (fetchText, storage) => ({ fetchText, storage, parse: parseCatalog });
const GOOD = JSON.stringify({
  version: 1,
  apps: [{ name: 'app-one', url: 'https://github.com/a/b.git', electron: 44 }],
});

test('the published file parses and lists every ai-mentat app', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'base-apps-list.json'), 'utf8');
  const { apps, errors, meta } = parseCatalog(text);
  assert.deepStrictEqual(errors, [], errors.join(' | '));
  assert.deepStrictEqual(apps.map((a) => a.name).sort(), [
    'ai-mentat-coolify-local',
    'ai-mentat-dejavu',
    'ai-mentat-interviews',
    'ai-mentat-local-studio',
    'ai-mentat-minecraft',
    'ai-mentat-n8n',
    'ai-mentat-roblox-studio',
  ]);
  assert.strictEqual(meta.version, 1);
  assert.strictEqual(apps.find((a) => a.name === 'ai-mentat-interviews').electron, 30);
  // dejavu is the one app whose Electron entry is a wrapper around a static
  // site served over localhost, so its declared major is worth pinning here:
  // a mismatch with its package.json devDependency is what would make the
  // runner warn on every launch.
  assert.strictEqual(apps.find((a) => a.name === 'ai-mentat-dejavu').electron, 44);
});

test('remote URL points at the repo root file on raw.githubusercontent.com', () => {
  assert.strictEqual(cat.REMOTE_URL,
    'https://raw.githubusercontent.com/hexstack-apps/hexstack-app-runner/main/base-apps-list.json');
});

/* ── refresh ───────────────────────────────────────────────────────────── */

test('refresh fetches the remote file AND writes it to storage', async () => {
  const storage = memStorage();
  let askedFor = null;
  const r = await cat.refreshCatalog(io(async (u) => { askedFor = u; return GOOD; }, storage));
  assert.strictEqual(askedFor, cat.REMOTE_URL);
  assert.deepStrictEqual(r.apps.map((a) => a.name), ['app-one']);
  assert.strictEqual(r.cached, false);
  assert.strictEqual(r.stored, true);
  // the cache now holds the exact bytes that were fetched
  const env = JSON.parse(storage.getItem(cat.CACHE_KEY));
  assert.strictEqual(env.text, GOOD);
  assert.ok(env.fetchedAt, 'fetch time must be recorded');
});

test('a failed fetch falls back to the cached copy', async () => {
  const storage = memStorage();
  await cat.refreshCatalog(io(async () => GOOD, storage));        // seed the cache
  const r = await cat.refreshCatalog(io(async () => { throw new Error('offline'); }, storage));
  assert.deepStrictEqual(r.apps.map((a) => a.name), ['app-one'], 'must serve the cache');
  assert.strictEqual(r.cached, true);
  assert.match(r.errors[0], /could not fetch/);
});

test('a fetch returning 0 usable apps does NOT overwrite a good cache', async () => {
  const storage = memStorage();
  await cat.refreshCatalog(io(async () => GOOD, storage));
  const before = storage.getItem(cat.CACHE_KEY);
  const r = await cat.refreshCatalog(io(async () => '{"apps":[]}', storage));
  assert.deepStrictEqual(r.apps.map((a) => a.name), ['app-one'], 'previous list must survive');
  assert.match(r.errors[0], /no usable apps/);
  assert.strictEqual(storage.getItem(cat.CACHE_KEY), before, 'cache must be untouched');
});

/* ── startup ───────────────────────────────────────────────────────────── */

test('startup reads the cache and never touches the network', async () => {
  const storage = memStorage();
  await cat.refreshCatalog(io(async () => GOOD, storage));
  let fetched = false;
  const r = cat.loadCachedCatalog({
    storage, parse: parseCatalog,
    fetchText: async () => { fetched = true; return GOOD; },
  });
  assert.strictEqual(fetched, false, 'startup must not fetch');
  assert.deepStrictEqual(r.apps.map((a) => a.name), ['app-one']);
  assert.strictEqual(r.cached, true);
  assert.ok(r.fetchedAt);
});

test('first run with an empty cache yields an explicit empty state', () => {
  const r = cat.loadCachedCatalog(io(async () => GOOD, memStorage()));
  assert.deepStrictEqual(r.apps, []);
  assert.strictEqual(r.empty, true);
  assert.strictEqual(r.from, null);
  // NOT an error — it is a normal first run; the UI prompts for Refresh
  assert.deepStrictEqual(r.errors, []);
});

test('a corrupt cache behaves as no cache instead of throwing', () => {
  const storage = memStorage({ [cat.CACHE_KEY]: '{not json' });
  const r = cat.loadCachedCatalog(io(async () => GOOD, storage));
  assert.deepStrictEqual(r.apps, []);
  assert.strictEqual(r.empty, true);
});

test('storage that refuses writes does not break the refresh', async () => {
  const storage = memStorage();
  storage.setItem = () => { throw new Error('QuotaExceeded'); };
  const r = await cat.refreshCatalog(io(async () => GOOD, storage));
  assert.deepStrictEqual(r.apps.map((a) => a.name), ['app-one'], 'list still loads');
  assert.strictEqual(r.stored, false, 'and reports that it could not cache');
});

test('clearCache removes the stored catalogue', async () => {
  const storage = memStorage();
  await cat.refreshCatalog(io(async () => GOOD, storage));
  assert.strictEqual(storage._size(), 1);
  cat.clearCache(storage);
  assert.strictEqual(storage.getItem(cat.CACHE_KEY), null);
});

test('CONTROL: nothing is bundled — with an empty cache and no network the list is empty', async () => {
  // This is the property the "no bundled sources" requirement asks for.
  const storage = memStorage();
  const r = await cat.refreshCatalog(io(async () => { throw new Error('no net'); }, storage));
  assert.deepStrictEqual(r.apps, [], 'must not fall back to any bundled file');
  assert.match(r.errors[0], /could not fetch/);
});

/* ── parsing shapes ────────────────────────────────────────────────────── */

test('all three catalogue shapes are accepted', () => {
  for (const [label, text] of [
    ['canonical', JSON.stringify({ apps: [{ name: 'a', url: 'https://github.com/a/b.git' }] })],
    ['list', JSON.stringify([{ name: 'a', url: 'https://github.com/a/b.git' }])],
    ['flat', JSON.stringify({ a: 'https://github.com/a/b.git' })],
  ]) {
    assert.deepStrictEqual(parseCatalog(text).apps.map((x) => x.name), ['a'], `${label} failed`);
  }
});

test('metadata keys in a flat map are not mistaken for apps', () => {
  const { apps, errors } = parseCatalog(JSON.stringify({
    $schema: 'https://example.com/s.json', version: 1, updated: '2026-09-05',
    'real-app': 'https://github.com/a/b.git',
  }));
  assert.deepStrictEqual(apps.map((a) => a.name), ['real-app']);
  assert.deepStrictEqual(errors, []);
});

test('a hostile catalogue entry cannot inject a bad name or url', () => {
  const { apps, errors } = parseCatalog(JSON.stringify({
    apps: [
      { name: '../../etc', url: 'https://github.com/a/b.git' },
      { name: 'ok', url: 'file:///etc/passwd' },
      { name: 'fine', url: 'https://github.com/a/b.git' },
    ],
  }));
  assert.deepStrictEqual(apps.map((a) => a.name), ['fine']);
  assert.strictEqual(errors.length, 2);
});
