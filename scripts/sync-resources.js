#!/usr/bin/env node
/**
 * Copy src/*.js into resources/js/ as browser-loadable globals.
 *
 * The modules are written as CommonJS so `node --test` can require them with no
 * toolchain. The Neutralino window has no module loader, so instead of adding a
 * bundler (esbuild/webpack) for two small files, each file is wrapped in a UMD
 * shim: it keeps `module.exports` working under Node and publishes a global
 * under the browser. ponytail: bundler is the upgrade path if src/ ever grows
 * past a handful of files or gains npm imports.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'resources', 'js');

const MODULES = [
  { file: 'registry.js', global: 'Registry' },
  { file: 'commands.js', global: 'Commands' },
  { file: 'electron.js', global: 'Electron' },
  { file: 'catalog.js', global: 'Catalog' },
];

fs.mkdirSync(OUT, { recursive: true });

for (const { file, global } of MODULES) {
  const body = fs.readFileSync(path.join(SRC, file), 'utf8');
  // Cross-module requires (e.g. electron.js -> ./commands) must resolve to the
  // browser global instead of Node's loader. The map is explicit so an
  // unmapped require fails loudly at load time rather than silently yielding
  // undefined helpers deep inside a click handler.
  const wrapped =
`/* AUTO-GENERATED from src/${file} by scripts/sync-resources.js — do not edit. */
(function (root, factory) {
  var m = { exports: {} };
  function localRequire(id) {
    var map = ${JSON.stringify(Object.fromEntries(MODULES.map(x => ['./' + x.file.replace(/\.js$/, ''), x.global])))};
    var g = map[id];
    if (g && root[g]) return root[g];
    throw new Error('sync-resources: unmapped require(' + id + ') in ${file}');
  }
  factory(m, m.exports, localRequire);
  if (typeof module === 'object' && module.exports) module.exports = m.exports;
  else root[${JSON.stringify(global)}] = m.exports;
})(typeof self !== 'undefined' ? self : this, function (module, exports, require) {
${body}
});
`;
  const dest = path.join(OUT, file);
  fs.writeFileSync(dest, wrapped);
  console.log(`synced src/${file} -> resources/js/${file} (global ${global})`);
}

// Guard: the copies must stay in step with src/. `npm test` runs this check.
if (process.argv.includes('--check')) {
  let stale = false;
  for (const { file } of MODULES) {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const gen = fs.readFileSync(path.join(OUT, file), 'utf8');
    if (!gen.includes(src)) {
      console.error(`STALE: resources/js/${file} does not contain current src/${file}`);
      stale = true;
    }
  }
  if (stale) process.exit(1);
  console.log('resources/js is in sync with src/');
}
