# Merging feat/update-ui with feat/installers

Both branches touch the updater wiring in `main.js`. feat/installers owns the
service (`src/updater/`); feat/update-ui owns everything the person sees.

## main.js recipe

Take feat/update-ui's version of these, drop feat/installers' version:

1. **The require.** feat/installers has `const Updater = require('./src/updater/index.js');`
   near line 311. Delete it. feat/update-ui declares `let Updater` near the top
   (inside a try that only tolerates a missing `src/updater/index.js`). Two
   declarations of `Updater` is a SyntaxError.
2. **The start.** feat/installers calls, unconditionally in `whenReady`,
   `Updater.start({ app, ipcMain, net, dev: IS_DEV_RUN, isBusy: ... })` and
   `Updater.markLaunched({ app })`. Delete both lines. feat/update-ui makes the
   same two calls once, inside `else if (Updater) { ... }`, and keeps the
   returned service in `updaterService` for the tray. Calling `start()` twice
   registers every `updater:*` handler twice and Electron throws.
3. Keep feat/update-ui's order: dev stub (only `IS_DEV_RUN` with
   `CLAUDE_BUDDY_UPDATER_STUB`), then the real service, then the "not set up"
   fallback.

## Once the service always exists

The service is then always present, so:

- `let Updater = null; try { ... } catch ...` becomes `const Updater = require('./src/updater/index.js');`
- the `else { ipcMain.handle('updater:get-state', () => null); }` fallback goes,
  and so does the "not set up" copy path (`present: false` in `update-view.js`)
  if nobody wants it any more.
- the dev stub can stay (it is excluded from the package by `!src/update-stub.js`).

## Health panel

`Updater.healthStatus()` already exists in `src/updater/index.js`; nothing in
feat/update-ui reads it. Wire it wherever the health panel builds its rows.

## Contract notes

- The page (`updates.html`) uses the full command set including
  `install({ when: 'now', force: true })`. The widget (`index.html`) gets only
  `updater:get-state` and `updater:install({ when: 'idle' | 'now' })`, never
  forced; its preload cannot send anything else. `src/update-stub.js` enforces
  that with `allowed()`; the real service's sender allowlist must match.
- `test/fixtures/updater-states.json` is byte-identical to feat/installers' (commit 39c0bda); keep it that way.
