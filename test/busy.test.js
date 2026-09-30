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

test('default locked rules still ping while busy; finished and nudges wait', () => {
  const byId = Object.fromEntries(R.defaultRules().map((r) => [r.id, R.normalizeRule(r)]));
  for (const id of ['limit', 'permission', 'offline']) assert.equal(R.pingsWhileBusy(byId[id]), true, id);
  for (const id of ['done', 'nudge', 'failed-turn', 'working']) assert.equal(R.pingsWhileBusy(byId[id]), false, id);
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
  const out = expand(ics(['UID:w', 'DTSTART;TZID=South Africa Standard Time:20260930T090000', 'DTEND;TZID=South Africa Standard Time:20260930T100000']), '2026-09-29T00:00:00Z', '2026-10-02T00:00:00Z');
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
  const w = busyWatch({
    rootDir: '/buddy', home: '/home', helperPath: '/app/buddy-calendar',
    loadConfig: () => config, isDevRun: !!over.isDevRun, fakeFile: over.fakeFile || null,
    exec, readFile, writeFile: (f, t) => files.set(f, t), exists: (f) => files.has(f) || (f === '/app/buddy-calendar' && over.helper !== null),
    fetch: over.fetch || (async () => { throw new Error('no network in tests'); }),
    now: () => clock, onChange: () => { changes += 1; },
  });
  return { w, calls, files, helperState, advance: (ms) => { clock += ms; }, setConfig: (c) => { config = { ...config, ...c }; }, changes: () => changes };
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
  assert.deepEqual(r.calls.map((c) => c[1]), ['status', 'request', 'status', 'events']);
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
    fetch: async (url) => { assert.equal(url, 'https://cal.example/private.ics'); if (fail) throw new Error('offline'); return { ok: true, status: 200, text: async () => feed }; },
  });
  await r.w.tick();
  assert.equal(r.w.env().busy, true);
  assert.deepEqual(JSON.parse(r.files.get('/buddy/busy-ics-cache.json')), { url: 'https://cal.example/private.ics', text: feed });
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
  const bad = rig({ config: { busyCalendar: false, busyIcsUrl: 'file:///etc/passwd' } });
  await bad.w.tick();
  assert.equal(bad.w.status().ics.on, false);
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
  assert.deepEqual(viaShortcut.calls, [['shortcuts', 'run', 'Buddy Focus']]);
  assert.deepEqual([viaShortcut.w.env().busy, viaShortcut.w.status().focus.mode], [true, 'Work']);
});

test('watch: the recap arrives once when a busy spell ends, then back-from-busy holds briefly', async () => {
  const r = rig({ helper: { status: 'fullAccess', events: [meeting] } });
  await r.w.tick();
  const s = (signal) => [{ sessionId: 'a', cwd: '/w/api', signal, tool: 'Bash' }];
  assert.equal(r.w.observe(s('tool-use')), null);
  r.w.noteHeld();
  assert.equal(r.w.observe(s('stop')), null);
  r.advance(31 * 60000); // meeting over at 11:00
  r.advance(60000);
  await r.w.tick();
  assert.equal(r.w.env().busy, false);
  const recap = r.w.observe(s('stop'));
  assert.equal(recap.headline, '1 done');
  assert.equal(recap.held, 1);
  assert.equal(r.w.observe(s('stop')), null, 'only once');
  assert.equal(JSON.parse(r.files.get('/buddy/away.json')).headline, '1 done');
  assert.equal(r.w.recap().headline, '1 done');
  assert.equal(r.w.env().backFromBusy, true);
  r.advance(busyWatch.BACK_MS);
  assert.equal(r.w.env().backFromBusy, false);
  r.w.dismiss();
  assert.equal(r.w.recap(), null);
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
