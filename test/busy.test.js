// F5: calendar- and focus-aware pings. Every source here is a mock: no test
// runs the EventKit helper, reads the real Focus files or fetches a feed, so
// none can raise a permission prompt.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const R = require('../rules.js');
const B = require('../src/busy.js');
const busyWatch = require('../src/busy-watch.js');
const Help = require('../help.js');

const H = 3600000;
const at = (iso) => Date.parse(iso);
// The module joins with path.join, so the mock file keys must too (backslashes on Windows).
const buddy = (name) => path.join('/buddy', name);

// ── rules.js ────────────────────────────────────────────────────────────────
test('busy, free and back-from-busy are virtual signals Lights can offer', () => {
  for (const id of ['busy', 'free', 'back-from-busy']) assert.ok(R.SIGNALS.some((s) => s.id === id && s.kind === 'virtual'), id);
});

test('busy/free fire only when a source is on; back-from-busy rides alongside', () => {
  const sig = (env) => R.virtualSessions([{ signal: 'tool-use', cwd: '/a' }], Date.now(), env).map((v) => v.signal).filter((s) => ['busy', 'free', 'back-from-busy'].includes(s));
  assert.deepEqual(sig({}), []);
  assert.deepEqual(sig({ busy: null }), []);
  assert.deepEqual(sig({ busy: true }), ['busy']);
  assert.deepEqual(sig({ busy: false }), ['free']);
  assert.deepEqual(sig({ busy: false, backFromBusy: true }), ['free', 'back-from-busy']);
});

test('a rule on busy can style the widget, with sessions and with none', () => {
  const rules = [{ id: 'meeting', name: 'In a meeting', when: { signal: ['busy'] }, then: { effect: 'rain' } }, ...R.defaultRules()];
  const working = R.resolve(rules, [{ signal: 'tool-use', cwd: '/a' }], Date.now(), { busy: true });
  assert.equal(working.look.effect, 'rain');
  assert.equal(working.look.lamp, 'green', 'the lamp still shows the real state');
  assert.equal(R.resolve(rules, [], Date.now(), { busy: true }).look.effect, 'rain');
  assert.equal(R.resolve(rules, [], Date.now(), { busy: false }).look.effect, 'none');
});

test('busyPing survives normalizing only when valid, and is absent otherwise', () => {
  assert.equal(R.normalizeRule({ when: { signal: ['stop'] }, then: { busyPing: 'always' } }).then.busyPing, 'always');
  assert.ok(!('busyPing' in R.normalizeRule({ when: { signal: ['stop'] }, then: { busyPing: 'loud' } }).then));
  assert.ok(!('busyPing' in R.normalizeRule({ when: { signal: ['stop'] }, then: {} }).then));
});

test('pingsWhileBusy: red through by default, per-rule override, mine as a stub', () => {
  const rule = (lamp, busyPing) => R.normalizeRule({ when: { signal: ['stop'] }, then: { lamp, busyPing } });
  assert.equal(R.pingsWhileBusy(rule('red')), true);
  assert.equal(R.pingsWhileBusy(rule('amber')), false);
  assert.equal(R.pingsWhileBusy(rule('green')), false);
  assert.equal(R.pingsWhileBusy(rule(null), { lamp: 'red' }), true, 'an accent rule follows the lamp on screen');
  assert.equal(R.pingsWhileBusy(rule('amber', 'always')), true);
  assert.equal(R.pingsWhileBusy(rule('red', 'never')), false);
  assert.equal(R.pingsWhileBusy(rule('red', 'mine')), true, 'until the board knows owners, sessions are yours');
  assert.equal(R.pingsWhileBusy(rule('red', 'mine'), { session: { mine: false } }), false);
  assert.equal(R.pingsWhileBusy(rule('amber', 'mine')), false);
  assert.equal(R.pingsWhileBusy(undefined, { lamp: 'amber' }), false);
});

test('default red rules (blocked or broken) still ping while busy; finished and nudges wait', () => {
  const byId = Object.fromEntries(R.defaultRules().map((r) => [r.id, R.normalizeRule(r)]));
  for (const id of ['limit', 'permission', 'offline', 'failed-turn']) assert.equal(R.pingsWhileBusy(byId[id]), true, id);
  for (const id of ['done', 'nudge', 'working']) assert.equal(R.pingsWhileBusy(byId[id]), false, id);
});

// ── busyAt ──────────────────────────────────────────────────────────────────
test('busyAt honours availability, all-day, cancelled and declined', () => {
  const now = at('2026-09-30T10:30:00Z');
  const ev = (o) => ({ start: at('2026-09-30T10:00:00Z'), end: at('2026-09-30T11:00:00Z'), allDay: false, availability: 'busy', ...o });
  assert.deepEqual(B.busyAt([ev()], now), { busy: true, until: at('2026-09-30T11:00:00Z'), title: null });
  assert.equal(B.busyAt([ev({ availability: 'free' })], now).busy, false);
  assert.equal(B.busyAt([ev({ cancelled: true })], now).busy, false);
  assert.equal(B.busyAt([ev({ declined: true })], now).busy, false);
  assert.equal(B.busyAt([ev({ availability: 'notSupported' })], now).busy, true, 'calendars without availability count as busy');
  const day = { start: at('2026-09-30T00:00:00Z'), end: at('2026-10-01T00:00:00Z'), allDay: true };
  assert.equal(B.busyAt([{ ...day, availability: 'notSupported' }], now).busy, false, 'a birthday is not a meeting');
  assert.equal(B.busyAt([{ ...day, availability: 'unavailable' }], now).busy, true, 'an out-of-office day is');
  assert.equal(B.busyAt([ev({ end: now })], now).busy, false, 'end is exclusive');
  assert.equal(B.busyAt([ev(), ev({ end: at('2026-09-30T12:00:00Z') })], now).until, at('2026-09-30T12:00:00Z'), 'overlaps run to the last end');
  assert.equal(B.busyAt([ev({ title: 'Standup' })], now).title, 'Standup');
  assert.equal(B.nextBusy([ev({ start: at('2026-09-30T14:00:00Z'), end: at('2026-09-30T15:00:00Z') })], now), at('2026-09-30T14:00:00Z'));
});

test('combine: null when no source is on, busy if any is, with reasons', () => {
  assert.deepEqual(B.combine({}), { busy: null, reasons: [], until: null });
  assert.deepEqual(B.combine({ calendar: { on: false, busy: true } }), { busy: null, reasons: [], until: null });
  assert.equal(B.combine({ calendar: { on: true, busy: false } }).busy, false);
  const both = B.combine({ calendar: { on: true, busy: true, until: 5, title: 'Standup' }, focus: { on: true, busy: true, mode: 'Work' } });
  assert.deepEqual(both, { busy: true, reasons: ['Calendar: Standup', 'Focus: Work'], until: 5 });
  assert.deepEqual(B.combine({ ics: { on: true, busy: true, until: 9 } }).reasons, ['Calendar feed']);
});

// ── ICS ─────────────────────────────────────────────────────────────────────
const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const expand = (text, from, to, opts) => B.expandICS(B.parseICS(text), at(from), at(to), opts);

test('ICS: UTC, TZID, floating times, DURATION and folded lines', () => {
  const text = ics(
    ['UID:a', 'DTSTART:20260930T100000Z', 'DTEND:20260930T110000Z', 'SUMMARY:Stand', ' up'],
    ['UID:b', 'DTSTART;TZID=Africa/Johannesburg:20260930T150000', 'DURATION:PT30M'],
    ['UID:c', 'DTSTART;TZID=Europe/London:20260330T090000', 'DTEND;TZID=Europe/London:20260330T100000'],
  );
  const out = expand(text, '2026-03-29T00:00:00Z', '2026-10-01T00:00:00Z', { titles: true });
  assert.deepEqual(out.map((o) => [new Date(o.start).toISOString(), (o.end - o.start) / 60000]), [
    ['2026-09-30T10:00:00.000Z', 60],
    ['2026-09-30T13:00:00.000Z', 30], // SAST is UTC+2
    ['2026-03-30T08:00:00.000Z', 60], // London is on BST by 30 March
  ]);
  assert.equal(out[0].title, 'Standup', 'folded SUMMARY unfolds');
  assert.equal(expand(text, '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z')[0].title, undefined, 'no titles unless asked');
});

test('ICS: an unknown TZID (Outlook names) falls back to local time instead of vanishing', () => {
  const out = expand(ics(['UID:w', 'DTSTART;TZID=Outlook Custom Zone:20260930T090000', 'DTEND;TZID=Outlook Custom Zone:20260930T100000']), '2026-09-29T00:00:00Z', '2026-10-02T00:00:00Z');
  assert.equal(out.length, 1);
  assert.equal(out[0].start, new Date(2026, 8, 30, 9).getTime());
});

test('ICS: free, transparent, cancelled, and all-day events', () => {
  const text = ics(
    ['UID:1', 'DTSTART:20260930T100000Z', 'DTEND:20260930T110000Z', 'TRANSP:TRANSPARENT'],
    ['UID:2', 'DTSTART:20260930T100000Z', 'DTEND:20260930T110000Z', 'X-MICROSOFT-CDO-BUSYSTATUS:FREE'],
    ['UID:3', 'DTSTART:20260930T100000Z', 'DTEND:20260930T110000Z', 'STATUS:CANCELLED'],
    ['UID:4', 'DTSTART;VALUE=DATE:20260930', 'DTEND;VALUE=DATE:20261001'],
    ['UID:5', 'DTSTART;VALUE=DATE:20260930', 'DTEND;VALUE=DATE:20261001', 'X-MICROSOFT-CDO-BUSYSTATUS:OOF'],
  );
  const out = expand(text, '2026-09-29T00:00:00Z', '2026-10-02T00:00:00Z');
  assert.deepEqual(out.map((o) => [o.availability, !!o.cancelled, o.allDay]), [['free', false, false], ['free', false, false], ['busy', true, false], ['free', false, true], ['unavailable', false, true]]);
  assert.equal(B.busyAt(out, at('2026-09-30T10:30:00Z')).busy, true, 'the OOO day');
  assert.equal(B.busyAt(out.slice(0, 4), at('2026-09-30T10:30:00Z')).busy, false);
});

test('ICS: weekly BYDAY series with EXDATE and a moved instance', () => {
  // Mon/Wed 09:00 SAST standup from 7 Sep; 16 Sep skipped; 21 Sep moved to 14:00.
  const text = ics(
    ['UID:s', 'DTSTART;TZID=Africa/Johannesburg:20260907T090000', 'DTEND;TZID=Africa/Johannesburg:20260907T091500', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE;TZID=Africa/Johannesburg:20260916T090000'],
    ['UID:s', 'RECURRENCE-ID;TZID=Africa/Johannesburg:20260921T090000', 'DTSTART;TZID=Africa/Johannesburg:20260921T140000', 'DTEND;TZID=Africa/Johannesburg:20260921T141500'],
  );
  const out = expand(text, '2026-09-14T00:00:00Z', '2026-09-24T00:00:00Z').map((o) => new Date(o.start).toISOString()).sort();
  assert.deepEqual(out, ['2026-09-14T07:00:00.000Z', '2026-09-21T12:00:00.000Z', '2026-09-23T07:00:00.000Z']);
});

test('ICS: COUNT, UNTIL, INTERVAL, daily and monthly nth-weekday', () => {
  const starts = (rrule, from, to, dt = '20260901T080000Z') => expand(ics(['UID:x', `DTSTART:${dt}`, 'DURATION:PT1H', `RRULE:${rrule}`]), from, to).map((o) => new Date(o.start).toISOString().slice(0, 10));
  assert.deepEqual(starts('FREQ=DAILY;COUNT=3', '2026-08-01T00:00:00Z', '2026-12-01T00:00:00Z'), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(starts('FREQ=DAILY;UNTIL=20260903T080000Z', '2026-08-01T00:00:00Z', '2026-12-01T00:00:00Z'), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(starts('FREQ=WEEKLY;INTERVAL=2', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'), ['2026-09-01', '2026-09-15', '2026-09-29']);
  assert.deepEqual(starts('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', '2026-09-04T00:00:00Z', '2026-09-09T00:00:00Z'), ['2026-09-04', '2026-09-07', '2026-09-08']);
  assert.deepEqual(starts('FREQ=MONTHLY;BYDAY=2TU', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z'), ['2026-09-08', '2026-10-13', '2026-11-10']);
  assert.deepEqual(starts('FREQ=MONTHLY;BYDAY=-1FR', '2026-09-01T00:00:00Z', '2026-11-01T00:00:00Z'), ['2026-09-25', '2026-10-30']);
  assert.deepEqual(starts('FREQ=YEARLY', '2027-01-01T00:00:00Z', '2029-01-01T00:00:00Z'), ['2027-09-01', '2028-09-01']);
  assert.equal(starts('FREQ=DAILY', '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z', '20100101T080000Z').length, 1, 'a long-running series still lands today');
});

test('ICS: weekly series keeps its wall-clock time across a DST change', () => {
  const out = expand(ics(['UID:d', 'DTSTART;TZID=Europe/London:20261019T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY']), '2026-10-19T00:00:00Z', '2026-11-03T00:00:00Z');
  assert.deepEqual(out.map((o) => new Date(o.start).toISOString()), ['2026-10-19T08:00:00.000Z', '2026-10-26T09:00:00.000Z', '2026-11-02T09:00:00.000Z']);
});

test('ICS: junk never throws', () => {
  assert.deepEqual(B.parseICS('not a calendar'), []);
  assert.deepEqual(B.expandICS(B.parseICS(ics(['UID:j', 'DTSTART:garbage'])), 0, Date.now()), []);
  assert.doesNotThrow(() => expand(ics(['UID:k', 'DTSTART:20260901T080000Z', 'RRULE:FREQ=SECONDLY']), '2026-08-01T00:00:00Z', '2026-10-01T00:00:00Z'));
});

// ── Focus ───────────────────────────────────────────────────────────────────
test('Focus: Assertions.json with and without an active Focus, and its name', () => {
  assert.deepEqual(B.parseFocusAssertions('{"data":[{}],"header":{"version":8}}'), { focused: false, mode: null });
  const on = JSON.stringify({ data: [{ storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeIdentifier: 'com.apple.focus.work' } }] }] });
  const modes = JSON.stringify({ data: [{ modeConfigurations: { 'com.apple.focus.work': { mode: { name: 'Work' } } } }] });
  assert.deepEqual(B.parseFocusAssertions(on, modes), { focused: true, mode: 'Work' });
  assert.deepEqual(B.parseFocusAssertions(on), { focused: true, mode: 'work' });
  assert.equal(B.parseFocusAssertions('{oops').focused, false);
});

test('Focus: what a Get Current Focus shortcut prints', () => {
  assert.deepEqual(B.parseFocusShortcut(''), { focused: false, mode: null });
  assert.deepEqual(B.parseFocusShortcut('  \n'), { focused: false, mode: null });
  assert.deepEqual(B.parseFocusShortcut('None'), { focused: false, mode: null });
  assert.deepEqual(B.parseFocusShortcut('Do Not Disturb\n'), { focused: true, mode: 'Do Not Disturb' });
});

// ── While you were away ─────────────────────────────────────────────────────
test('away log: records what changed while busy, latest outcome per session', () => {
  const s = (id, signal, extra = {}) => ({ sessionId: id, cwd: `/w/${id}`, signal, hostApp: 'iTerm2', ...extra });
  const log = B.startAway(1000, ['Calendar'], [s('a', 'tool-use'), s('old', 'permission-ask')]);
  B.noteAway(log, [s('a', 'tool-use'), s('old', 'permission-ask'), s('b', 'tool-use')], 2000);
  assert.equal(log.items.length, 0, 'an ask already there before you left is not news');
  B.noteAway(log, [s('a', 'permission-ask', { tool: 'Bash' }), s('b', 'turn-failed', { failKind: 'network' })], 3000);
  B.noteAway(log, [s('a', 'permission-ask', { tool: 'Bash' }), s('b', 'stop'), s('c', 'limit-hit')], 4000);
  const recap = B.finishAway(log, 5000, [s('a', 'permission-ask'), s('b', 'stop')]);
  assert.equal(recap.v, B.RECAP_VERSION);
  assert.deepEqual([recap.from, recap.to, recap.reasons], [1000, 5000, ['Calendar']]);
  assert.deepEqual(recap.items.map((x) => [x.kind, x.folder, x.detail, x.open]), [
    ['needs-you', 'c', 'usage limit', false],
    ['needs-you', 'a', 'permission for Bash', true],
    ['done', 'b', null, false],
  ]);
  assert.deepEqual(recap.counts, { done: 1, needsYou: 2, failed: 0 });
  assert.equal(recap.headline, '1 done · 2 need you (usage limit on c)');
  assert.equal(recap.items[1].hostApp, 'iTerm2', 'enough to jump to the terminal');
  assert.deepEqual(JSON.parse(JSON.stringify(recap)), recap, 'plain JSON, so the phone can read the same file');
});

test('away log: nothing happened reads as such', () => {
  const recap = B.finishAway(B.startAway(0), 10);
  assert.deepEqual([recap.items, recap.headline], [[], 'Nothing happened']);
  assert.equal(B.finishAway(B.noteAway(B.startAway(0), [{ sessionId: 'x', signal: 'turn-failed', cwd: '/x' }], 1), 2).headline, '1 failure');
});

// ── busy-watch with mock providers ──────────────────────────────────────────
function rig(over = {}) {
  const files = new Map(over.files || []);
  const calls = [];
  let clock = over.now || at('2026-09-30T10:30:00Z');
  let config = { busyHold: true, busyCalendar: true, busyCalendarTitles: false, busyIcsUrl: '', busyFocus: false, busyFocusShortcut: '', ...over.config };
  const helperState = { status: 'notDetermined', grant: 'fullAccess', events: [], ...over.helper };
  const exec = async (file, args) => {
    calls.push([path.basename(file), ...args]);
    if (file.endsWith('shortcuts')) { if (over.shortcut instanceof Error) throw over.shortcut; return over.shortcut || ''; }
    if (args[0] === 'status') return JSON.stringify({ status: helperState.status });
    if (args[0] === 'request') { helperState.status = helperState.grant; return JSON.stringify({ status: helperState.status, granted: helperState.grant === 'fullAccess' }); }
    if (args[0] === 'events') return JSON.stringify(helperState.status === 'fullAccess' ? { status: 'fullAccess', events: helperState.events } : { status: helperState.status, error: 'not-authorized' });
    throw new Error('unexpected');
  };
  const readFile = (f) => {
    const v = files.get(f);
    if (v instanceof Error) throw v;
    if (v === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return v;
  };
  let changes = 0;
  const logs = [];
  const w = busyWatch({
    rootDir: '/buddy', home: '/home', helperPath: '/app/buddy-calendar',
    loadConfig: () => config, isDevRun: !!over.isDevRun, fakeFile: over.fakeFile || null,
    exec, readFile, writeFile: (f, t) => files.set(f, t), removeFile: (f) => files.delete(f), exists: (f) => files.has(f) || (f === '/app/buddy-calendar' && over.helper !== null),
    fetch: over.fetch || (async () => { throw new Error('no network in tests'); }),
    now: () => clock, onChange: () => { changes += 1; }, log: (...a) => logs.push(a.join(' ')),
  });
  return { w, calls, files, helperState, logs, advance: (ms) => { clock += ms; }, setConfig: (c) => { config = { ...config, ...c }; }, changes: () => changes };
}
const meeting = { start: at('2026-09-30T10:00:00Z'), end: at('2026-09-30T11:00:00Z'), allDay: false, availability: 'busy', cancelled: false, declined: false };

test('watch: calendar is off by default and a tick never prompts, even when switched on', async () => {
  const main = require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /busyCalendar: false/, 'DEFAULT_CONFIG keeps macOS Calendar off until ticked');
  const r = rig({ helper: { events: [meeting] } });
  await r.w.tick();
  r.advance(2 * 60000);
  await r.w.tick();
  assert.equal(r.calls.filter((c) => c[1] === 'request').length, 0, 'no system prompt from the timer');
  assert.equal(r.w.env().busy, null, 'notDetermined counts as no source');
  assert.equal(r.w.status().calendar.status, 'notDetermined');
});

test('watch: ticking the calendar in Settings asks once, then reads busy from events', async () => {
  const r = rig({ helper: { events: [meeting] } });
  await r.w.enableCalendar();
  assert.deepEqual(r.calls.map((c) => c[1]), ['status', 'request', 'events'], 'a poll is one spawn: events reports the status too');
  assert.equal(r.w.env().busy, true);
  assert.equal(r.w.holding(), true);
  assert.equal(r.w.status().calendar.status, 'fullAccess');
  assert.deepEqual(r.calls.find((c) => c[1] === 'events').includes('--titles'), false, 'titles only when opted in');
  await r.w.enableCalendar();
  assert.equal(r.calls.filter((c) => c[1] === 'request').length, 1, 'already decided: no second ask');
});

test('watch: a turned-down or write-only calendar counts as no source and is not re-asked by the timer', async () => {
  for (const grant of ['denied', 'writeOnly']) {
    const r = rig({ helper: { grant } });
    await r.w.enableCalendar();
    r.advance(2 * 60000);
    await r.w.tick();
    assert.equal(r.calls.filter((c) => c[1] === 'request').length, 1, grant);
    assert.equal(r.w.env().busy, null, `${grant}: busy stays unknown`);
  }
});

test('watch: dev runs never prompt, even from the Settings tick-box', async () => {
  const r = rig({ isDevRun: true });
  await r.w.enableCalendar();
  assert.deepEqual(r.calls, []);
});

test('watch: no helper in the build means no calendar, not a crash', async () => {
  const r = rig({ helper: null });
  await r.w.tick();
  assert.deepEqual(r.calls, []);
  assert.equal(r.w.status().calendar.status, 'missing');
});

test('watch: dev runs never touch a real source, only the fake file', async () => {
  const r = rig({ isDevRun: true, fakeFile: '/tmp/fake.json', files: [['/tmp/fake.json', '{"busy":true,"reason":"Standup"}']] });
  await r.w.tick();
  assert.deepEqual(r.calls, [], 'no helper, no shortcuts');
  assert.deepEqual(r.w.status().reasons, ['Test: Standup']);
  const quiet = rig({ isDevRun: true });
  await quiet.w.tick();
  assert.deepEqual([quiet.calls, quiet.w.env().busy], [[], null]);
});

test('watch: ICS feed is fetched, cached and survives a failed refresh', async () => {
  let fail = false;
  const feed = ics(['UID:m', 'DTSTART:20260930T100000Z', 'DTEND:20260930T110000Z']);
  const r = rig({
    config: { busyCalendar: false, busyIcsUrl: 'webcal://cal.example/private.ics' },
    fetch: async (url, opts) => { assert.equal(url, 'https://cal.example/private.ics'); assert.ok(opts.signal, 'fetched with an abort signal'); if (fail) throw new Error('offline'); return { ok: true, status: 200, text: async () => feed }; },
  });
  await r.w.tick();
  assert.equal(r.w.env().busy, true);
  const cache = JSON.parse(r.files.get(buddy('busy-ics-cache.json')));
  assert.deepEqual(Object.keys(cache).sort(), ['events', 'key', 'titles', 'v']);
  assert.equal(cache.key, require('crypto').createHash('sha256').update('https://cal.example/private.ics').digest('hex'));
  fail = true;
  r.advance(11 * 60000);
  await r.w.tick();
  assert.equal(r.w.status().ics.error, 'offline');
  assert.equal(r.w.env().busy, true, 'the last good copy still counts');
  r.setConfig({ busyIcsUrl: 'https://other.example/cal.ics' });
  await r.w.tick();
  assert.equal(r.w.status().ics.events, 0, "a new feed doesn't inherit the old one's cache");
});

test('watch: ICS rejects non-calendars and bad URLs', async () => {
  const r = rig({ config: { busyCalendar: false, busyIcsUrl: 'https://x.example/page' }, fetch: async () => ({ ok: true, text: async () => '<html>' }) });
  await r.w.tick();
  assert.equal(r.w.status().ics.error, 'not a calendar feed');
  for (const url of ['file:///etc/passwd', 'http://cal.example/private.ics']) {
    const bad = rig({ config: { busyCalendar: false, busyIcsUrl: url } });
    await bad.w.tick();
    assert.equal(bad.w.status().ics.on, false, url);
  }
});

test('watch: Focus from Assertions.json when readable, else the Shortcut', async () => {
  const dnd = (f) => path.join('/home/Library/DoNotDisturb/DB', f);
  const on = JSON.stringify({ data: [{ storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeIdentifier: 'x.work' } }] }] });
  const direct = rig({ config: { busyCalendar: false, busyFocus: true }, files: [[dnd('Assertions.json'), on]] });
  await direct.w.tick();
  assert.deepEqual([direct.w.env().busy, direct.w.status().focus.via], [true, 'assertions']);

  const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
  const locked = rig({ config: { busyCalendar: false, busyFocus: true }, files: [[dnd('Assertions.json'), eperm]] });
  await locked.w.tick();
  assert.deepEqual([locked.w.env().busy, locked.w.status().focus.error], [null, 'no-access'], 'no shortcut named: honest unknown');

  const viaShortcut = rig({ config: { busyCalendar: false, busyFocus: true, busyFocusShortcut: 'Buddy Focus' }, files: [[dnd('Assertions.json'), eperm]], shortcut: 'Work\n' });
  await viaShortcut.w.tick();
  assert.deepEqual(viaShortcut.calls, [['shortcuts', 'run', '--', 'Buddy Focus']]);
  assert.deepEqual([viaShortcut.w.env().busy, viaShortcut.w.status().focus.mode], [true, 'Work']);
});

test('watch: the recap arrives once when a busy spell ends, then back-from-busy holds briefly', async () => {
  const r = rig({ helper: { status: 'fullAccess', events: [meeting] } });
  await r.w.tick();
  const s = (signal) => [{ sessionId: 'a', cwd: '/w/api', signal, tool: 'Bash' }];
  assert.equal(r.w.observe(s('tool-use')), null);
  r.w.noteHeld('Task finished', 'stop');
  assert.equal(r.w.observe(s('stop')), null);
  r.advance(31 * 60000); // meeting over at 11:00
  r.advance(60000);
  await r.w.tick();
  assert.equal(r.w.env().busy, false);
  const recap = r.w.observe(s('stop'));
  assert.equal(recap.headline, '1 done · 1 ping held');
  assert.equal(recap.held, 1);
  assert.deepEqual(recap.heldPings, [{ rule: 'Task finished', signal: 'stop', count: 1 }]);
  assert.equal(r.w.observe(s('stop')), null, 'only once');
  assert.equal(JSON.parse(r.files.get(buddy('away.json'))).headline, recap.headline);
  assert.equal(r.w.recap().headline, recap.headline);
  assert.equal(r.w.env().backFromBusy, true);
  r.advance(busyWatch.BACK_MS);
  assert.equal(r.w.env().backFromBusy, false);
  r.w.dismiss();
  assert.equal(r.w.recap(), null);
  assert.ok(!r.files.has(buddy('away.json')), 'dismissed means gone from disk too');
});

test('watch: with holding off, busy is still a rule condition but nothing is logged or held', async () => {
  const r = rig({ helper: { status: 'fullAccess', events: [meeting] }, config: { busyHold: false } });
  await r.w.tick();
  assert.deepEqual([r.w.env().busy, r.w.holding()], [true, false]);
  r.w.observe([{ sessionId: 'a', signal: 'stop' }]);
  r.advance(H);
  await r.w.tick();
  assert.equal(r.w.observe([{ sessionId: 'a', signal: 'stop' }]), null);
});

// ── Review fixes ────────────────────────────────────────────────────────────
// Guards the old 7 s-per-tick regression. Best of three against a loose
// budget so a busy machine can't fail it while a real regression still does.
test('ICS perf: 500 weekly TZID series from 2021 expand over ±1 day in under 150 ms (best of 3)', () => {
  const zones = ['Europe/London', 'America/New_York', 'Africa/Johannesburg', 'Asia/Tokyo', 'Pacific Standard Time'];
  const series = [];
  for (let i = 0; i < 500; i += 1) series.push([`UID:p${i}`, `DTSTART;TZID=${zones[i % zones.length]}:20210104T0${i % 9}0000`, 'DURATION:PT30M', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR', `EXDATE;TZID=${zones[i % zones.length]}:20210106T0${i % 9}0000`]);
  const events = B.parseICS(ics(...series));
  const now = at('2026-09-30T10:00:00Z');
  B.expandICS(events, now - 86400000, now + 86400000); // warm the formatter cache
  let out;
  let ms = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const t0 = process.hrtime.bigint();
    out = B.expandICS(events, now - 86400000, now + 86400000);
    ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  assert.ok(out.length >= 500, `expanded ${out.length}`);
  assert.ok(ms < 150, `best of 3 took ${ms.toFixed(1)} ms`);
});

test('ICS: jumping ahead to the window keeps INTERVAL and monthly patterns aligned to DTSTART', () => {
  const starts = (rrule, from, to, dt) => expand(ics(['UID:x', `DTSTART:${dt}`, 'DURATION:PT1H', `RRULE:${rrule}`]), from, to).map((o) => new Date(o.start).toISOString().slice(0, 10));
  assert.deepEqual(starts('FREQ=WEEKLY;INTERVAL=3;BYDAY=TU', '2026-09-01T00:00:00Z', '2026-10-15T00:00:00Z', '20190101T080000Z'), ['2026-09-15', '2026-10-06']);
  assert.deepEqual(starts('FREQ=DAILY;INTERVAL=5', '2026-09-28T00:00:00Z', '2026-10-06T00:00:00Z', '20200101T080000Z'), ['2026-10-01']);
  assert.deepEqual(starts('FREQ=MONTHLY;INTERVAL=4;BYDAY=1MO', '2026-08-01T00:00:00Z', '2027-02-01T00:00:00Z', '20180101T080000Z'), ['2026-09-07', '2027-01-04']);
  // With COUNT the series is still counted from DTSTART.
  assert.deepEqual(starts('FREQ=WEEKLY;COUNT=2', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', '20200101T080000Z'), []);
});

test('ICS: Windows zone names resolve through the CLDR map, whatever the local zone', () => {
  const was = process.env.TZ;
  process.env.TZ = 'Africa/Johannesburg';
  try {
    const out = expand(ics(['UID:w', 'DTSTART;TZID=Pacific Standard Time:20260930T090000', 'DTEND;TZID=Pacific Standard Time:20260930T100000'], ['UID:v', 'DTSTART;TZID="W. Europe Standard Time":20260115T090000', 'DURATION:PT1H']), '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z');
    assert.deepEqual(out.map((o) => new Date(o.start).toISOString()).sort(), ['2026-01-15T08:00:00.000Z', '2026-09-30T16:00:00.000Z']);
  } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
  assert.equal(B.ianaZone('/mozilla.org/20050126_1/Europe/London'), 'Europe/London');
  assert.equal(B.ianaZone('Europe/Paris'), 'Europe/Paris');
});

test('ICS: parse drops titles unless asked', () => {
  const text = ics(['UID:t', 'DTSTART:20260930T100000Z', 'DURATION:PT1H', 'SUMMARY:Secret project', 'DESCRIPTION:dial-in 1234', 'LOCATION:Room 7', 'ATTENDEE:mailto:a@b.c']);
  const [slim] = B.parseICS(text, { titles: false });
  assert.equal(slim.title, undefined);
  assert.doesNotMatch(JSON.stringify(slim), /dial-in|Room 7|mailto/);
  assert.equal(B.parseICS(text)[0].title, 'Secret project');
});

test('watch: the ICS cache holds busy fields only, keyed by a hash of the URL', async () => {
  const feed = ics(['UID:m', 'DTSTART:20260930T100000Z', 'DTEND:20260930T110000Z', 'SUMMARY:Board meeting', 'DESCRIPTION:pin 4242', 'LOCATION:HQ']);
  const r = rig({ config: { busyCalendar: false, busyIcsUrl: 'https://cal.example/secret-abc123.ics' }, fetch: async () => ({ ok: true, text: async () => feed }) });
  await r.w.tick();
  const raw = r.files.get(buddy('busy-ics-cache.json'));
  for (const leak of ['secret-abc123', 'Board meeting', 'pin 4242', 'HQ', 'BEGIN:VCALENDAR']) assert.ok(!raw.includes(leak), leak);
  r.setConfig({ busyCalendarTitles: true });
  await r.w.tick();
  assert.match(r.files.get(buddy('busy-ics-cache.json')), /Board meeting/, 'titles only once opted in');
  const legacy = rig({ config: { busyCalendar: false, busyIcsUrl: 'https://cal.example/x.ics' }, files: [[buddy('busy-ics-cache.json'), JSON.stringify({ url: 'https://cal.example/x.ics', text: feed })]] });
  await legacy.w.tick();
  assert.ok(!legacy.files.has(buddy('busy-ics-cache.json')), 'the old raw-feed cache is deleted, not read');
  // A fresh start (same URL, no network) reads the cache back.
  const again = rig({ config: { busyCalendar: false, busyIcsUrl: 'https://cal.example/secret-abc123.ics' }, files: [[buddy('busy-ics-cache.json'), raw]] });
  await again.w.tick();
  assert.equal(again.w.env().busy, true);
});

test('watch: ICS occurrences are expanded on fetch and hourly, not every tick', async () => {
  const feed = ics(['UID:m', 'DTSTART:20200106T100000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY']);
  const r = rig({ config: { busyCalendar: false, busyIcsUrl: 'https://cal.example/a.ics' }, fetch: async () => ({ ok: true, text: async () => feed }) });
  const real = B.expandICS;
  let calls = 0;
  B.expandICS = (...a) => { calls += 1; return real(...a); };
  try {
    await r.w.tick();
    for (let i = 0; i < 20; i += 1) { r.advance(15000); await r.w.tick(); }
    assert.equal(calls, 1);
    r.advance(60 * 60000);
    await r.w.tick();
    assert.equal(calls, 2, 'the hourly re-expand keeps tomorrow covered');
  } finally {
    B.expandICS = real;
  }
});

test('watch: ICS fetch refuses oversized feeds by header or by streamed bytes, and times out', async () => {
  const big = rig({ config: { busyCalendar: false, busyIcsUrl: 'https://cal.example/a.ics' }, fetch: async () => ({ ok: true, headers: { get: () => String(6 * 1024 * 1024) }, text: async () => { throw new Error('must not buffer'); } }) });
  await big.w.tick();
  assert.equal(big.w.status().ics.error, 'feed is over 5 MB');
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const stream = rig({
    config: { busyCalendar: false, busyIcsUrl: 'https://cal.example/b.ics' },
    fetch: async () => ({ ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => { sent += 1; return { done: false, value: chunk }; }, cancel: async () => { cancelled = true; } }) } }),
  });
  await stream.w.tick();
  assert.equal(stream.w.status().ics.error, 'feed is over 5 MB');
  assert.ok(cancelled && sent <= 6, `stopped after ${sent} MB`);
  const slow = rig({
    config: { busyCalendar: false, busyIcsUrl: 'https://cal.example/c.ics' },
    fetch: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  const realSet = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSet(fn, ms >= 20000 ? 0 : ms, ...a);
  try { await slow.w.tick(); } finally { global.setTimeout = realSet; }
  assert.equal(slow.w.status().ics.error, 'timed out');
});

test('watch: one failed Focus poll keeps the last reading; the third in a row drops it', async () => {
  const dnd = path.join('/home/Library/DoNotDisturb/DB', 'Assertions.json');
  const on = JSON.stringify({ data: [{ storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeIdentifier: 'x.work' } }] }] });
  const r = rig({ config: { busyCalendar: false, busyFocus: true }, files: [[dnd, on]] });
  await r.w.tick();
  assert.equal(r.w.env().busy, true);
  r.files.set(dnd, Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
  let flips = r.changes();
  await r.w.tick();
  await r.w.tick();
  assert.equal(r.w.env().busy, true, 'two failures: still the last good reading');
  assert.equal(r.changes(), flips, 'no flap');
  await r.w.tick();
  assert.equal(r.w.env().busy, null, 'third failure: honest unknown');
  r.files.set(dnd, on);
  await r.w.tick();
  assert.equal(r.w.env().busy, true);

  const sc = rig({ config: { busyCalendar: false, busyFocus: true, busyFocusShortcut: 'F' }, files: [[dnd, Object.assign(new Error('EPERM'), { code: 'EPERM' })]], shortcut: 'Work' });
  await sc.w.tick();
  assert.equal(sc.w.env().busy, true);
  sc.advance(59000);
  await sc.w.tick();
  assert.equal(sc.calls.length, 1, 'the Shortcut runs at most once a minute');
});

test('watch: a calendar grant that macOS forgot is reported as a reset, with a reconnect path', async () => {
  const r = rig({ helper: { status: 'fullAccess', events: [meeting] } });
  await r.w.tick();
  assert.ok(r.files.has(buddy('.calendar-granted')));
  assert.equal(r.w.status().calendar.reset, false);
  r.helperState.status = 'notDetermined'; // e.g. an ad-hoc signed update
  r.advance(2 * 60000);
  await r.w.tick();
  assert.deepEqual([r.w.status().calendar.status, r.w.status().calendar.reset], ['notDetermined', true]);
  assert.equal(r.calls.filter((c) => c[1] === 'request').length, 0, 'the timer still never asks');
  await r.w.enableCalendar();
  assert.deepEqual([r.w.status().calendar.status, r.w.status().calendar.reset], ['fullAccess', false]);
  const fresh = rig();
  await fresh.w.tick();
  assert.equal(fresh.w.status().calendar.reset, false, 'never granted: not a reset');
});

test('watch: held pings alone still make a recap, listed per rule', async () => {
  const r = rig({ helper: { status: 'fullAccess', events: [meeting] } });
  await r.w.tick();
  r.w.observe([]);
  for (let i = 0; i < 3; i += 1) r.w.noteHeld('Waiting for you', 'idle-nudge');
  r.w.noteHeld('Budget warning', 'budget-warning');
  r.w.noteHeld('Working over 10 minutes', 'long-running');
  r.advance(H);
  await r.w.tick();
  const recap = r.w.observe([]);
  assert.equal(recap.headline, '5 pings held');
  assert.deepEqual(recap.heldPings.map((h) => [h.rule, h.count]), [['Waiting for you', 3], ['Budget warning', 1], ['Working over 10 minutes', 1]]);
});

test('watch: meeting titles never reach the log', async () => {
  const r = rig({ helper: { status: 'fullAccess', events: [{ ...meeting, title: 'Layoffs sync' }] }, config: { busyCalendarTitles: true } });
  await r.w.tick();
  assert.deepEqual(r.w.status().reasons, ['Calendar: Layoffs sync']);
  assert.ok(r.logs.some((l) => l.includes('busy (Calendar)')));
  assert.ok(!r.logs.some((l) => l.includes('Layoffs')));
});

test('watch: an undismissed recap expires and takes away.json with it', async () => {
  const r = rig({ helper: { status: 'fullAccess', events: [meeting] } });
  await r.w.tick();
  r.w.observe([]);
  r.w.noteHeld('Task finished', 'stop');
  r.advance(H);
  await r.w.tick();
  r.w.observe([]);
  assert.ok(r.files.has(buddy('away.json')));
  r.advance(61 * 60000);
  assert.equal(r.w.recap(), null);
  assert.ok(!r.files.has(buddy('away.json')));
});

test('packaging: the calendar helper is signed with calendars-only entitlements', () => {
  const fs = require('fs');
  const Sign = require('../build/sign.js');
  const opts = Sign.withHelperEntitlements(() => ({ entitlements: 'inherit.plist', hardenedRuntime: true }));
  assert.deepEqual(opts('/out/Claude Buddy.app/Contents/Resources/calendar-helper/buddy-calendar'), { entitlements: Sign.HELPER_ENTITLEMENTS, hardenedRuntime: true });
  assert.deepEqual(opts('/out/Claude Buddy.app/Contents/Frameworks/Electron Framework.framework'), { entitlements: 'inherit.plist', hardenedRuntime: true });
  const plist = fs.readFileSync(Sign.HELPER_ENTITLEMENTS, 'utf8');
  assert.deepEqual([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]), ['com.apple.security.personal-information.calendars']);
  assert.equal(require('../package.json').build.mac.sign, './build/sign.js');
});

test('main: the pending-permission look also gets the busy signals', () => {
  const main = require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const resolves = main.slice(main.indexOf('function computeState'), main.indexOf('// The tool of the most recently updated session')).match(/Rules\.resolve\(config\.rules, (?!synthetic)[^\n]*/g);
  assert.equal(resolves.length, 2);
  // Both share one env (offline, busy, F2 git, F1 spend).
  for (const r of resolves) assert.match(r, /, env\);?$/, r);
  const env = main.match(/const env = \{[^\n]*\};/);
  assert.ok(env, 'computeState builds one env');
  for (const part of [/offline: !online/, /\.\.\.BusyWatch\.env\(\)/, /git: /, /spend \}/]) assert.match(env[0], part);
});

test('busy holds F1 spend and F2 git pings by their default rules: red through, the rest into the recap', () => {
  const byId = Object.fromEntries(R.defaultRules().map((r) => [r.id, R.normalizeRule(r)]));
  assert.equal(R.pingsWhileBusy(byId.runaway), true);
  assert.equal(R.pingsWhileBusy(byId['budget-exceeded']), true);
  assert.equal(R.pingsWhileBusy(byId['budget-warning']), false);
  // Git rules set no lamp: their sound follows the lamp on screen.
  assert.equal(R.pingsWhileBusy(byId['git-ci-failed'], { lamp: 'green' }), false);
  assert.equal(R.pingsWhileBusy(byId['git-ci-failed'], { lamp: 'red' }), true);
});

test('main: git rule sounds and spend notifications go through the busy gate', () => {
  const main = require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const sound = main.slice(main.indexOf('function maybePlayAlertSound'), main.indexOf('lastSoundKey = key;', main.indexOf('function maybePlayAlertSound')));
  assert.match(sound, /GitSignals\.soundKey\(/);
  assert.match(sound, /!restored && pingAllowed\(owned\.sound, \{ lamp: look\.lamp \}\)\) playSound/);
  const notify = main.slice(main.indexOf('function maybeNotify'), main.indexOf('function maybeNotify') + 800);
  assert.match(notify, /spend: st\.spend/);
  assert.match(notify, /for \(const n of fire\) \{\n\s+if \(!notificationAllowed\(/);
  const budget = main.slice(main.indexOf('function notifyBudget'), main.indexOf('note.show();', main.indexOf('function notifyBudget')));
  assert.match(budget, /if \(!pingAllowed\(null, \{ signal: 'budget' \}\)\) return;\n\s+const note = new Notification/);
  assert.match(main, /await performKnock\(appName, target, base, force \|\| pingAllowed\(st\.owned\?\.sound, \{ lamp: base\.lamp \}\)\);/);
  assert.match(main, /const knockSound = loadConfig\(\)\.sounds && mayPing/);
  assert.doesNotMatch(main, /(?<!delete )config\.soundOnAmber|\(\)\.soundOnAmber/, 'the old key is only migrated, never read');
  assert.match(main, /if \(typeof saved\.sounds !== 'boolean' && typeof saved\.soundOnAmber === 'boolean'\) config\.sounds = saved\.soundOnAmber;\n\s+delete config\.soundOnAmber;/);
});

// ── Help ────────────────────────────────────────────────────────────────────
test('help: explains held pings only once a busy source works', () => {
  const state = { look: { lamp: 'green' }, owned: {}, sessions: [] };
  assert.equal(Help.explain(state, [], { busy: { busy: null } }).busy, undefined);
  assert.match(Help.explain(state, [], { busy: { busy: false, reasons: [] } }).busy.text, /Busy detection is on/);
  const busy = Help.explain(state, [], { busy: { busy: true, reasons: ['Calendar'], until: 5 } }).busy;
  assert.deepEqual([busy.busy, busy.until], [true, 5]);
  assert.match(busy.text, /busy \(Calendar\)/);
  assert.equal(Help.explain({ ...state, away: { headline: '1 done' } }, []).away, '1 done');
});

test('ICS fetch refuses redirects off HTTPS and follows HTTPS ones', async () => {
  const { fetchHttpsOnly } = require('../src/busy-watch.js');
  const resp = (status, location) => ({ status, ok: status < 300, headers: { get: (h) => (h === 'location' ? location : null) } });
  const routes = {
    'https://a.test/cal.ics': resp(302, 'https://b.test/cal.ics'),
    'https://b.test/cal.ics': resp(200),
    'https://c.test/cal.ics': resp(301, 'http://evil.test/cal.ics'),
    'https://d.test/cal.ics': resp(302, '/loop'),
    'https://d.test/loop': resp(302, '/loop'),
  };
  const fake = async (u, opts) => { assert.equal(opts.redirect, 'manual'); return routes[u]; };
  assert.equal((await fetchHttpsOnly('https://a.test/cal.ics', null, fake)).status, 200);
  await assert.rejects(fetchHttpsOnly('https://c.test/cal.ics', null, fake), /off HTTPS/);
  await assert.rejects(fetchHttpsOnly('https://d.test/cal.ics', null, fake), /too many redirects/);
});
