# hexstack-app-runner

A small [Neutralino](https://neutralino.js.org/) desktop app that installs,
updates and **runs Hexstack apps from source** — using one globally installed
Electron, so nothing has to be built per app.

```
┌─ Hexstack App Runner ─────────────── [📂 Open Hexstack Apps data] ─┐
│ 0 · SETUP    ● git  ● node  ● npm  ● electron  ● apps dir          │
│ 1 · APPS     ai-mentat-roblox-studio  [Update][Open][Uninstall]    │
│                                       [▶ Run][Install deps][setup] │
│ OUTPUT       live command log                                      │
└────────────────────────────────────────────────────────────────────┘
```

## What it does

**0 · Setup** — checks and prepares `git`, `node` and `npm`, creates the apps
directory, and installs **one global Electron** (`npm i -g electron`) that every
app is launched with.

**1 · Apps** — lists apps from a shipped catalogue plus anything you wire
yourself:

| action | applies to | effect |
|---|---|---|
| **Install** | remote, not cloned | `git clone --recurse-submodules` into the apps dir |
| **Update** | remote, cloned | `git pull --ff-only` + `git submodule update` |
| **Uninstall** | remote | deletes the **clone only** — the app's data dir is kept |
| **Unwire** | local | removes it from the list; **nothing on disk is deleted** |
| **▶ Run** | installed | launches the source with the global Electron |
| **Install deps** | installed | `npm install` (Electron stays global) |
| **setup** | installed | the app's own `npm run setup`, for non-npm assets |

**📂 Open Hexstack Apps data** (top right) opens `/.hexstack-app/` in the system
file manager.

## Running apps from source, not from a build

`▶ Run` never builds and never launches a packaged executable. It:

1. verifies a global Electron exists,
2. compares the app's declared Electron range against the installed major and
   **warns on a mismatch** instead of silently launching (the ai-mentat apps are
   not all on the same major — three declare `^44`, one declares `^30`),
3. installs `node_modules` if missing,
4. launches the app's **source entry**.

Step 4 matters: several apps declare `"main": "electron-main.bundle.js"`, a
build artifact that is gitignored and therefore absent right after cloning.
The runner detects that and points Electron at `electron-main.js` instead, so
the code that runs is the code in the checkout.

## Layout on disk

```
/.hexstack-app/
├── wired.json                 apps you added yourself
└── <app-name>/
    ├── repo/                  the git checkout (Install/Update/Uninstall)
    └── data/                  the app's own data (never touched by uninstall)
```

`repo/` and `data/` are siblings on purpose — removing an app must not remove
its data.

## Wiring your own repo

“＋ Wire a repo” accepts either a **remote** URL (cloned like a catalogue app)
or a **local** path (used in place, never copied or deleted). The repo should
expose the standard scripts — `setup`, `run`, `build`, `check` — in its
`package.json`.

Entries are stored in `/.hexstack-app/wired.json`:

```json
{
  "my-remote-app": { "url": "https://github.com/me/my-app.git" },
  "my-local-app":  { "path": "/home/me/dev/my-app" }
}
```

A wired entry **overrides** a catalogue entry with the same name, so you can
point a shipped name at your own fork without editing the app.

## The published app list

**Nothing is bundled with the app.** The catalogue is
[`base-apps-list.json`](base-apps-list.json) at this repo's root, fetched from
GitHub raw when you press **⟳ Refresh list**:

```
https://raw.githubusercontent.com/hexstack-apps/hexstack-app-runner/main/base-apps-list.json
```

| when | what happens |
|---|---|
| **⟳ Refresh list** | fetch the published file, then write it to `localStorage` |
| startup | read the `localStorage` copy — no network call, so the window paints at once |
| fetch fails | serve the cached copy and log why |
| no cache yet | empty list that says *press Refresh*, never a silent blank |

A fetch that yields **0 usable apps refuses to overwrite a good cache**, so a
bad publish cannot wipe a working list. Cache key: `hexstack.appCatalog.v1`.

Shipping a copy inside the build was deliberately dropped: it goes stale the
moment the published list changes, and creates two sources of truth.

```json
{
  "version": 1,
  "apps": [
    { "name": "ai-mentat-interviews",
      "url": "https://github.com/hexstack-apps/ai-mentat-interviews.git",
      "description": "…", "electron": 30 }
  ]
}
```

`description`, `homepage`, `branch` and `electron` are optional. `electron` is
the major the app expects, letting the runner warn about a mismatch before
cloning. Two older shapes are still accepted: a bare `[{name, url}]` array and a
flat `{"app-name": "repo url"}` map.

## Development

```sh
npm run setup     # deps + neutralino binaries + global electron
npm run run       # dev
npm run build     # neu build --release
npm run check     # build, then start the built binary
npm test          # 35 assertions
```

`src/` is CommonJS so `node --test` runs it with no toolchain;
`scripts/sync-resources.js` wraps those files into browser globals in
`resources/js/`. `npm test` fails if the copies drift out of sync.

### Tests

All shell commands are built as strings by `src/commands.js` and
`src/electron.js`, which makes them assertable without executing anything.
The injection tests assert what the **shell** does — a payload must stay a
single argument — and include a control that runs the same payload *unescaped*
to prove the test can fail. An earlier version string-matched the command text
and reported a failure while the code was correct; the shell is the only
authority worth asserting against.

## License

MIT
