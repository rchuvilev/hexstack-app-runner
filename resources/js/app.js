/**
 * Hexstack App Runner — UI layer.
 *
 * All shell commands come from Commands (src/commands.js) and all parsing from
 * Registry (src/registry.js); this file only wires them to the DOM and to
 * Neutralino. Keeping it that way is what makes the risky parts testable
 * without a browser.
 */
'use strict';

Neutralino.init();

const $ = (sel) => document.querySelector(sel);
const logEl = () => $('#log');

let PLATFORM = 'linux';     // 'linux' | 'darwin' | 'windows'
let HOME = '';              // the user's home dir; the apps root lives inside it
let STATE = { apps: [], installed: {} };
let ELECTRON = { installed: false, version: '', major: null };

/* `electron.js` publishes the global `Electron`; alias it to avoid shadowing
   Neutralino's own naming and to keep call sites readable. */
const ElectronMod = (typeof Electron !== 'undefined') ? Electron : (typeof module !== 'undefined' ? require('../../src/electron') : {});

/* ── helpers ─────────────────────────────────────────────────────────────── */

function log(msg, cls) {
  const el = logEl();
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

/** Run a command, streaming a summary to the log. Returns {ok, stdout, stderr}. */
async function run(cmd, label) {
  log(`$ ${label || cmd}`, 'cmd');
  try {
    const r = await Neutralino.os.execCommand(cmd);
    const out = (r.stdOut || '').trim();
    const err = (r.stdErr || '').trim();
    if (out) out.split('\n').slice(-40).forEach((l) => log('  ' + l));
    if (err) err.split('\n').slice(-40).forEach((l) => log('  ' + l, 'warn'));
    const ok = (r.exitCode === 0 || r.exitCode === undefined);
    if (!ok) log(`  exit code ${r.exitCode}`, 'err');
    return { ok, stdout: out, stderr: err, exitCode: r.exitCode };
  } catch (e) {
    log(`  failed: ${e && e.message ? e.message : e}`, 'err');
    return { ok: false, stdout: '', stderr: String(e), exitCode: -1 };
  }
}

/**
 * Resolve the home directory the apps root sits in.
 *
 * Everything else in this file waits on it: with no home there is no apps
 * root, and `Commands.rootDir` refuses to build one (it used to sit at the
 * filesystem root, which macOS mounts read-only).
 */
async function detectHome() {
  const key = PLATFORM === 'windows' ? 'USERPROFILE' : 'HOME';
  try { HOME = (await Neutralino.os.getEnv(key)) || ''; } catch { HOME = ''; }
  return HOME;
}

async function detectPlatform() {
  try {
    const os = await Neutralino.computer.getOSInfo();
    const n = (os.name || '').toLowerCase();
    PLATFORM = n.includes('windows') ? 'windows' : n.includes('darwin') || n.includes('mac') ? 'darwin' : 'linux';
  } catch {
    PLATFORM = (navigator.platform || '').toLowerCase().includes('win') ? 'windows'
             : (navigator.platform || '').toLowerCase().includes('mac') ? 'darwin' : 'linux';
  }
}

// Empty until detectHome() resolves, so a render never throws on a missing home.
const dataRoot = () => (HOME ? Commands.rootDir(PLATFORM, HOME) : '');

/* ── registry load / save ────────────────────────────────────────────────── */

async function readFileOr(path, fallback) {
  try { return await Neutralino.filesystem.readFile(path); }
  catch { return fallback; }
}

async function loadRegistry({ refresh = false } = {}) {
  // Nothing is bundled: the catalogue is fetched from GitHub raw on Refresh and
  // cached in localStorage. Startup reads the cache only, so the window paints
  // without waiting on the network.
  const cio = {
    fetchText: async (url) => {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    },
    storage: window.localStorage,
    parse: Registry.parseCatalog,
  };

  const cat = refresh ? await Catalog.refreshCatalog(cio) : Catalog.loadCachedCatalog(cio);

  if (cat.empty) {
    log('no app list yet — press ⟳ Refresh to fetch it', 'warn');
  } else if (cat.cached) {
    log(`catalogue: ${cat.apps.length} app(s) from cache${cat.fetchedAt ? ' (fetched ' + cat.fetchedAt + ')' : ''}`);
  } else {
    log(`catalogue: ${cat.apps.length} app(s) fetched and cached`, 'ok');
    if (cat.stored === false) log('  (could not write localStorage — cache disabled)', 'warn');
  }

  const wiredPath = `${dataRoot()}${PLATFORM === 'windows' ? '\\' : '/'}wired.json`;
  const wiredText = await readFileOr(wiredPath, '');
  const wired = Registry.parseWired(wiredText);
  [...(cat.errors || []), ...wired.errors].forEach((e) => log(e, 'warn'));

  STATE.apps = Registry.mergeRegistry(cat.apps, wired.apps);
  return STATE.apps;
}

async function saveWired(entries) {
  const sep = PLATFORM === 'windows' ? '\\' : '/';
  const path = `${dataRoot()}${sep}wired.json`;
  await Neutralino.filesystem.writeFile(path, JSON.stringify(entries, null, 2));
}

async function currentWired() {
  const sep = PLATFORM === 'windows' ? '\\' : '/';
  const text = await readFileOr(`${dataRoot()}${sep}wired.json`, '');
  try { return text.trim() ? JSON.parse(text) : {}; } catch { return {}; }
}

/* ── installed detection ─────────────────────────────────────────────────── */

async function refreshInstalled() {
  const installed = {};
  for (const app of STATE.apps) {
    const dir = app.kind === 'local' ? app.path : Commands.appRepoDir(PLATFORM, app.name, HOME);
    try {
      const r = await Neutralino.os.execCommand(Commands.dirExistsCmd(PLATFORM, dir));
      installed[app.name] = (r.stdOut || '').trim().startsWith('YES');
    } catch { installed[app.name] = false; }
  }
  STATE.installed = installed;
  return installed;
}

/* ── rendering ───────────────────────────────────────────────────────────── */

const LABEL = {
  install: 'Install', update: 'Update', uninstall: 'Uninstall',
  unwire: 'Unwire', open: 'Open',
};

/**
 * App icon element, walking the candidate paths from Registry.iconUrls().
 *
 * Repos disagree on where the Electron icon lives, so each 404 advances to the
 * next candidate; the browser does the fetching and caching. When nothing
 * resolves — a local repo, a non-GitHub remote, or every candidate missing —
 * an initial-letter tile keeps the row height identical.
 */
function appIconEl(app) {
  const placeholder = () => {
    const el = document.createElement('span');
    el.className = 'app-icon placeholder';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = ((app.name || '?')[0] || '?').toUpperCase();
    return el;
  };

  const urls = Registry.iconUrls(app);
  if (!urls.length) return placeholder();

  const img = document.createElement('img');
  img.className = 'app-icon';
  img.alt = '';
  img.loading = 'lazy';
  let at = 0;
  img.onerror = () => {
    at += 1;
    if (at < urls.length) img.src = urls[at];
    else img.replaceWith(placeholder());
  };
  img.src = urls[0];
  return img;
}

function render() {
  const list = $('#app-list');
  list.innerHTML = '';
  if (!STATE.apps.length) {
    list.innerHTML = '<div class="empty">No apps yet — press <b>⟳ Refresh list</b> to fetch the published catalogue, or use “＋ Wire a repo”.</div>';
    return;
  }
  for (const app of STATE.apps) {
    const installed = !!STATE.installed[app.name];
    const row = document.createElement('div');
    row.className = 'app-row' + (installed ? ' is-installed' : '');

    row.appendChild(appIconEl(app));

    const info = document.createElement('div');
    info.className = 'app-info';
    const name = document.createElement('div');
    name.className = 'app-name';
    name.textContent = app.name;
    const badge = document.createElement('span');
    badge.className = 'badge ' + (app.kind === 'local' ? 'badge-local' : 'badge-remote');
    badge.textContent = app.kind === 'local' ? 'local' : 'remote';
    name.appendChild(badge);
    if (installed) {
      const ok = document.createElement('span');
      ok.className = 'badge badge-ok';
      ok.textContent = 'installed';
      name.appendChild(ok);
    }
    const src = document.createElement('div');
    src.className = 'app-src';
    src.textContent = app.kind === 'local' ? app.path : app.url;
    info.append(name, src);

    const actions = document.createElement('div');
    actions.className = 'app-actions';
    for (const a of Registry.actionsFor(app, installed)) {
      const b = document.createElement('button');
      b.className = 'btn btn-sm' + (a === 'uninstall' || a === 'unwire' ? ' btn-danger' : a === 'install' ? ' btn-primary' : '');
      b.textContent = LABEL[a];
      b.onclick = () => doAction(a, app);
      actions.appendChild(b);
    }
    if (installed) {
      // Apps run from SOURCE with the global Electron, so the primary action is
      // Run. `npm run setup` stays available for apps that fetch extra
      // non-npm assets (engines, VM images) as part of their own setup.
      const runBtn = document.createElement('button');
      runBtn.className = 'btn btn-sm btn-primary';
      runBtn.textContent = '▶ Run';
      runBtn.title = 'Launch this app from source with the global Electron';
      runBtn.onclick = () => doRun(app);
      actions.appendChild(runBtn);

      const depsBtn = document.createElement('button');
      depsBtn.className = 'btn btn-xs btn-ghost';
      depsBtn.textContent = 'Install deps';
      depsBtn.title = 'npm install (Electron itself stays global)';
      depsBtn.onclick = () => doInstallDeps(app);
      actions.appendChild(depsBtn);

      const setupBtn = document.createElement('button');
      setupBtn.className = 'btn btn-xs btn-ghost';
      setupBtn.textContent = 'setup';
      setupBtn.title = 'npm run setup — non-npm assets this app needs';
      setupBtn.onclick = () => doScript(app, 'setup');
      actions.appendChild(setupBtn);
    }
    row.append(info, actions);
    list.appendChild(row);
  }
}

/* ── actions ─────────────────────────────────────────────────────────────── */

/**
 * Every path builder needs HOME, and `Commands.rootDir` throws without it
 * rather than falling back to `/`. Guard the entry points once so a failed
 * home lookup shows a hint instead of an uncaught error in a click handler.
 */
function requireHome() {
  if (HOME) return true;
  showCreateHint();
  log('no home directory — cannot resolve the apps directory', 'err');
  return false;
}

function appDir(app) {
  return app.kind === 'local' ? app.path : Commands.appRepoDir(PLATFORM, app.name, HOME);
}

async function doAction(action, app) {
  if (app.kind !== 'local' && !requireHome()) return;
  if (action === 'install') {
    const r = await run(Commands.installCmd(PLATFORM, app.name, app.url, HOME), `install ${app.name}`);
    if (!r.ok && /permission denied|access is denied/i.test(r.stderr)) {
      showCreateHint();
    }
  } else if (action === 'update') {
    await run(Commands.updateCmd(PLATFORM, app.name, HOME), `update ${app.name}`);
  } else if (action === 'uninstall') {
    if (!confirm(`Remove the cloned repo for “${app.name}”?\n\n${appDir(app)}\n\nIts data directory is kept.`)) return;
    await run(Commands.uninstallCmd(PLATFORM, app.name, HOME), `uninstall ${app.name}`);
  } else if (action === 'unwire') {
    if (!confirm(`Unwire “${app.name}”?\n\nThis only removes it from the list. Nothing on disk is deleted.`)) return;
    const w = await currentWired();
    delete w[app.name];
    await saveWired(w);
    log(`unwired ${app.name} (files left untouched)`);
  } else if (action === 'open') {
    await run(Commands.openDirCmd(PLATFORM, appDir(app)), `open ${app.name}`);
    return;
  }
  await reload();
}

async function doScript(app, script) {
  await run(Commands.runScriptCmd(PLATFORM, appDir(app), script), `${app.name}: npm run ${script}`);
}

/** Read an installed app's package.json (for entry point + electron range). */
async function readAppPkg(app) {
  const sep = PLATFORM === 'windows' ? '\\' : '/';
  try {
    const text = await Neutralino.filesystem.readFile(`${appDir(app)}${sep}package.json`);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function doInstallDeps(app) {
  await run(ElectronMod.installDepsCmd(PLATFORM, appDir(app)), `${app.name}: install dependencies`);
}

/**
 * Launch an app from source with the GLOBAL electron.
 * No packaging, no per-app electron download — the checkout is the code that runs.
 */
async function doRun(app) {
  const dir = appDir(app);
  const pkg = await readAppPkg(app);

  // 1. global electron present?
  const v = ElectronMod.parseVersion(
    (await Neutralino.os.execCommand(ElectronMod.versionCmd(PLATFORM))).stdOut);
  if (!v.installed) {
    log('Electron is not installed globally. Run setup first.', 'err');
    return;
  }

  // 2. version sanity - warn, do not silently run on the wrong major
  const need = ElectronMod.requiredMajor(pkg);
  const note = ElectronMod.compatibilityNote(app.name, v.major, need);
  if (note) {
    log(note, 'warn');
    if (!confirm(`${note}\n\nLaunch anyway?`)) return;
  }

  // 3. dependencies present?
  const nm = await Neutralino.os.execCommand(
    Commands.dirExistsCmd(PLATFORM, `${dir}${PLATFORM === 'windows' ? '\\' : '/'}node_modules`));
  if (!(nm.stdOut || '').trim().startsWith('YES')) {
    log(`${app.name}: node_modules missing — installing first`, 'warn');
    const r = await run(ElectronMod.installDepsCmd(PLATFORM, dir), `${app.name}: install dependencies`);
    if (!r.ok) { log('dependency install failed; not launching', 'err'); return; }
  }

  // 4. some apps declare main as a build artifact. Running "without building"
  //    means pointing electron at the unbundled source entry instead.
  // The unbundled entry beside a *.bundle.js main is not reliably runnable —
  // see launchPlan(). Build first when the app declares how.
  const plan = ElectronMod.launchPlan(pkg);
  if (plan.build) {
    log(`${app.name}: main is a build artifact; running npm run ${plan.build} first`);
    const b = await run(Commands.runScriptCmd(PLATFORM, dir, plan.build), `${app.name}: npm run ${plan.build}`);
    if (!b.ok) { log(`${app.name}: bundle failed; not launching`, 'err'); return; }
  }
  await run(ElectronMod.launchCmd(PLATFORM, dir, plan.entry), `${app.name}: launch (electron ${v.version})`);
}

/* ── setup ───────────────────────────────────────────────────────────────── */

function showCreateHint() {
  const el = $('#setup-hint');
  el.textContent = HOME
    ? `The apps directory ${dataRoot()} is missing or not writable by your user.\nRun this, then press “Run setup” again:\n\n  ` +
      Commands.createHint(PLATFORM, HOME)
    : 'Could not read your home directory, so there is nowhere to put the apps directory.';
  el.classList.remove('hidden');
}

function setPrereq(tool, ok, version) {
  const el = document.querySelector(`.prereq[data-tool="${tool}"]`);
  if (!el) return;
  el.classList.toggle('ok', !!ok);
  el.classList.toggle('bad', !ok);
  el.querySelector('.ver').textContent = version || (ok ? '' : 'missing');
}

async function doSetup() {
  $('#setup-hint').classList.add('hidden');
  log('— setup —');
  if (!requireHome()) return;
  const r = await run(Commands.checkPrereqsCmd(PLATFORM), 'check git / node / npm');
  const p = Commands.parsePrereqs(r.stdout);
  setPrereq('git', p.git.ok, p.git.version);
  setPrereq('node', p.node.ok, p.node.version);
  setPrereq('npm', p.npm.ok, p.npm.version);

  const missing = ['git', 'node', 'npm'].filter((t) => !p[t].ok);
  if (missing.length) {
    log(`missing: ${missing.join(', ')} — install them, then run setup again`, 'err');
    const el = $('#setup-hint');
    el.textContent = installGuidance(missing);
    el.classList.remove('hidden');
  }

  // Electron: one global install serves every app, so apps run from source.
  if (!missing.includes('npm')) {
    let ev = ElectronMod.parseVersion(
      (await run(ElectronMod.versionCmd(PLATFORM), 'check electron')).stdout);
    if (!ev.installed) {
      log('installing Electron globally (one copy for all apps)…');
      const ir = await run(ElectronMod.installGlobalCmd(), 'npm install -g electron');
      if (!ir.ok) {
        log('global Electron install failed — you may need elevated permissions', 'err');
        const el = $('#setup-hint');
        el.textContent = PLATFORM === 'windows'
          ? 'Run the installer again from an Administrator prompt, or:\n\n  npm install -g electron'
          : 'npm needs write access to its global prefix. Either:\n\n' +
            '  sudo npm install -g electron\n\nor point npm at a user-owned prefix:\n\n' +
            '  npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:$PATH';
        el.classList.remove('hidden');
      }
      ev = ElectronMod.parseVersion(
        (await Neutralino.os.execCommand(ElectronMod.versionCmd(PLATFORM))).stdOut);
    }
    setPrereq('electron', ev.installed, ev.version);
    ELECTRON = ev;
  }

  const mk = await run(Commands.ensureRootCmd(PLATFORM, HOME), `create ${dataRoot()}`);
  // writable, not merely present: a root-owned root passes mkdir and fails clone
  const ex = await run(Commands.dirWritableCmd(PLATFORM, dataRoot()), 'verify apps dir is writable');
  const rootOk = (ex.stdout || '').trim().startsWith('YES');
  setPrereq('root', rootOk, rootOk ? dataRoot() : '');
  if (!rootOk || !mk.ok) showCreateHint();

  const allOk = missing.length === 0 && rootOk && ELECTRON.installed;
  log(allOk ? 'setup complete — apps can now be installed and run from source'
            : 'setup incomplete — see above', allOk ? 'ok' : 'warn');
  await reload();
}

function installGuidance(missing) {
  const list = missing.join(', ');
  if (PLATFORM === 'darwin') {
    return `Install ${list} with Homebrew:\n\n  brew install ${missing.map(m => m === 'npm' ? 'node' : m).join(' ')}`;
  }
  if (PLATFORM === 'windows') {
    return `Install ${list}:\n\n  winget install Git.Git OpenJS.NodeJS`;
  }
  return `Install ${list}, for example:\n\n  sudo apt install ${missing.map(m => m === 'npm' ? 'npm' : m).join(' ')}\n  # or: sudo dnf install ${missing.join(' ')}`;
}

/* ── wire dialog ─────────────────────────────────────────────────────────── */

function initWireDialog() {
  const dlg = $('#wire-dialog');
  const kindRadios = document.querySelectorAll('input[name="wire-kind"]');
  kindRadios.forEach((r) => r.addEventListener('change', () => {
    const local = document.querySelector('input[name="wire-kind"]:checked').value === 'local';
    $('#wire-url-row').classList.toggle('hidden', local);
    $('#wire-path-row').classList.toggle('hidden', !local);
  }));

  $('#btn-wire').onclick = () => {
    $('#wire-name').value = ''; $('#wire-url').value = ''; $('#wire-path').value = '';
    $('#wire-err').classList.add('hidden');
    dlg.showModal();
  };

  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return;
    const name = $('#wire-name').value.trim();
    const local = document.querySelector('input[name="wire-kind"]:checked').value === 'local';
    const url = $('#wire-url').value.trim();
    const path = $('#wire-path').value.trim();

    if (!Registry.isValidAppName(name)) return wireError('Name may contain letters, digits, dot, dash and underscore only.');
    if (!local && !Registry.isRepoUrl(url)) return wireError('Repo URL must be https://… or git@host:owner/repo.git');
    if (local && !path) return wireError('Give the path to the local repo.');

    if (local) {
      const ex = await Neutralino.os.execCommand(Commands.dirExistsCmd(PLATFORM, path));
      if (!(ex.stdOut || '').trim().startsWith('YES')) return wireError(`No such directory: ${path}`);
      const pkg = await Neutralino.os.execCommand(
        Commands.dirExistsCmd(PLATFORM, path + (PLATFORM === 'windows' ? '\\' : '/') + 'package.json')
          .replace('-d ', '-f ').replace('if exist', 'if exist'));
      if (!(pkg.stdOut || '').trim().startsWith('YES')) {
        log(`warning: ${path} has no package.json — the standard scripts may not exist`, 'warn');
      }
    }

    const w = await currentWired();
    w[name] = local ? { path } : { url };
    await saveWired(w);
    log(`wired ${name} (${local ? 'local' : 'remote'})`, 'ok');
    await reload();
  });
}

function wireError(msg) {
  const el = $('#wire-err');
  el.textContent = msg;
  el.classList.remove('hidden');
  $('#wire-dialog').showModal();
}

/* ── boot ────────────────────────────────────────────────────────────────── */

async function reload({ refresh = false } = {}) {
  await loadRegistry({ refresh });
  await refreshInstalled();
  render();
}

async function main() {
  await detectPlatform();
  await detectHome();
  log(`platform: ${PLATFORM}`);
  if (!HOME) log('could not read your home directory — apps cannot be installed', 'err');
  log(`apps directory: ${dataRoot()}`);

  $('#btn-open-data').onclick = async () => {
    if (!requireHome()) return;
    await run(Commands.ensureRootCmd(PLATFORM, HOME), 'ensure apps dir');
    await run(Commands.openDirCmd(PLATFORM, dataRoot()), `open ${dataRoot()}`);
  };
  $('#btn-setup').onclick = doSetup;
  $('#btn-refresh').onclick = () => reload({ refresh: true });
  $('#btn-clear-log').onclick = () => { logEl().innerHTML = ''; };
  initWireDialog();

  // a passive prereq read on boot, so the dots are meaningful before setup runs
  try {
    const r = await Neutralino.os.execCommand(Commands.checkPrereqsCmd(PLATFORM));
    const p = Commands.parsePrereqs(r.stdOut);
    setPrereq('git', p.git.ok, p.git.version);
    setPrereq('node', p.node.ok, p.node.version);
    setPrereq('npm', p.npm.ok, p.npm.version);
    const ev = ElectronMod.parseVersion(
      (await Neutralino.os.execCommand(ElectronMod.versionCmd(PLATFORM))).stdOut);
    setPrereq('electron', ev.installed, ev.version);
    ELECTRON = ev;
    const ex = await Neutralino.os.execCommand(Commands.dirWritableCmd(PLATFORM, dataRoot()));
    const rootOk = (ex.stdOut || '').trim().startsWith('YES');
    setPrereq('root', rootOk, rootOk ? dataRoot() : '');
  } catch { /* dots stay neutral */ }

  await reload();
}

Neutralino.events.on('windowClose', () => Neutralino.app.exit());
main();
