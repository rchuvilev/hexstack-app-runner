/* AUTO-GENERATED from src/commands.js by scripts/sync-resources.js — do not edit. */
(function (root, factory) {
  var m = { exports: {} };
  function localRequire(id) {
    var map = {"./registry":"Registry","./commands":"Commands","./electron":"Electron","./catalog":"Catalog"};
    var g = map[id];
    if (g && root[g]) return root[g];
    throw new Error('sync-resources: unmapped require(' + id + ') in commands.js');
  }
  factory(m, m.exports, localRequire);
  if (typeof module === 'object' && module.exports) module.exports = m.exports;
  else root["Commands"] = m.exports;
})(typeof self !== 'undefined' ? self : this, function (module, exports, require) {
/**
 * Command builders.
 *
 * Every shell command the runner executes is produced here as a STRING, with
 * no side effects, so the exact command line can be asserted in tests. The UI
 * layer is the only thing that hands these to Neutralino.os.execCommand.
 *
 * Quoting: user-controlled values (paths, urls, names) are always wrapped by
 * `q()`. A repo url or app name reaches a shell here, so this is a trust
 * boundary, not a formatting detail.
 */
'use strict';

const ROOT_DIR_NAME = '.hexstack-app';

/** POSIX single-quote escaping: close, escape, reopen. */
function q(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

/** Windows needs double quotes; no single-quote semantics in cmd.exe. */
function qWin(s) {
  return `"` + String(s).replace(/"/g, '""') + `"`;
}

/**
 * Root of all app data/checkouts: `<home>/.hexstack-app`.
 *
 * Home-relative, never `/.hexstack-app`: the filesystem root needs elevation
 * everywhere and is READ-ONLY on macOS, so a root-level path made setup
 * impossible to finish — `mkdir -p /.hexstack-app` failed with
 * "Read-only file system" and every install after it.
 *
 * `home` is a parameter, not read from the environment, so these stay pure
 * string builders (the whole point of this module). It is required: with no
 * home there is no safe path to build, and `uninstallCmd` ends in `rm -rf`.
 */
function rootDir(platform, home) {
  if (typeof home !== 'string' || !home) {
    throw new Error(`rootDir: home directory is required, got ${JSON.stringify(home)}`);
  }
  const sep = platform === 'windows' ? '\\' : '/';
  return `${home}${sep}${ROOT_DIR_NAME}`;
}

/**
 * Reject an app name that could escape the apps directory.
 *
 * The registry already validates names before they reach the UI, but these
 * builders are exported: `uninstallCmd()` ends in `rm -rf`, so a caller that
 * skipped validation could otherwise produce
 * `rm -rf '<home>/.hexstack-app/../../etc/repo'`. Defence in depth — the function
 * that builds the destructive path enforces its own precondition rather than
 * trusting every future caller.
 */
function assertSafeAppName(appName) {
  if (typeof appName !== 'string' || !appName ||
      appName === '.' || appName === '..' ||
      appName.includes('/') || appName.includes('\\') ||
      appName.includes('..') || appName.includes('\0')) {
    throw new Error(`unsafe app name: ${JSON.stringify(appName)}`);
  }
  return appName;
}

/** Where a remote app is cloned: <root>/<app-name>/repo */
function appRepoDir(platform, appName, home) {
  assertSafeAppName(appName);
  const sep = platform === 'windows' ? '\\' : '/';
  return `${rootDir(platform, home)}${sep}${appName}${sep}repo`;
}

/** Where an app keeps its data: <root>/<app-name>/data  (same contract the apps use) */
function appDataDir(platform, appName, home) {
  assertSafeAppName(appName);
  const sep = platform === 'windows' ? '\\' : '/';
  return `${rootDir(platform, home)}${sep}${appName}${sep}data`;
}

/* ── 0) setup ────────────────────────────────────────────────────────────── */

/**
 * Report which prerequisites are present. One command, one line per tool, so
 * a single execCommand round-trip answers the whole question.
 */
function checkPrereqsCmd(platform) {
  if (platform === 'windows') {
    return 'for %I in (git node npm) do @(where %I >nul 2>&1 && echo %I=OK || echo %I=MISSING)';
  }
  return "for t in git node npm; do " +
         "if command -v $t >/dev/null 2>&1; then echo \"$t=OK $($t --version 2>&1 | head -1)\"; " +
         "else echo \"$t=MISSING\"; fi; done";
}

/** Parse the output of checkPrereqsCmd into {git:{ok,version}, ...}. */
function parsePrereqs(stdout) {
  const out = { git: { ok: false, version: '' }, node: { ok: false, version: '' }, npm: { ok: false, version: '' } };
  for (const line of String(stdout || '').split('\n')) {
    const m = line.trim().match(/^(git|node|npm)=(OK|MISSING)\s*(.*)$/);
    if (m) out[m[1]] = { ok: m[2] === 'OK', version: (m[3] || '').trim() };
  }
  return out;
}

/** Create the root directory. Inside $HOME, so no elevation is involved. */
function ensureRootCmd(platform, home) {
  const root = rootDir(platform, home);
  if (platform === 'windows') return `if not exist ${qWin(root)} mkdir ${qWin(root)}`;
  return `mkdir -p ${q(root)}`;
}

/**
 * What a user can run when the apps root is missing or not writable.
 *
 * Both lines, because there are two distinct failures and the UI cannot always
 * tell them apart: the directory is absent (plain `mkdir`, no elevation — it
 * is inside $HOME), or it exists ROOT-OWNED because an earlier version told
 * people to `sudo mkdir` a root-level path. In the second case `mkdir -p`
 * succeeds, the directory "exists", and every clone still fails with
 * permission denied — `chown` is the only fix, and it is the one command here
 * that genuinely needs sudo.
 */
function createHint(platform, home) {
  const root = rootDir(platform, home);
  if (platform === 'windows') return `mkdir ${qWin(root)}`;
  return `mkdir -p ${q(root)}\n  sudo chown -R "$(whoami)" ${q(root)}   # if it exists but is root-owned`;
}

/* ── 1) install / update / uninstall ─────────────────────────────────────── */

function installCmd(platform, appName, url, home) {
  const dir = appRepoDir(platform, appName, home);
  const Q = platform === 'windows' ? qWin : q;
  return `git clone --recurse-submodules ${Q(url)} ${Q(dir)}`;
}

/**
 * Update an existing checkout. Submodules are updated too, because every
 * ai-mentat app pins the SDK as one — a plain `git pull` leaves them stale.
 */
function updateCmd(platform, appName, home) {
  const dir = appRepoDir(platform, appName, home);
  const Q = platform === 'windows' ? qWin : q;
  if (platform === 'windows') {
    return `cd /d ${Q(dir)} && git pull --ff-only && git submodule update --init --recursive`;
  }
  return `cd ${Q(dir)} && git pull --ff-only && git submodule update --init --recursive`;
}

/** Remove a cloned app. Only ever targets <root>/<app>/repo. */
function uninstallCmd(platform, appName, home) {
  const dir = appRepoDir(platform, appName, home);
  if (platform === 'windows') return `rmdir /s /q ${qWin(dir)}`;
  return `rm -rf ${q(dir)}`;
}

/* ── package.json scripts the apps are required to expose ────────────────── */

function runScriptCmd(platform, dir, script) {
  const Q = platform === 'windows' ? qWin : q;
  const cd = platform === 'windows' ? `cd /d ${Q(dir)}` : `cd ${Q(dir)}`;
  return `${cd} && npm run ${script}`;
}

/** Open a directory in the system file manager. */
function openDirCmd(platform, dir) {
  if (platform === 'windows') return `explorer ${qWin(dir)}`;
  if (platform === 'darwin')  return `open ${q(dir)}`;
  return `xdg-open ${q(dir)} >/dev/null 2>&1 &`;
}

/** Does a directory exist? Echoes YES/NO so one call answers it. */
function dirExistsCmd(platform, dir) {
  if (platform === 'windows') return `if exist ${qWin(dir)} (echo YES) else (echo NO)`;
  return `[ -d ${q(dir)} ] && echo YES || echo NO`;
}

/**
 * Is a directory present AND writable by this user? Echoes YES/NO.
 *
 * Existence alone is not enough for the apps root: a root-owned
 * `~/.hexstack-app` (left by a `sudo mkdir` from an earlier version) exists,
 * so an existence check turns setup green and the first `git clone` then dies
 * with permission denied. Used for the root only — for an app checkout,
 * "is it there" really is the question, so `dirExistsCmd` stays as it is.
 */
function dirWritableCmd(platform, dir) {
  if (platform === 'windows') {
    // cmd.exe has no -w test, so probe with a temp file and clean it up.
    const probe = `${dir}\\.hexstack-write-probe`;
    return `if exist ${qWin(dir)} (` +
           `(echo.> ${qWin(probe)}) 2>nul && (del ${qWin(probe)} >nul 2>&1) && echo YES || echo NO` +
           `) else (echo NO)`;
  }
  return `[ -d ${q(dir)} ] && [ -w ${q(dir)} ] && echo YES || echo NO`;
}

module.exports = {
  ROOT_DIR_NAME, q, qWin, assertSafeAppName,
  rootDir, appRepoDir, appDataDir,
  checkPrereqsCmd, parsePrereqs, ensureRootCmd, createHint,
  installCmd, updateCmd, uninstallCmd,
  runScriptCmd, openDirCmd, dirExistsCmd, dirWritableCmd,
};

});
