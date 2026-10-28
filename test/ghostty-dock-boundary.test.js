'use strict';
// plan-ghostty-dock §5.1: Plexiform may only ask Ghostty Dock to focus, list,
// notify or open. It must never type into a terminal, press keys in it, read
// its screen or wait on it, and no bus envelope, MCP tool, run, hub message or
// signal-server route may reach the Dock module at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DOCK_MODULES = ['src/ghostty-dock.js', 'src/focus/ghostty-dock.js', 'src/ghostty-dock-install.js'];
const FORBIDDEN_OPS = ['send', 'keys', 'read', 'wait'];
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('the Dock modules hold no forbidden op as a string literal', () => {
  for (const f of DOCK_MODULES) {
    const src = code(read(f));
    for (const op of FORBIDDEN_OPS) {
      assert.doesNotMatch(src, new RegExp(`['"\`]${op}['"\`]`), `${f} names the ${op} op`);
    }
  }
  assert.match(read('src/ghostty-dock.js'), /const OPS = Object\.freeze\(\['focus', 'list', 'notify', 'open'\]\);/);
});

test('every call into the Dock module anywhere in the app names an allowed op', () => {
  const allowed = new Set(['focus', 'list', 'notify', 'open']);
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'test', 'test-visual', 'dist', 'out', 'site'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(c|m)?js$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  let seen = 0;
  for (const f of files) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\b(?:GhosttyDock\.)?run\(\s*(['"`])([^'"`]*)\1\s*,\s*\[/g)) {
      if (!/ghostty-dock|GhosttyDock/.test(src)) continue;
      seen += 1;
      assert.ok(allowed.has(m[2]), `${path.relative(ROOT, f)} calls Ghostty Dock op "${m[2]}"`);
    }
    // No other way to reach the CLI: its path is only built in src/ghostty-dock.js.
    // The run sandboxes name it only to deny writes to it.
    if (!['src/ghostty-dock.js', 'board/runner/launch.js', 'board/runner/backends/codex.js'].includes(path.relative(ROOT, f))) assert.doesNotMatch(src, /\.local['"`/,\s]+['"`]?bin['"`/,\s]+['"`]?ghostty-dock/, path.relative(ROOT, f));
  }
  assert.ok(seen >= 2, 'the focus adapter and the task launcher both call run');
});

// Relative requires/imports of a file, resolved.
function deps(file) {
  const src = code(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const m of src.matchAll(/(?:require\(\s*|from\s+|import\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), m[1]);
    const hit = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (hit) out.push(hit);
  }
  return out;
}
function reaches(entry, targets) {
  const seen = new Set();
  const stack = [path.join(ROOT, entry)];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (targets.has(f)) return path.relative(ROOT, f);
    stack.push(...deps(f));
  }
  return null;
}

test('no bus, MCP, board, run or signal-server code can load the Dock module, directly or through another file', () => {
  const targets = new Set(DOCK_MODULES.map((f) => path.join(ROOT, f)));
  const entries = ['mcp-server.js', 'src/signal-server.js', 'src/agent-bus-main.js'];
  // Agent mail, the team hub, phone/remote devices and handoffs: plan §5.1.
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) if (/^(agent-mail|remote-|team-|teammate-|handoff|interaction-)[\w-]*\.js$/.test(f)) entries.push(path.join('src', f));
  assert.ok(entries.includes(path.join('src', 'agent-mail.js')) && entries.includes(path.join('src', 'remote-devices.js')) && entries.includes(path.join('src', 'team-hub-live.js')));
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel); else if (/\.(c|m)?js$/.test(e.name)) entries.push(rel);
    }
  };
  walk('board');
  assert.ok(entries.some((e) => e.startsWith(path.join('board', 'mcp'))), 'board/mcp is covered');
  for (const e of entries) assert.equal(reaches(e, targets), null, `${e} reaches the Ghostty Dock module`);
});

test('the Health checks take the Dock row as data and never load the module (mcp-server uses them)', () => {
  assert.doesNotMatch(code(read('src/health.js')), /require\([^)]*ghostty-dock/);
});

test('a bare side-effect import is followed too', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'px-dock-imp-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.mjs'), "import './b.mjs';\n");
    fs.writeFileSync(path.join(dir, 'b.mjs'), '');
    assert.deepEqual(deps(path.join(dir, 'a.mjs')), [path.join(dir, 'b.mjs')]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// main.js hands the functions that reach Ghostty Dock (jumpToSession,
// launchTerminal) to other modules as values, which an import walk can't see.
// So every call site is pinned to the handler it sits in; a new route to them
// fails here until someone checks it is a person's click.
const HEADER = /^\s*(?:ipcMain\.(?:handle|on)\(\s*'[^']+'|utilityHandle\(\s*'[^']+'|(?:async\s+)?function\s+\w+\(|\w+\.on\('click'|require\('\.\/src\/[\w-]+\.js'\)\.wire\()/;
function callSites(file, needle) {
  const lines = read(file).split('\n');
  const out = [];
  lines.forEach((l, i) => {
    if (!l.includes(needle) || /^\s*\/\//.test(l) || /^\s*TERMINAL_APPS, /.test(l)) return;
    let j = i;
    while (j >= 0 && !HEADER.test(lines[j])) j -= 1;
    out.push(j < 0 ? '(top level)' : lines[j].match(HEADER)[0].trim());
  });
  return out.sort();
}

test('jumpToSession is only called from click, hotkey and page handlers in main.js', () => {
  assert.deepEqual(callSites('main.js', 'jumpToSession'), [
    'async function jumpToNeeding(', // the "go to the session that needs you" hotkey and tray item
    'async function openAwayItem(', // ipcMain 'away-open': a click in the away recap
    'async function runAction(', // a click action the user programmed in Lights
    "ipcMain.handle('go-to-needing-session'", // the widget's own click
    "ipcMain.handle('open-input'", // Open session in the Waiting list / inbox
    "note.on('click'", // a notification click
    "require('./src/home-alerts.js').wire(", // Home's Open session button (IPC from the Home page)
    'async function threadGoToTerminal(', // the thread page's Go to it (thread:go-to-terminal; gate on, foreground, bound session only)
    'async function openSessionTerminal(', // QoL2: a widget card's Open (widget:session-open, widget sender only, your own row re-found by id)
  ].sort());
});

test('launchTerminal is only wired in main.js getTasks and only called after the native confirmation', () => {
  assert.deepEqual(callSites('main.js', 'launchTerminal'), ['function getTasks(']);
  const svc = read('src/tasks-service.js');
  assert.equal((svc.match(/opts\.launchTerminal\(/g) || []).length, 1);
  const fn = svc.slice(svc.indexOf('async function openTerminal('));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.ok(body.indexOf('opts.confirmDialog') >= 0 && body.indexOf('opts.confirmDialog') < body.indexOf('opts.launchTerminal('), 'confirmation first');
  assert.match(body, /if \(yes !== true\) return/);
  for (const f of ['src/signal-server.js', 'mcp-server.js', 'src/agent-bus-main.js', 'src/agent-mail.js']) {
    assert.doesNotMatch(read(f), /jumpToSession|launchTerminal|openTerminal\(/, f);
  }
});

// The guided install (src/ghostty-dock-install.js): the command is one fixed
// literal that nothing passed in can change, and only Settings or Home reach it.
test('the installer command is a fixed literal, used only by the one-use script, never built from input', () => {
  const src = code(read('src/ghostty-dock-install.js'));
  assert.match(src, /const INSTALL_COMMAND = 'curl -fsSL https:\/\/raw\.githubusercontent\.com\/andrewbakercloudscale\/ghossty-dock\/main\/get\.sh \| bash';/);
  assert.match(src, /const REPO_URL = 'https:\/\/github\.com\/andrewbakercloudscale\/ghossty-dock';/);
  assert.doesNotMatch(src, /process\.env|process\.argv|loadConfig|ipcRenderer/);
  assert.doesNotMatch(src, /INSTALL_COMMAND\s*=(?!=)[^;]*\n[\s\S]*INSTALL_COMMAND\s*=(?!=)/, 'assigned once');
  assert.match(src, /function scriptBody\(file, dir\)/, 'the script takes only its own path and folder');
  // Plexiform never runs the installer itself: its only process is `open -a Terminal <file>`.
  const procs = [...src.matchAll(/execFile\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(procs.length, 1);
  assert.match(procs[0], /^'\/usr\/bin\/open', \['-a', 'Terminal', file\]/);
  assert.doesNotMatch(src, /\b(?:spawn|exec|execSync|fork)\(|fetch\(|net\.request|https?\.get/);
  for (const f of ['main.js', 'settings.js', 'settings-preload.js', 'home.js']) assert.doesNotMatch(read(f), /get\.sh/, `${f} names the installer`);
});

test('the install handler is Settings- or Home-only and takes an action name; Health routes fixed ids to it', () => {
  const main = read('main.js');
  assert.match(main, /GhosttyDockInstall\.register\(\{ utilityHandle, allowed: \(e\) => settingsPane\('terminal'\)\(e\) \|\| fromUtilityPage\(e, 'home'\), controller: ghosttyDockInstaller \}\);/);
  assert.equal((main.match(/ghosttyDockInstaller\.act\(/g) || []).length, 1);
  assert.match(main, /ghosttyDockInstaller\.act\(id === 'ghostty-dock-install' \? 'install' : 'recheck'\)/);
  assert.equal((main.match(/'ghostty-dock-install'/g) || []).length, 3, 'the health-fix route (twice) and the Health row fix id, nothing else');
  assert.match(read('settings-preload.js'), /ipcRenderer\.invoke\('ghostty-dock-install', \['status', 'install', 'recheck', 'github'\]\.includes\(action\) \? action : 'status'\)/);
});

test('Dock list output is asked for only on a click, and only ids and status words come out of it', () => {
  assert.deepEqual(callSites('main.js', 'dockStatusFor(').filter((h) => h !== 'async function dockStatusFor('), [
    'async function jumpToNeeding(',
    'async function runAction(',
    "ipcMain.handle('go-to-needing-session'",
  ].sort());
  assert.deepEqual(callSites('main.js', 'GhosttyDock.listStatus('), ['async function dockStatusFor(']);
  const term = code(read('src/terminal.js'));
  assert.equal((term.match(/listStatus\(/g) || []).length, 1, 'adoptIntoDock only');
  const dock = code(read('src/ghostty-dock.js'));
  const parse = dock.slice(dock.indexOf('function parseListJson('), dock.indexOf('let listMemo'));
  assert.match(parse, /const \{ status, session_id: id \} = row;/, 'only status and session_id are read');
  assert.match(dock, /if \(op === 'list'\) return args\.length === 1 && args\[0\] === '--json' \? \['--json'\] : null;/, 'list takes exactly --json');
  assert.match(dock, /run\('list', \['--json'\]/);
  assert.doesNotMatch(parse, /console\.|log\(/, 'nothing from the list is logged');
  for (const f of ['src/signal-server.js', 'mcp-server.js', 'src/agent-bus-main.js', 'src/agent-mail.js']) assert.doesNotMatch(read(f), /listStatus|parseListJson|adoptIntoDock/, f);
});
