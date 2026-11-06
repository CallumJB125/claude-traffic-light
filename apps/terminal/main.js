'use strict';
// Refuse debugging before loading any app code or connecting to the keeper.
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, Menu } = require('electron');
const blocked = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins', 'js-flags', 'inspect', 'inspect-brk', 'inspect-port', 'debug'];
if (blocked.some((x) => app.commandLine.hasSwitch(x)) || process.argv.some((x) => /^--(?:inspect|remote-debugging|debug)/.test(x))) { app.exit(1); } else {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execFile } = require('node:child_process');
  const manifest = require('./manifest.json');
  const { KeeperClient } = require('./keeper-client');
  const { readMetadata, readSpend, readCi, gitInfo, trackTimeline } = require('./metadata');
  const takeover = require('./takeover');
  const native = require('./native/keeper-socket/keeper-socket.node');
  let window, client, sessions = [], rows = [], active = null, channel = null, selectedEpoch = 0, attaching = null;
  let polling = null, refreshQueued = false, quitting = false, finishStartup;
  let observed = [], totals = { spendToday: null, unpricedTurns: 0, day: null };
  const history = new Map(), gitCache = new Map();
  const startup = new Promise(resolve => { finishStartup = resolve; });
  app.setName(manifest.development ? 'Plexiform Terminal Development Preview' : 'Plexiform Terminal');
  const labArg = process.argv.find((x) => x.startsWith('--lab-state-root='));
  if (manifest.development && labArg) {
    const dir = labArg.slice('--lab-state-root='.length);
    if (!path.isAbsolute(dir) || !dir.startsWith('/private/tmp/pf-terminal-lab-')) throw Error('Lab state must be in the temporary folder.');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); app.setPath('userData', dir);
  }
  const keepSpellcheckOffline = ses => { if (process.platform === 'darwin') return; ses.setSpellCheckerEnabled(false); ses.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/'); }; // privacy-flow: spellcheck-off
  app.on('session-created', keepSpellcheckOffline);
  // Files can arrive before the window or keeper exist; they wait in order.
  const pendingFiles = []; let drainFiles = null;
  app.on('open-file', (event, file) => { event.preventDefault(); pendingFiles.push(file); drainFiles?.(); });
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    const html = path.join(__dirname, 'renderer/index.html');
    const snapshot = () => ({ sessions, rows, totals, development: manifest.development, connected: Boolean(client && !client.socket.destroyed) });
    const dataDir = () => labArg ? path.join(app.getPath('userData'), 'fixture-data') : path.join(os.homedir(), '.claude-traffic-light');
    // Folder git status is cached and refreshed in the background so a slow
    // repository never delays the session list.
    function git(cwd) {
      if (!cwd) return null;
      const entry = gitCache.get(cwd), now = Date.now();
      if (!entry || (!entry.pending && now - entry.at > 15000)) {
        if (gitCache.size > 64 && !entry) gitCache.delete(gitCache.keys().next().value);
        const next = { at: now, info: entry?.info ?? null, pending: true }; gitCache.set(cwd, next);
        void gitInfo(cwd).then((info) => { next.info = info; next.at = Date.now(); next.pending = false; publish(); });
      }
      return entry?.info ?? null;
    }
    function publish() {
      const spend = readSpend(dataDir()), ci = readCi(dataDir());
      totals = { spendToday: spend.usd, unpricedTurns: spend.unpricedTurns, day: spend.day };
      const byPid = new Map(sessions.filter((s) => Number.isSafeInteger(s.pid) && s.pid > 1).map((s) => [s.pid, s.sessionId]));
      for (const row of observed) {
        const info = git(row.cwd);
        row.tabId = row.pid && byPid.has(row.pid) ? byPid.get(row.pid) : null;
        row.branch = info?.branch ?? null; row.changes = info ? { count: info.changed, files: info.files } : null;
        row.ci = row.branch && ci.get(row.branch) ? { ...ci.get(row.branch), ago_ms: Date.now() - ci.get(row.branch).at } : null;
        const usd = row.cwd ? spend.byCwd.get(row.cwd) : undefined;
        row.cost = Number.isFinite(usd) ? { usd: Math.round(usd * 100) / 100, scope: 'folder-today' } : null;
      }
      rows = observed.map((row) => ({ ...row }));
      sessions = sessions.map((s) => { const info = git(s.cwd); return { ...s, branch: info?.branch ?? null, changes: info ? { count: info.changed, files: info.files } : null }; });
      send('state', snapshot());
    }
    const send = (event, data) => { if (window && !window.isDestroyed()) window.webContents.send(`terminal:${event}`, data); };
    const notice = (s) => send('notice', String(s).slice(0, 400));
    const assertDocument = (event, focused = false) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== require('node:url').pathToFileURL(html).href) throw Error('Terminal document is not current.');
      if (focused && (!window.isFocused() || !window.isVisible())) throw Error('Focus the terminal window first.');
    };
    const handle = (name, focused, fn) => ipcMain.handle(`terminal:${name}`, async (event, value) => { assertDocument(event, focused); try { return await fn(value, event); } catch (e) { notice(e.message); return { error: e.message }; } });
    function refresh() {
      if (polling) { refreshQueued = true; return polling; }
      polling = (async () => {
        do {
          refreshQueued = false;
          try {
            // Observed agents stay visible even when the keeper is unavailable.
            if (client && !client.socket.destroyed) { try { sessions = (await client.call('list')).sessions || []; } catch (e) { notice(e.message); } } else sessions = sessions.map((s) => ({ ...s, state: s.state === 'running' ? 'unknown' : s.state }));
            const metadataDir = labArg ? path.join(app.getPath('userData'), 'fixture-metadata') : path.join(os.homedir(), '.claude-traffic-light/sessions');
            observed = readMetadata(metadataDir); trackTimeline(history, observed); publish();
            const needs = rows.filter((r) => r.bucket === 'needs').length;
            app.dock?.setBadge(needs ? String(needs) : '');
          } catch (e) { notice(e.message); }
        } while (refreshQueued);
      })().finally(() => { polling = null; });
      return polling;
    }
    async function select(id) {
      if (typeof id !== 'string' || !sessions.some((s) => s.sessionId === id)) throw Error('That terminal is no longer available.');
      const epoch = ++selectedEpoch; active = id; channel = null;
      const result = await client.call('attach', { sessionId: id, cols: 100, rows: 30 });
      if (epoch !== selectedEpoch) { await client.call('detach', { channel: result.channel }); return { error: 'Selection changed.' }; }
      channel = result.channel; return { ok: true };
    }
    function executable(kind) {
      if (kind === 'shell') return '/bin/zsh';
      if (!['claude', 'codex'].includes(kind)) throw Error('Choose a shell, Claude or Codex tab.');
      if (kind === 'codex') {
        const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
        try { fs.accessSync(bundled, fs.constants.X_OK); return fs.realpathSync(bundled); } catch { /* continue to installed CLI */ }
      }
      for (const folder of [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.npm-global/bin')]) {
        try { const file = fs.realpathSync(path.join(folder, kind)); fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next fixed location */ }
      }
      throw Error(`${kind === 'claude' ? 'Claude Code' : 'Codex CLI'} is not installed in a supported location. Install and sign in to it first.`);
    }
    let reconnecting = null;
    handle('reconnect', true, async () => {
      if (client && !client.socket.destroyed) return { ok: true };
      reconnecting ??= (async () => { client = null; active = null; channel = null; ++selectedEpoch; await connect(); })().finally(() => { reconnecting = null; });
      await reconnecting; void startDrain(); return { ok: true };
    });
    handle('ready', false, async () => { await startup; await refresh(); return snapshot(); });
    const home = () => labArg ? app.getPath('userData') : os.homedir();
    const isDir = (dir) => { try { return typeof dir === 'string' && path.isAbsolute(dir) && fs.statSync(dir).isDirectory(); } catch { return false; } };
    // New tabs start where the selected tab is (keeper tab or observed agent),
    // otherwise in the home folder. Paths never come from the renderer.
    function folderFor(from) {
      const dir = typeof from === 'string' ? (sessions.find((s) => s.sessionId === from)?.cwd ?? observed.find((r) => r.id === from)?.cwd) : null;
      return isDir(dir) ? dir : home();
    }
    async function start(kind, cwd) {
      if (!client || client.socket.destroyed) throw Error('Session Keeper is offline. Choose Reconnect first.');
      const exe = executable(kind);
      const result = await client.call('spawn', { kind, argv: kind === 'shell' ? [exe, '-l'] : [exe], cwd, env: {}, origin: { by: 'terminal', taskId: null }, cols: 100, rows: 30, reveal: true });
      await refresh(); return sessions.find((s) => s.sessionId === result.sessionId);
    }
    handle('spawn', true, async (value) => ({ session: await start(value?.kind, folderFor(value?.from)) }));
    // Take-over: open-file for a .command. The script runs in a new tab of our
    // own (never an existing or external session) once the window attaches it.
    async function openCommand(file) {
      const problem = takeover.commandFileProblem(file);
      if (problem) throw Error(problem);
      if (await takeover.quarantined(file)) throw Error('That .command file was downloaded and is quarantined; it was not run.');
      window.show(); window.focus();
      const tmp = [os.tmpdir(), fs.realpathSync(os.tmpdir())].map((d) => d.replace(/\/+$/, ''));
      if (!takeover.isPlexiformHandoff(file, tmp)) {
        const r = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', 'Run in new tab'], defaultId: 0, cancelId: 0, message: `Run “${path.basename(file)}” in a new terminal tab?`, detail: `${file}\n\nThis script can run any command as you.` });
        if (r.response !== 1) return;
      }
      const session = await start('shell', path.dirname(file));
      if (!session) throw Error('The new tab did not start.');
      send('open', { sessionId: session.sessionId });
      for (let i = 0; i < 40 && (active !== session.sessionId || !channel); i++) await new Promise((r) => setTimeout(r, 100));
      if (active !== session.sessionId || !channel) await select(session.sessionId);
      if (!client.write(channel, takeover.runLine(file))) throw Error('The script could not be started in its tab.');
    }
    function startDrain() {
      let running = false;
      drainFiles = async () => {
        if (running) return; running = true;
        try { while (pendingFiles.length) { const file = pendingFiles.shift(); try { await openCommand(file); } catch (e) { notice(e.message); } } } finally { running = false; }
      };
      return drainFiles();
    }
    handle('select', false, async (id) => {
      // Serialize attaches; the keeper has exactly one data owner per tab.
      if (attaching) await attaching.catch(() => {});
      const work = select(id); attaching = work; try { return await work; } finally { if (attaching === work) attaching = null; }
    });
    handle('write', true, async (value) => {
      if (value?.sessionId !== active || !channel || typeof value.data !== 'string' || Buffer.byteLength(value.data) > 60000) throw Error('Only the focused terminal can receive input.');
      const id = active, ch = channel, epoch = selectedEpoch;
      // Ordinary Enter/Ctrl-C/escape keys stay immediate. A paste containing
      // multiple lines or control sequences is reviewed before being delivered.
      if (value.data.length > 2 && /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value.data) && !/^\x1b\[[0-9;]*[~A-Za-z]$/.test(value.data)) {
        const r = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', 'Paste into this terminal'], defaultId: 0, cancelId: 0, message: 'Paste this into the selected terminal?', detail: 'It contains multiple lines or control characters and could run commands. Review the clipboard before continuing.' });
        if (r.response !== 1) return { cancelled: true };
        if (id !== active || ch !== channel || epoch !== selectedEpoch || !window.isFocused()) throw Error('Terminal selection changed; paste was cancelled.');
      }
      return { ok: client.write(ch, value.data) };
    });
    handle('resize', false, async (v) => {
      if (v?.sessionId !== active || !channel || !Number.isInteger(v.cols) || !Number.isInteger(v.rows) || v.cols < 1 || v.cols > 400 || v.rows < 1 || v.rows > 200) return { error: 'Invalid terminal size.' };
      return client.call('resize', { channel, cols: v.cols, rows: v.rows });
    });
    handle('detach', false, async (v) => { if (v?.sessionId === active && channel) { await client.call('detach', { channel }); channel = null; active = null; ++selectedEpoch; } return { ok: true }; });
    handle('stop', true, async (v) => {
      if (v?.sessionId !== active || !sessions.some((s) => s.sessionId === v.sessionId)) throw Error('Select the terminal you want to end.');
      const target = sessions.find(s => s.sessionId === v.sessionId), epoch = selectedEpoch;
      const r = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Keep running', 'End this terminal'], defaultId: 0, cancelId: 0, message: 'End this terminal session?', detail: `${target.kind} in ${target.cwd} will receive a hang-up signal. Closing the window normally keeps terminals running.` });
      if (r.response !== 1 || !window.isFocused() || active !== target.sessionId || selectedEpoch !== epoch) return { cancelled: true };
      await client.call('signal', { sessionId: v.sessionId, signal: 'HUP' }); await refresh(); return { ok: true };
    });
    async function connect() {
      const socketDir = path.join(os.tmpdir(), `pf-terminal-${manifest.development ? 'dev' : 'signed'}-${process.getuid()}`);
      fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      const st = fs.lstatSync(socketDir); if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw Error('Keeper socket folder is not private.');
      // Lab tests get a dedicated socket and never see user terminals.
      const socketPath = path.join(socketDir, labArg ? `lab-${require('node:crypto').createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 10)}.sock` : 'k1-b1.sock');
      const connect = () => KeeperClient.connect({ socketPath, native, development: manifest.development, team: manifest.team, minimum: 1 });
      try { client = await connect(); } catch (e) {
        if (e.code !== 'KEEPER_DOWN') throw e;
        const embedded = path.join(process.resourcesPath, 'keeper/Plexiform Session Keeper.app');
        const target = path.join(app.getPath('userData'), 'Keeper/1/Plexiform Session Keeper.app');
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(target)) fs.cpSync(embedded, target, { recursive: true, errorOnExist: true, force: false });
        // Signature is checked by the audit-token addon before any data/control
        // is sent. No remote command or environment enters this launch.
        await new Promise((resolve, reject) => execFile('/usr/bin/open', ['-g', '-j', target, '--args', '--socket', socketPath, ...(labArg ? ['--test-home', app.getPath('userData')] : [])], { timeout: 10000 }, (e) => e ? reject(e) : resolve())); // privacy-flow: terminal-keeper-local
        for (let tries = 0; tries < 30; tries++) {
          await new Promise((r) => setTimeout(r, 100));
          try { client = await connect(); break; } catch (err) { if (err.code !== 'KEEPER_DOWN') throw err; }
        }
        if (!client) throw Error('Session Keeper did not start. Existing sessions were left alone.');
      }
      client.on('reply', (e) => { if (e.op === 'attach' && e.fields.sessionId === active) channel = e.result.channel; });
      client.on('data', (e) => {
        if (e.channel === channel && active) send('data', { sessionId: active, data: e.data.toString('base64') });
      });
      client.on('event', (e) => { if (e.ev === 'session.added' || e.ev === 'session.exited') refresh(); });
      const current = client; client.on('notice', notice); client.on('closed', () => { if (client !== current) return; channel = null; send('state', snapshot()); notice('Session Keeper disconnected. Choose Reconnect in the sidebar; tabs were not retried.'); });
      await refresh();
    }
    app.on('second-instance', () => { window?.show(); window?.focus(); });
    app.on('before-quit', () => { quitting = true; client?.close(); });
    app.on('window-all-closed', () => app.quit());
    app.whenReady().then(async () => {
      // No View menu: ⌘0–9, ⌘J, ⌘P and ⌘T belong to the window, and reload/zoom are not offered.
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
      window = new BrowserWindow({ width: 1360, height: 860, minWidth: 820, minHeight: 540, show: false, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, title: manifest.development ? 'Plexiform Terminal · Development Preview' : 'Plexiform Terminal', backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0f12' : '#f7f7f8', webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, webSecurity: true, devTools: false } });
      keepSpellcheckOffline(window.webContents.session);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (e) => e.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      // Requests stay inside packaged local assets; telemetry never leaves this Mac.
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('devtools://') }));
      window.webContents.on('render-process-gone', () => { active = null; channel = null; ++selectedEpoch; client?.close(); });
      await window.loadFile(html); window.show();
      try { await connect(); } catch (e) { finishStartup(); notice(e.message); send('state', snapshot()); await dialog.showMessageBox(window, { type: 'error', message: 'Plexiform Terminal could not connect', detail: e.message }); } finally { finishStartup(); }
      const timer = setInterval(refresh, 3000); timer.unref();
      // Like any terminal: with no tabs and nothing handed over, open a shell at home.
      if (!labArg && client && !pendingFiles.length && !sessions.length) { try { await start('shell', home()); } catch (e) { notice(e.message); } }
      if (client) void startDrain();
      // Fixed disposable packaged acceptance. Available only in a dev artifact
      // with an isolated clean HOME/socket; no arbitrary commands or paths.
      if (manifest.development && labArg && process.argv.includes('--lab-smoke')) {
        let fixtureId;
        try {
          if (!client) throw Error('Packaged smoke has no authenticated keeper.');
          let output = '';
          const collect = e => { output = (output + e.data.toString('utf8')).slice(-65536); };
          client.on('data', collect);
          const created = await client.call('spawn', { kind: 'shell', argv: ['/bin/sh', '-l'], cwd: app.getPath('userData'), env: {}, origin: { by: 'terminal', taskId: null }, cols: 100, rows: 30, reveal: true });
          fixtureId = created.sessionId; await refresh();
          for (let i = 0; i < 40 && (!active || !channel); i++) await new Promise(r => setTimeout(r, 100));
          if (active !== fixtureId || !channel) throw Error('Renderer did not attach the disposable tab.');
          window.focus();
          const command = "printf '\\nPF_PACKAGED_RECEIPT\\n'\r";
          for (const character of command) {
            const result = await window.webContents.executeJavaScript(`window.terminal.write(${JSON.stringify({ sessionId: fixtureId, data: character })})`);
            if (result?.error || !result?.ok) throw Error(result?.error || 'Renderer input was refused.');
          }
          for (let i = 0; i < 50 && !output.includes('\r\nPF_PACKAGED_RECEIPT\r\n'); i++) await new Promise(r => setTimeout(r, 100));
          if (!output.includes('\r\nPF_PACKAGED_RECEIPT\r\n')) throw Error('Exact shell receipt was not observed.');
          await refresh();
          await new Promise(r => setTimeout(r, 300));
          const visible = await window.webContents.executeJavaScript("Boolean(document.querySelector('.xterm-screen')) && !document.getElementById('terminal').hidden && !document.getElementById('terminal-view').hidden && document.querySelectorAll('[data-tab-id]').length === 1");
          if (!visible) throw Error('Terminal renderer is absent.');
          const screenshot = await window.webContents.capturePage();
          fs.writeFileSync(path.join(app.getPath('userData'), 'packaged-smoke.png'), screenshot.toPNG(), { mode: 0o600 });
          fs.writeFileSync(path.join(app.getPath('userData'), 'packaged-smoke.json'), JSON.stringify({ packaged: app.isPackaged, development: true, nativeAuditTokenConnection: true, realPTY: true, rendererInputBridge: true, exactReceipt: true, terminalVisible: visible, liveUserSessionsTouched: false }, null, 2), { mode: 0o600 });
          client.off('data', collect);
        } catch (e) {
          fs.writeFileSync(path.join(app.getPath('userData'), 'packaged-smoke.json'), JSON.stringify({ ok: false, error: e.message }), { mode: 0o600 });
        } finally {
          if (fixtureId) { try { await client.call('signal', { sessionId: fixtureId, signal: 'HUP' }); } catch {} }
          await new Promise(r => setTimeout(r, 350));
          try { await client?.call('shutdown'); } catch {}
          app.quit();
        }
      }
    });
  }
}
