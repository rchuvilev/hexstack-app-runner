'use strict';
const test = require('node:test');
const assert = require('node:assert');
const e = require('../src/electron');

test('parses the real `electron --version` output shape', () => {
  assert.deepStrictEqual(e.parseVersion('v44.1.0'), { installed: true, version: '44.1.0', major: 44 });
  assert.deepStrictEqual(e.parseVersion('30.0.5\n'), { installed: true, version: '30.0.5', major: 30 });
  assert.strictEqual(e.parseVersion('MISSING').installed, false);
  assert.strictEqual(e.parseVersion('').installed, false);
});

test('reads the required major from the real app manifests', () => {
  // shapes taken verbatim from the four ai-mentat apps
  assert.strictEqual(e.requiredMajor({ devDependencies: { electron: '^44.0.0' } }), 44);
  assert.strictEqual(e.requiredMajor({ devDependencies: { electron: '^30.0.5' } }), 30);
  assert.strictEqual(e.requiredMajor({ dependencies: { electron: '~28.1.2' } }), 28);
  assert.strictEqual(e.requiredMajor({ devDependencies: { electron: '44.x' } }), 44);
  assert.strictEqual(e.requiredMajor({}), null);
  assert.strictEqual(e.requiredMajor({ devDependencies: { electron: 'latest' } }), null);
});

test('MISMATCH is reported, not silently ignored', () => {
  // this is the real situation: interviews wants 30, the others want 44
  assert.ok(!e.isCompatible(44, 30));
  const note = e.compatibilityNote('ai-mentat-interviews', 44, 30);
  assert.match(note, /expects Electron 30/);
  assert.match(note, /44\.x is installed/);
});

test('compatible and unknown cases produce no warning', () => {
  assert.ok(e.isCompatible(44, 44));
  assert.strictEqual(e.compatibilityNote('x', 44, 44), '');
  assert.ok(e.isCompatible(44, null), 'unknown requirement must not block');
  assert.strictEqual(e.compatibilityNote('x', 44, null), '');
});

test('missing electron is incompatible with any stated requirement', () => {
  assert.ok(!e.isCompatible(null, 44));
  assert.match(e.compatibilityNote('x', null, 44), /not installed/);
});

test('apps whose main is a bundle are detected, and mapped to their source', () => {
  const bundled = { main: 'electron-main.bundle.js' };
  const plain = { main: 'src/index.js' };
  assert.ok(e.needsBundle(bundled));
  assert.ok(!e.needsBundle(plain));
  // running from source means pointing electron at the unbundled entry
  assert.strictEqual(e.sourceEntry(bundled), 'electron-main.js');
  assert.strictEqual(e.sourceEntry(plain), 'src/index.js');
  assert.strictEqual(e.sourceEntry({}), '.');
});

test('launch uses the GLOBAL electron binary, never a build artifact', () => {
  const cmd = e.launchCmd('linux', '/apps/x/repo', 'electron-main.js');
  assert.match(cmd, /electron 'electron-main\.js'/);
  assert.ok(!/electron-builder|\.AppImage|\.dmg|\.exe/.test(cmd), 'must not launch a built binary');
  assert.match(cmd, /^cd '\/apps\/x\/repo'/);
});

test('global install command is a global npm install', () => {
  assert.strictEqual(e.installGlobalCmd(), 'npm install -g electron');
  assert.strictEqual(e.installGlobalCmd('44'), 'npm install -g electron@44');
});

test('dependency install does not pull a second electron per app', () => {
  const cmd = e.installDepsCmd('linux', '/apps/x/repo');
  assert.match(cmd, /npm install/);
  assert.match(cmd, /--omit=optional/);
});

test('version command actually runs and parses on this machine', () => {
  const { execSync } = require('child_process');
  const out = execSync(e.versionCmd('linux'), { shell: '/bin/sh' }).toString();
  const v = e.parseVersion(out);
  // electron is not installed in this sandbox; the point is the probe reports
  // that cleanly rather than throwing
  assert.strictEqual(typeof v.installed, 'boolean');
  if (!v.installed) assert.strictEqual(v.major, null);
});

test('quoting still holds for a hostile directory name', () => {
  const evil = "/apps/x'; touch /tmp/hexrunner_E; echo '/repo";
  const cmd = e.launchCmd('linux', evil, 'main.js');
  const { execSync } = require('child_process');
  const { q } = require('../src/commands');
  const tokens = execSync(`printf '%s\\n' ${q(evil)}`, { shell: '/bin/sh' })
    .toString().replace(/\n$/, '').split('\n');
  assert.strictEqual(tokens.length, 1);
  assert.ok(!require('fs').existsSync('/tmp/hexrunner_E'));
  assert.ok(cmd.includes("'\\''"), 'directory must be escaped in the launch command');
});

/* ── launch plan ──────────────────────────────────────────────────────────── */

test('a bundled app is BUILT first, not launched from its source entry', () => {
  // Regression: ai-mentat-local-studio's electron-main.js requires
  // ./ai/advisor, which is ai/advisor.ts — TypeScript with ESM export, in a
  // package with no "type". Node resolves neither, so launching the source
  // entry died with `Cannot find module './ai/advisor'`.
  const pkg = {
    main: 'electron-main.bundle.js',
    scripts: { bundle: 'node sdk/utils/bundle-electron.js', run: 'npm run setup && ...' },
  };
  const plan = e.launchPlan(pkg);
  assert.strictEqual(plan.build, 'bundle');
  // and the REAL main is launched, not the rewritten source entry
  assert.strictEqual(plan.entry, 'electron-main.bundle.js');
  assert.notStrictEqual(plan.entry, e.sourceEntry(pkg));
});

test('a bundled app with no bundle script keeps the source-entry fallback', () => {
  // Some apps genuinely do run unbundled; removing that path would break them.
  const pkg = { main: 'electron-main.bundle.js', scripts: { start: 'x' } };
  const plan = e.launchPlan(pkg);
  assert.strictEqual(plan.build, null);
  assert.strictEqual(plan.entry, 'electron-main.js');
});

test('an app whose main is already runnable is never bundled', () => {
  const plan = e.launchPlan({ main: 'main.js', scripts: { bundle: 'should be ignored' } });
  assert.strictEqual(plan.build, null);
  assert.strictEqual(plan.entry, 'main.js');
});

test('launch plan survives junk package.json input', () => {
  for (const bad of [null, undefined, {}, { main: 42 }, { scripts: null }]) {
    const plan = e.launchPlan(bad);
    assert.strictEqual(plan.build, null);
    assert.ok(typeof plan.entry === 'string' && plan.entry.length > 0);
  }
});
