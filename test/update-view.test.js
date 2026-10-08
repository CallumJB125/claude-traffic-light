const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/update-view.js');
const Brand = require('../brand.js');
const Stub = require('../src/update-stub.js');
const states = require('./fixtures/updater-states.json').states;
const LATER = "when you're not working with Claude";

const NAME = Brand.name;
const NOW = Date.parse('2026-10-01T10:00:00.000Z');
const ids = (vm) => vm.buttons.map((b) => b.id);
const labels = (vm) => vm.buttons.map((b) => b.label);
const view = (k) => V.view(states[k], { now: NOW });

test('the fixture covers every status and error code', () => {
  const all = Object.values(states);
  for (const st of ['idle', 'checking', 'available', 'downloading', 'ready', 'installing', 'error']) assert.ok(all.some((s) => s.status === st), st);
  for (const code of Object.keys(V.ERRORS)) assert.ok(all.some((s) => s.error && s.error.code === code), code);
});

test('every fixture state maps to a view, a tray and a widget row without throwing', () => {
  for (const [k, s] of Object.entries(states)) {
    const vm = V.view(s, { now: NOW });
    assert.ok(vm.headline, k);
    assert.ok(vm.currentLine.includes(s.currentVersion), k);
    assert.equal(vm.channels.filter((c) => c.on).length, 1, k);
    assert.equal(vm.channels.find((c) => c.on).id, s.channel, k);
    assert.equal(V.trayItems(s)[0].label, 'Check for Updates…', k);
    V.widgetRow(s);
    // the product name comes from brand.js, never a literal
    assert.ok(!JSON.stringify(vm).includes('Claude Buddy'), k);
  }
});

test('a signature, verify or downgrade error never offers Install or Download', () => {
  for (const [k, s] of Object.entries(states)) {
    if (!s.error || !['signature', 'verify', 'downgrade'].includes(s.error.code)) continue;
    const vm = V.view(s, { now: NOW });
    assert.deepEqual(ids(vm).filter((i) => /install|download/.test(i)), [], k);
    assert.equal(V.widgetRow(s), null, k);
    assert.ok(!V.trayItems(s).some((i) => i.id === 'install'), k);
  }
  for (const k of ['error-signature', 'error-verify']) assert.equal(view(k).message.text, "The update didn't pass its security check, so it wasn't installed.");
  assert.equal(view('error-downgrade').message.text, states['error-downgrade'].currentVersion.includes('-beta')
    ? "You're on a newer beta than the stable release — you'll get the next stable when it ships."
    : 'The update server offered an older version than yours, so it was ignored.');
  const d = (currentVersion) => V.view({ ...states['error-downgrade'], currentVersion }).message.text;
  assert.equal(d('1.3.0-beta.2'), "You're on a newer beta than the stable release — you'll get the next stable when it ships.");
  assert.equal(d('1.3.0'), 'The update server offered an older version than yours, so it was ignored.');
});

test('no error state ever carries an Install or Download button', () => {
  for (const [k, s] of Object.entries(states)) if (s.status === 'error') assert.deepEqual(ids(V.view(s, { now: NOW })).filter((i) => i !== 'check'), [], k);
});

test('plain-English errors', () => {
  assert.equal(view('error-offline').message.text, "Can't reach the update server. Check your internet connection.");
  assert.equal(view('error-translocated').message.text, `Move ${NAME} to Applications, then open it again.`);
  assert.equal(view('error-not-writable').message.text, `${NAME} can't replace itself in this folder. Move it to Applications or check permissions.`);
  assert.equal(view('error-disk-full').message.text, 'Not enough disk space to download the update.');
  assert.deepEqual(labels(view('error-offline')), ['Try again']);
  assert.deepEqual(labels(view('error-server')), ['Try again']);
  assert.deepEqual(labels(view('error-unknown-update-failed')), ['Try again']);
  assert.equal(view('error-unknown-update-failed').message.detail, states['error-unknown-update-failed'].error.detail);
  // a fix the person must make is not something "Try again" can do
  assert.ok(!labels(view('error-translocated')).includes('Try again'));
  // the install was tried and did not start: still ready, so the restart action stays, as "Try again"
  const stalled = view('ready-install-stalled');
  assert.equal(stalled.message.text, `The update didn't finish installing. Try again, or restart ${NAME}.`);
  assert.equal(stalled.message.tone, 'error');
  assert.deepEqual(ids(stalled), ['install-now', 'install-idle']);
  assert.equal(stalled.buttons[0].label, 'Try again');
  assert.equal(V.view({ ...states['ready-install-stalled'], status: 'error' }).buttons[0].id, 'check');
  assert.equal(view('error-expired').message.text, `Couldn't confirm ${NAME} is up to date since 1 September 2026.`);
  assert.deepEqual(labels(view('error-expired')), ['Check now']);
  assert.equal(view('error-expired').lastChecked, null);
});

test('idle, checking, available, downloading', () => {
  assert.equal(view('idle-never-checked').lastChecked, 'Not checked yet');
  assert.equal(view('idle-never-checked').headline, 'Not checked yet');
  assert.equal(view('idle-up-to-date').headline, "You're up to date");
  assert.equal(view('idle-up-to-date').lastChecked, 'Last checked 2 hours ago');
  assert.deepEqual(labels(view('idle-up-to-date')), ['Check now']);
  assert.equal(view('idle-with-revert').revert.label, 'Revert to 1.1.0');
  assert.equal(view('idle-with-revert').revert.explain, `Installs 1.1.0 again and restarts ${NAME}.`);
  assert.equal(view('idle-with-revert').revert.confirm.text, `Revert to 1.1.0? ${NAME} will restart.`);
  assert.equal(view('idle-up-to-date').revert, null);
  assert.equal(view('checking').buttons[0].disabled, true);
  const av = view('available-manual-download');
  assert.equal(av.headline, 'Version 1.2.0 is available');
  assert.deepEqual(labels(av), ['Download', 'Check now']);
  assert.equal(av.size, '100 MB');
  assert.ok(av.notes.length);
  assert.equal(view('available-beta').channel, 'beta');
  const dl = view('downloading');
  assert.deepEqual(dl.progress, { percent: 42, label: '42%' });
  assert.deepEqual(dl.buttons, []);
});

test('portable update UI gives replacement instructions without an install or download action', () => {
  const vm = V.view({ ...states['idle-up-to-date'], status: 'error', error: { code: 'portable' }, installKind: 'portable', available: { version: '1.2.0', notes: '' }, canRevert: false });
  assert.match(vm.message.text, /latest portable copy/);
  assert.match(vm.message.text, /https:\/\/plexiform\.dev\/download/);
  assert.ok(!vm.buttons.some(b => b.id.startsWith('install') || b.id === 'download'));
  assert.equal(vm.revert, null);
});

test('ready: buttons follow the install kind', () => {
  assert.deepEqual(labels(view('ready-restart')), ['Restart now', `Restart ${LATER}`]);
  assert.deepEqual(ids(view('ready-restart')), ['install-now', 'install-idle']);
  assert.deepEqual(labels(view('ready-swap-mac')), ['Quit and update', `Update ${LATER}`]);
  assert.equal(view('ready-swap-mac').message.text, `${NAME} will reopen by itself.`);
  assert.deepEqual(labels(view('ready-deb-manual')), ['Open in Software Installer']);
  assert.equal(view('installing').buttons.length, 0);
});

test('ready while a session is busy asks before forcing', () => {
  const vm = view('ready-deferred-busy');
  assert.equal(vm.restartConfirm.text, 'A session in claude-traffic-light is working. Restart anyway?');
  assert.equal(vm.restartConfirm.confirmId, 'install-force');
  assert.deepEqual(V.COMMANDS['install-force'], { name: 'install', arg: { when: 'now', force: true } });
  assert.equal(view('ready-restart').restartConfirm, null);
});

test('a signed rollback reads as going back', () => {
  const vm = view('ready-revert');
  assert.equal(vm.headline, 'Going back to 1.1.0 is ready');
  assert.equal(vm.buttons[0].label, 'Quit and go back');
  assert.equal(V.trayItems(states['ready-revert'])[1].label, `Quit and Go Back to ${NAME} 1.1.0`);
});

test('required by the hub', () => {
  const vm = view('required-by-hub');
  assert.equal(vm.message.text, `Update ${NAME} to keep using your team board (Acme team needs 1.2.0).`);
  const row = V.widgetRow(states['required-by-hub']);
  assert.equal(row.text, `Update ${NAME} to keep using your team board (Acme team needs 1.2.0)`);
  // the widget cannot start a download: it opens the page that can
  assert.deepEqual([row.button.label, row.button.id], ['Open updates', 'open-updates']);
  const ready = V.widgetRow({ ...states['ready-restart'], requiredByHub: states['required-by-hub'].requiredByHub });
  assert.equal(ready.kind, 'hub');
  assert.equal(ready.button.label, 'Restart to update');
  assert.equal(ready.button.id, 'install-now');
  assert.equal(V.widgetRow({ ...states['ready-restart'], requiredByHub: states['required-by-hub'].requiredByHub }, { armed: true }).button, null);
});

test('the widget row is quiet: only when ready or hub-required, and only ever an install or the page', () => {
  const row = V.widgetRow(states['ready-restart']);
  assert.deepEqual([row.kind, row.text, row.sub, row.button.label, row.button.id, row.later], ['ready', 'Update ready', `${NAME} won't restart mid-task`, 'Restart when not working', 'install-idle', true]);
  for (const [k, s] of Object.entries(states)) {
    if (s.status === 'ready' || s.requiredByHub) continue;
    assert.equal(V.widgetRow(s), null, k);
  }
  for (const s of Object.values(states)) {
    const b = V.widgetRow(s) && V.widgetRow(s).button;
    if (b) assert.ok(['install-now', 'install-idle', 'open-updates'].includes(b.id), b.id);
  }
  assert.equal(V.widgetRow(states['ready-deb-manual']).button.id, 'install-now');
});

test('armed: "when you\'re not working" was asked for, and both surfaces say so', () => {
  assert.equal(V.widgetRow(states['ready-restart'], { armed: true }).sub, "Will restart when you're not working with Claude");
  assert.equal(V.widgetRow(states['ready-restart'], { armed: true }).button, null);
  const vm = V.view(states['ready-restart'], { armed: true });
  assert.equal(vm.message.text, `Will restart ${LATER}.`);
  assert.deepEqual(vm.buttons.find((b) => b.id === 'install-idle'), { id: 'install-idle', label: 'Scheduled', primary: false, disabled: true });
});

test('a rollback is "going back" on every surface, including the anyway button', () => {
  const back = { ...states['ready-revert'], busyReason: 'A session is working.' };
  assert.equal(V.view(back).restartConfirm.confirmLabel, 'Go back anyway');
  assert.equal(V.view({ ...back, installKind: 'restart' }).restartConfirm.confirmLabel, 'Go back anyway');
  assert.equal(V.widgetRow(states['ready-revert']).text, 'Going back to 1.1.0 is ready');
  assert.equal(V.widgetRow(states['ready-revert']).button.label, 'Go back when not working');
});

test('a deb opens the installer directly: no busy gate, no idle wait, no restart talk', () => {
  const vm = V.view({ ...states['ready-deb-manual'], busyReason: 'A session is working.' }, { deferred: true });
  assert.equal(vm.restartConfirm, null);
  assert.equal(vm.busyReason, null);
  assert.deepEqual(labels(vm), ['Open in Software Installer']);
  assert.ok(!/restart/i.test(vm.message.text));
});

test('a deb that could not open the installer says where the update is saved', () => {
  const vm = V.view({ ...states['ready-deb-manual'], error: { code: 'unknown', detail: 'xdg-open failed: /home/me/Downloads/plexiform_1.2.0_amd64.deb' } });
  assert.equal(vm.message.text, "Couldn't open the installer. The update is saved at /home/me/Downloads/plexiform_1.2.0_amd64.deb.");
  assert.deepEqual(labels(vm), ['Open in Software Installer']);
});

test('on mac, Revert downloads the previous release; the toggle copy and auto-download state render', () => {
  assert.equal(view('ready-revert').revert.explain, `Downloads 1.1.0 again and restarts ${NAME}.`);
  assert.equal(view('ready-revert').revert.confirm.text, `Download and go back to 1.1.0? ${NAME} will restart.`);
  assert.equal(view('idle-auto-download-on').autoDownload, true);
  assert.equal(view('idle-up-to-date').autoDownload, false);
});

test('a deferred install asks even before the state names the busy session', () => {
  const vm = V.view(states['ready-restart'], { deferred: true });
  assert.equal(vm.restartConfirm.text, 'A session is working. Restart anyway?');
  assert.equal(V.view(states['ready-restart']).restartConfirm, null);
});

test('revert is offered only while it is safe, with a confirm', () => {
  const r = (status) => V.view({ ...states.downloading, canRevert: true, previousVersion: '1.0.0', status, error: status === 'error' ? { code: 'server', detail: '' } : null }).revert;
  for (const st of ['idle', 'available', 'ready', 'error']) assert.equal(r(st).disabled, false, st);
  for (const st of ['checking', 'downloading', 'installing']) assert.equal(r(st).disabled, true, st);
});

test('the Beta switch has a warning', () => {
  assert.match(view('idle-up-to-date').betaConfirm.text, /less stable/);
});

test('failed commands get a short message; a deferral does not', () => {
  assert.equal(V.commandFailure({ ok: true }), null);
  assert.equal(V.commandFailure({ ok: false, error: 'busy', deferred: true }), null);
  assert.equal(V.commandFailure({ ok: false, error: 'forbidden' }), "That didn't work (forbidden). Try again.");
  assert.equal(V.commandFailure({ ok: false }), "That didn't work. Try again.");
  assert.ok(!V.commandFailure({ ok: false, error: '<img src=x onerror=1>' }).includes('<'));
});

test('tray items', () => {
  const t = (k) => V.trayItems(states[k]);
  assert.deepEqual(t('idle-up-to-date'), [{ id: 'check', label: 'Check for Updates…', enabled: true }]);
  assert.equal(t('checking')[0].enabled, false);
  assert.equal(V.trayKey(states.downloading), V.trayKey({ ...states.downloading, progress: { ...states.downloading.progress, percent: 49 } }));
  assert.notEqual(V.trayKey(states.downloading), V.trayKey({ ...states.downloading, progress: { ...states.downloading.progress, percent: 50 } }));
  assert.deepEqual(t('downloading')[1], { id: 'progress', label: 'Downloading update… 42%', enabled: false });
  assert.equal(t('ready-restart')[1].label, `Restart to Update ${NAME} 1.2.0`);
  assert.equal(t('ready-restart')[1].enabled, true);
  assert.equal(t('ready-swap-mac')[1].label, `Quit and Update ${NAME} 1.2.0`);
  assert.deepEqual(t('ready-swap-mac')[2], { id: 'hint', label: `${NAME} will reopen by itself`, enabled: false });
  assert.equal(t('ready-deb-manual')[1].label, 'Open in Software Installer');
  assert.deepEqual(V.trayItems(null), [{ id: 'check', label: 'Check for Updates…', enabled: false }]);
});

test('no readable state: an honest message, no buttons', () => {
  const vm = V.view(null);
  assert.equal(vm.present, false);
  assert.equal(vm.message.text, `Couldn't read the update status. Restart ${NAME} and try again.`);
  assert.deepEqual(vm.buttons, []);
});

test('version ordering: betas sort before their release', () => {
  assert.equal(V.cmpVersion('1.2.0-beta.3', '1.2.0-beta.4'), -1);
  assert.equal(V.cmpVersion('1.2.0-beta.9', '1.2.0'), -1);
  assert.equal(V.cmpVersion('1.10.0', '1.9.0'), 1);
  assert.equal(V.cmpVersion('1.1.0', '1.1.0'), 0);
});

test('notes: bullets and bold survive, nothing else does', () => {
  const blocks = V.sanitizeNotes('## Plexiform 1.2.0\n\n- Faster **startup**\n- Fixes the tray\n\nThanks!');
  assert.deepEqual(blocks, [
    { type: 'p', items: [[{ text: 'Plexiform 1.2.0', bold: true }]] },
    { type: 'ul', items: [[{ text: 'Faster ', bold: false }, { text: 'startup', bold: true }], [{ text: 'Fixes the tray', bold: false }]] },
    { type: 'p', items: [[{ text: 'Thanks!', bold: false }]] },
  ]);
});

const flat = (blocks) => JSON.stringify(blocks);

test('notes: script, style, tags, images and links are stripped', () => {
  const hostile = [
    '<script>alert(1)</script>before',
    '<style>body{display:none}</style>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">click</a>',
    '![track](https://evil.example/p.gif)',
    '[docs](https://evil.example/login)',
    '<svg onload=alert(1)>',
    '- <b onclick=x>bullet</b>',
  ].join('\n');
  const out = flat(V.sanitizeNotes(hostile));
  for (const bad of ['<', '>', 'alert', 'onerror', 'onclick', 'javascript', 'evil.example', 'display:none', 'track']) assert.ok(!out.includes(bad), bad);
  assert.ok(out.includes('before') && out.includes('click') && out.includes('docs') && out.includes('bullet'));
});

test('notes: only real tags go; "<2s" and "a < b" are words', () => {
  assert.equal(V.sanitizeNotes('Loads in <2s now')[0].items[0][0].text, 'Loads in <2s now');
  assert.equal(V.sanitizeNotes('when a < b and c > d')[0].items[0][0].text, 'when a < b and c > d');
  assert.equal(V.sanitizeNotes('x <!-- hidden --> y')[0].items[0][0].text, 'x  y');
  // what survives is only ever text: the page sets it with textContent
  const t = V.sanitizeNotes('x <img src=x onerror=alert(1)')[0].items[0][0];
  assert.equal(typeof t.text, 'string');
});

test('the stub enforces who may send which command', () => {
  assert.ok(Stub.allowed('page', 'install', { when: 'now', force: true }));
  assert.ok(Stub.allowed('page', 'revert'));
  assert.ok(Stub.allowed('widget', 'get-state'));
  assert.ok(Stub.allowed('widget', 'install', { when: 'idle' }));
  assert.ok(Stub.allowed('widget', 'install', { when: 'now' }));
  assert.ok(!Stub.allowed('widget', 'install', { when: 'now', force: true }));
  assert.ok(!Stub.allowed('widget', 'install', {}));
  for (const c of ['download', 'check', 'revert', 'set-channel', 'set-auto-download']) assert.ok(!Stub.allowed('widget', c), c);
  assert.ok(!Stub.allowed(null, 'get-state'));
});

test('the widget preload can send only get-state and an unforced install', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'preload.js'), 'utf8');
  const channels = [...src.matchAll(/'(updater:[a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(channels)].sort(), ['updater:get-state', 'updater:install', 'updater:state']);
  assert.ok(!/force/.test(src.split('updaterInstall')[1].split('\n')[0]));
});

test('notes: bounded and tolerant of non-strings', () => {
  assert.deepEqual(V.sanitizeNotes(null), []);
  assert.deepEqual(V.sanitizeNotes(42).length, 1);
  assert.ok(flat(V.sanitizeNotes('- x\n'.repeat(5000))).length < 20000);
  assert.ok(!flat(V.sanitizeNotes('a‮b')).includes('‮'));
});

test('the tray "Check for Updates…" is a user check, so offline and server errors are shown', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /item\.click = \(\) => \{ createUpdatesWindow\(\); updaterService\.check\(\{ user: true \}\); \}/);
  assert.match(src, /IS_DEV_RUN && !app\.isPackaged && process\.env\.CLAUDE_BUDDY_UPDATER_STUB/);
});
