'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  isRepoUrl, isValidAppName, parseCatalog, parseWired, mergeRegistry, actionsFor,
} = require('../src/registry');
const r = require('../src/registry');

test('accepts the shipped catalogue shape {name: url}', () => {
  const { apps, errors } = parseCatalog(JSON.stringify({
    'ai-mentat-interviews': 'https://github.com/hexstack-apps/ai-mentat-interviews.git',
    'ai-mentat-sdk': 'https://github.com/hexstack-apps/ai-mentat-sdk.git',
  }));
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(apps.length, 2);
  assert.deepStrictEqual(apps.map(a => a.name).sort(),
    ['ai-mentat-interviews', 'ai-mentat-sdk']);
  assert.ok(apps.every(a => a.kind === 'remote' && a.source === 'catalog'));
});

test('also accepts an array of objects (common first guess)', () => {
  const { apps, errors } = parseCatalog(JSON.stringify([
    { name: 'a', url: 'https://github.com/x/a.git' },
  ]));
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(apps[0].name, 'a');
});

test('rejects malformed json with a message instead of throwing', () => {
  const { apps, errors } = parseCatalog('{not json');
  assert.strictEqual(apps.length, 0);
  assert.match(errors[0], /not valid JSON/);
});

test('rejects unsafe app names and bad urls, keeping the good entries', () => {
  const { apps, errors } = parseCatalog(JSON.stringify({
    '../escape': 'https://github.com/x/y.git',
    'has space': 'https://github.com/x/y.git',
    'ok-app': 'https://github.com/x/ok.git',
    'bad-url': 'file:///etc/passwd',
    'js-url': 'javascript:alert(1)',
  }));
  assert.deepStrictEqual(apps.map(a => a.name), ['ok-app']);
  assert.strictEqual(errors.length, 4, errors.join(' | '));
});

test('isValidAppName / isRepoUrl guard the trust boundary', () => {
  for (const bad of ['../x', 'a/b', 'a\\b', '', '.', '..', 'x'.repeat(101), null]) {
    assert.ok(!isValidAppName(bad), `should reject name ${JSON.stringify(bad)}`);
  }
  assert.ok(isValidAppName('ai-mentat-roblox-studio'));
  for (const bad of ['file:///x', 'javascript:x', 'http://x/y.git', '', null, 'rm -rf /']) {
    assert.ok(!isRepoUrl(bad), `should reject url ${JSON.stringify(bad)}`);
  }
  assert.ok(isRepoUrl('https://github.com/a/b.git'));
  assert.ok(isRepoUrl('git@github.com:a/b.git'));
});

test('wired entries carry either a remote url or a local path', () => {
  const { apps, errors } = parseWired(JSON.stringify({
    remoteApp: { url: 'https://github.com/x/r.git' },
    localApp: { path: '/home/me/dev/myapp' },
    bareString: 'https://github.com/x/b.git',
    broken: { nothing: true },
  }));
  assert.strictEqual(errors.length, 1);
  const byName = Object.fromEntries(apps.map(a => [a.name, a]));
  assert.strictEqual(byName.remoteApp.kind, 'remote');
  assert.strictEqual(byName.localApp.kind, 'local');
  assert.strictEqual(byName.localApp.path, '/home/me/dev/myapp');
  assert.strictEqual(byName.bareString.kind, 'remote');
});

test('empty wired.json is not an error (first run)', () => {
  const { apps, errors } = parseWired('');
  assert.deepStrictEqual(apps, []);
  assert.deepStrictEqual(errors, []);
});

test('user-wired entry overrides a catalogue entry of the same name', () => {
  const cat = parseCatalog(JSON.stringify({ app: 'https://github.com/upstream/app.git' })).apps;
  const wired = parseWired(JSON.stringify({ app: { path: '/my/fork' } })).apps;
  const merged = mergeRegistry(cat, wired);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].kind, 'local');
  assert.strictEqual(merged[0].path, '/my/fork');
});

test('merge is sorted by name so the list does not jump around', () => {
  const cat = parseCatalog(JSON.stringify({
    zebra: 'https://github.com/x/z.git', alpha: 'https://github.com/x/a.git',
  })).apps;
  assert.deepStrictEqual(mergeRegistry(cat, []).map(a => a.name), ['alpha', 'zebra']);
});

test('actions: remote installs then updates/uninstalls; local only unwires', () => {
  const remote = { name: 'r', kind: 'remote', url: 'https://github.com/x/r.git' };
  const local  = { name: 'l', kind: 'local', path: '/tmp/l' };
  assert.deepStrictEqual(actionsFor(remote, false), ['install']);
  assert.deepStrictEqual(actionsFor(remote, true), ['update', 'open', 'uninstall']);
  // a local repo must never offer uninstall - we do not delete the user's dir
  assert.ok(!actionsFor(local, true).includes('uninstall'));
  assert.ok(actionsFor(local, true).includes('unwire'));
});

/* ── icons ───────────────────────────────────────────────────────────────── */

test('icon urls are derived only for GitHub remotes', () => {
  const app = { kind: 'remote', url: 'https://github.com/hexstack-apps/ai-mentat-local-studio.git' };
  const urls = r.iconUrls(app);
  assert.strictEqual(urls.length, r.ICON_PATHS.length);
  assert.strictEqual(urls[0],
    'https://raw.githubusercontent.com/hexstack-apps/ai-mentat-local-studio/main/icon.png');
  // a wired local path and a non-GitHub remote have no raw URL to build
  assert.deepStrictEqual(r.iconUrls({ kind: 'local', path: '/tmp/x' }), []);
  assert.deepStrictEqual(r.iconUrls({ kind: 'remote', url: 'https://gitlab.com/o/r.git' }), []);
  assert.deepStrictEqual(r.iconUrls(null), []);
});

test('icon urls honour a non-default branch', () => {
  const urls = r.iconUrls({ kind: 'remote', url: 'https://github.com/o/r.git', branch: 'trunk' });
  assert.match(urls[0], /^https:\/\/raw\.githubusercontent\.com\/o\/r\/trunk\//);
  // blank or missing branch falls back to main, never to an empty path segment
  for (const b of [undefined, '', '   ']) {
    assert.match(r.iconUrls({ kind: 'remote', url: 'https://github.com/o/r.git', branch: b })[0],
      /\/o\/r\/main\//);
  }
});

test('github slug accepts both clone url forms and rejects the rest', () => {
  assert.strictEqual(r.githubSlug('https://github.com/o/r.git'), 'o/r');
  assert.strictEqual(r.githubSlug('https://github.com/o/r'), 'o/r');
  assert.strictEqual(r.githubSlug('git@github.com:o/r.git'), 'o/r');
  for (const bad of ['https://gitlab.com/o/r.git', 'https://github.com/o', 'nonsense', '', null]) {
    assert.strictEqual(r.githubSlug(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

/**
 * Apps that genuinely ship NO image file in their repo — verified by listing
 * the git tree, not a list of known failures kept around to silence this test.
 * The UI falls back to an initial-letter tile for these.
 *
 * Membership is asserted in BOTH directions below: anything not named here
 * must resolve an icon (so a wrong ICON_PATHS still fails loudly), and
 * anything named here must resolve nothing (so the day one of them gains an
 * icon, this test says to take it off the list).
 */
const NO_ICON_IN_REPO = new Set(['ai-mentat-minecraft']);

/**
 * The candidate list is a set of GUESSES about other repos' layouts, so a test
 * that only checks string shape would pass while every icon 404s. This asks
 * GitHub whether at least one candidate resolves for each published app.
 */
test('every published app resolves to a real icon on GitHub', { concurrency: 4 }, async (t) => {
  const catalog = JSON.parse(
    require('fs').readFileSync(require('path').join(__dirname, '..', 'base-apps-list.json'), 'utf8'));

  let checked = 0;
  for (const app of catalog.apps) {
    const urls = r.iconUrls({ ...app, kind: 'remote' });
    assert.ok(urls.length, `${app.name}: no candidates`);
    let hit = null;
    for (const u of urls) {
      let res;
      try { res = await fetch(u, { method: 'HEAD' }); }
      catch { return t.skip('no network'); }
      if (res.ok) { hit = u; break; }
    }
    if (NO_ICON_IN_REPO.has(app.name)) {
      assert.strictEqual(hit, null,
        `${app.name} now HAS an icon (${hit}) — remove it from NO_ICON_IN_REPO`);
    } else {
      assert.ok(hit, `${app.name}: none of ${urls.length} candidates exist — fix ICON_PATHS`);
    }
    checked++;
  }
  assert.strictEqual(checked, catalog.apps.length);
});

test('CONTROL: a bogus candidate path really does 404', async (t) => {
  // Proves the test above can fail rather than passing on a lenient fetch.
  let res;
  try {
    res = await fetch('https://raw.githubusercontent.com/hexstack-apps/ai-mentat-local-studio/main/no-such-icon.png',
      { method: 'HEAD' });
  } catch { return t.skip('no network'); }
  assert.ok(!res.ok, 'a missing raw path must not report ok');
});
