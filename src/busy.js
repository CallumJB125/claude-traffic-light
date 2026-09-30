// Busy or free, and what happened meanwhile. Pure: src/busy-watch.js does the
// I/O (the EventKit helper, the ICS fetch, the Focus files) and feeds it here.
//
// Every source reduces to occurrences { start, end, allDay, availability,
// cancelled, declined } (ms since epoch) or a Focus reading { focused, mode },
// so the calendar app and an ICS feed are judged by the same rules.

// ── Is now busy? ────────────────────────────────────────────────────────────
// Availability is honoured as the calendar app shows it: free and cancelled
// events never hold pings, nor do ones you declined. An all-day event only
// counts when it is explicitly marked busy (an out-of-office day), since most
// all-day entries are birthdays, holidays and reminders.
function blocks(o) {
  if (!o || o.cancelled || o.declined) return false;
  if (o.availability === 'free') return false;
  if (o.allDay) return o.availability === 'busy' || o.availability === 'unavailable';
  return true;
}

// title only appears when the source was allowed to read titles.
function busyAt(occurrences, now) {
  let until = null;
  let title = null;
  for (const o of occurrences || []) {
    if (!blocks(o) || !(o.start <= now && now < o.end)) continue;
    until = Math.max(until || 0, o.end);
    if (o.title && !title) title = String(o.title).slice(0, 60);
  }
  return until ? { busy: true, until, title } : { busy: false, until: null, title: null };
}

// The next time a busy spell starts (for Settings' "next: 14:00").
function nextBusy(occurrences, now) {
  let next = null;
  for (const o of occurrences || []) if (blocks(o) && o.start > now && (next === null || o.start < next)) next = o.start;
  return next;
}

// ── Focus ───────────────────────────────────────────────────────────────────
// ~/Library/DoNotDisturb/DB/Assertions.json holds the Focus you turned on by
// hand (Control Centre, a Shortcut, another device when shared). Focus that a
// schedule or automation turned on is not written there; the Shortcut source
// covers that.
function parseFocusAssertions(text, modesText = null) {
  let data;
  try { data = JSON.parse(text); } catch { return { focused: false, error: 'unreadable' }; }
  const store = Array.isArray(data && data.data) ? data.data[0] || {} : {};
  const records = Array.isArray(store.storeAssertionRecords) ? store.storeAssertionRecords : [];
  if (!records.length) return { focused: false, mode: null };
  const id = records[records.length - 1]?.assertionDetails?.assertionDetailsModeIdentifier || null;
  let mode = null;
  if (id && modesText) {
    try { mode = JSON.parse(modesText).data[0].modeConfigurations[id].mode.name || null; } catch { mode = null; }
  }
  return { focused: true, mode: mode || (id ? String(id).split('.').pop() : null) };
}

// What a "Get Current Focus" Shortcut printed: nothing (or a no-focus word)
// when no Focus is on, the Focus's name when one is.
function parseFocusShortcut(text) {
  const t = String(text || '').trim();
  if (!t || /^(none|no focus|off|false|0|null)$/i.test(t)) return { focused: false, mode: null };
  return { focused: true, mode: t.split('\n')[0].slice(0, 40) };
}

// ── Combining sources ───────────────────────────────────────────────────────
// readings: { calendar?, ics?, focus? }, each { on, busy, until?, mode? } or
// undefined. Busy if any enabled source says so; null when nothing is on.
function combine(readings) {
  const on = Object.entries(readings || {}).filter(([, r]) => r && r.on);
  if (!on.length) return { busy: null, reasons: [], until: null };
  const reasons = [];
  let until = null;
  for (const [src, r] of on) {
    if (!r.busy) continue;
    const name = src === 'focus' ? 'Focus' : src === 'ics' ? 'Calendar feed' : src === 'fake' ? 'Test' : 'Calendar';
    const what = src === 'focus' || src === 'fake' ? r.mode : r.title;
    reasons.push(what ? `${name}: ${what}` : name);
    if (r.until) until = Math.max(until || 0, r.until);
  }
  return { busy: reasons.length > 0, reasons, until: reasons.length ? until : null };
}

// ── ICS ─────────────────────────────────────────────────────────────────────
function unfold(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  const p = {};
  for (const kv of params) { const i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1).replace(/^"|"$/g, ''); }
  return { name: name.toUpperCase(), params: p, value: line.slice(colon + 1) };
}

// Outlook and Exchange feeds name zones the Windows way. A subset of CLDR's
// windowsZones.xml (the "001" territory row of each), covering the zones
// such feeds actually use; anything else still falls back to local time.
const WINDOWS_TZ = {
  'Dateline Standard Time': 'Etc/GMT+12', 'Hawaiian Standard Time': 'Pacific/Honolulu', 'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles', 'US Mountain Standard Time': 'America/Phoenix', 'Mountain Standard Time': 'America/Denver',
  'Central America Standard Time': 'America/Guatemala', 'Central Standard Time': 'America/Chicago', 'Canada Central Standard Time': 'America/Regina',
  'Central Standard Time (Mexico)': 'America/Mexico_City', 'SA Pacific Standard Time': 'America/Bogota', 'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis', 'Atlantic Standard Time': 'America/Halifax', 'SA Western Standard Time': 'America/La_Paz',
  'Newfoundland Standard Time': 'America/St_Johns', 'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Buenos_Aires',
  'SA Eastern Standard Time': 'America/Cayenne', 'Pacific SA Standard Time': 'America/Santiago', 'UTC': 'Etc/UTC', 'Coordinated Universal Time': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris', 'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos', 'GTB Standard Time': 'Europe/Bucharest', 'E. Europe Standard Time': 'Europe/Chisinau',
  'Egypt Standard Time': 'Africa/Cairo', 'South Africa Standard Time': 'Africa/Johannesburg', 'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem', 'Namibia Standard Time': 'Africa/Windhoek', 'Turkey Standard Time': 'Europe/Istanbul',
  'Arab Standard Time': 'Asia/Riyadh', 'Arabic Standard Time': 'Asia/Baghdad', 'E. Africa Standard Time': 'Africa/Nairobi',
  'Russian Standard Time': 'Europe/Moscow', 'Iran Standard Time': 'Asia/Tehran', 'Arabian Standard Time': 'Asia/Dubai',
  'Mauritius Standard Time': 'Indian/Mauritius', 'Afghanistan Standard Time': 'Asia/Kabul', 'Pakistan Standard Time': 'Asia/Karachi',
  'West Asia Standard Time': 'Asia/Tashkent', 'India Standard Time': 'Asia/Calcutta', 'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Katmandu', 'Bangladesh Standard Time': 'Asia/Dhaka', 'Myanmar Standard Time': 'Asia/Rangoon',
  'SE Asia Standard Time': 'Asia/Bangkok', 'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei', 'W. Australia Standard Time': 'Australia/Perth', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul', 'Cen. Australia Standard Time': 'Australia/Adelaide', 'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane', 'AUS Eastern Standard Time': 'Australia/Sydney', 'Tasmania Standard Time': 'Australia/Hobart',
  'West Pacific Standard Time': 'Pacific/Port_Moresby', 'New Zealand Standard Time': 'Pacific/Auckland', 'Fiji Standard Time': 'Pacific/Fiji',
  'Tonga Standard Time': 'Pacific/Tongatapu', 'Azores Standard Time': 'Atlantic/Azores', 'Morocco Standard Time': 'Africa/Casablanca',
};
function ianaZone(tzid) {
  const id = String(tzid || '').trim().replace(/^"|"$/g, '');
  if (!id) return null;
  if (WINDOWS_TZ[id]) return WINDOWS_TZ[id];
  // "/mozilla.org/20050126_1/Europe/London"-style prefixes (older Lightning/Evolution exports)
  const m = /([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(id);
  return m && id.startsWith('/') ? m[1] : id;
}

// Wall-clock fields in a time zone → epoch ms. tz null = floating (this
// machine's local time); a zone Intl doesn't know falls back to local time
// too, rather than dropping the event. One formatter per zone: building
// Intl.DateTimeFormat is the expensive part.
const formatters = new Map();
function formatterFor(tz) {
  if (!formatters.has(tz)) {
    let f = null;
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch { f = null; }
    formatters.set(tz, f);
  }
  return formatters.get(tz);
}
function tzOffset(f, t) {
  const p = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
function wallToEpoch(w, tz) {
  if (tz === 'UTC') return Date.UTC(w.y, w.m, w.d, w.h, w.mi, w.s);
  const f = tz ? formatterFor(tz) : null;
  if (f) {
    // Twice: the offset at the guess can differ from the offset at the answer near a DST change.
    const guess = Date.UTC(w.y, w.m, w.d, w.h, w.mi, w.s);
    return guess - tzOffset(f, guess - tzOffset(f, guess));
  }
  return new Date(w.y, w.m, w.d, w.h, w.mi, w.s).getTime();
}

function parseDate(prop) {
  if (!prop) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(prop.value.trim());
  if (!m) return null;
  const allDay = !m[4] || prop.params.VALUE === 'DATE';
  const w = { y: +m[1], m: +m[2] - 1, d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  const tz = allDay ? null : m[7] ? 'UTC' : ianaZone(prop.params.TZID);
  return { w, tz, allDay, t: wallToEpoch(w, tz) };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// Raw VEVENTs: only what decides busy/free (and the title, which the caller
// drops unless the user opted in).
function parseICS(text, { titles = true } = {}) {
  const events = [];
  let ev = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { ev = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (ev && ev.start) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'UID') ev.uid = p.value;
    else if (p.name === 'DTSTART') ev.start = parseDate(p);
    else if (p.name === 'DTEND') ev.end = parseDate(p);
    else if (p.name === 'DURATION') ev.duration = parseDuration(p.value);
    else if (p.name === 'RRULE') ev.rrule = p.value;
    else if (p.name === 'EXDATE') for (const v of p.value.split(',')) { const d = parseDate({ value: v, params: p.params }); if (d) ev.exdates.push(d.t); }
    else if (p.name === 'RECURRENCE-ID') ev.recurrenceId = parseDate(p);
    else if (p.name === 'TRANSP') ev.transp = p.value.trim().toUpperCase();
    else if (p.name === 'STATUS') ev.status = p.value.trim().toUpperCase();
    else if (p.name === 'X-MICROSOFT-CDO-BUSYSTATUS') ev.msBusy = p.value.trim().toUpperCase();
    else if (p.name === 'SUMMARY' && titles) ev.title = p.value.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ');
  }
  return events;
}

// Opaque unless it says otherwise; an all-day entry needs to say so outright.
function icsAvailability(ev) {
  if (ev.msBusy === 'FREE' || ev.transp === 'TRANSPARENT') return 'free';
  if (ev.msBusy === 'TENTATIVE') return 'tentative';
  if (ev.msBusy === 'OOF') return 'unavailable';
  if (ev.start && ev.start.allDay) return ev.transp === 'OPAQUE' || ev.msBusy === 'BUSY' ? 'busy' : 'free';
  return 'busy';
}

const DAY_MS = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseRRule(s) {
  const r = {};
  for (const part of String(s || '').split(';')) { const [k, v] = part.split('='); if (k && v) r[k.toUpperCase()] = v; }
  return {
    freq: r.FREQ,
    interval: Math.max(1, Number(r.INTERVAL) || 1),
    count: r.COUNT ? Number(r.COUNT) : null,
    until: r.UNTIL ? parseDate({ value: r.UNTIL, params: {} })?.t ?? null : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map((x) => { const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x.trim()); return m ? { n: m[1] ? Number(m[1]) : null, wd: WEEKDAYS.indexOf(m[2]) } : null; }).filter(Boolean) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
    wkst: WEEKDAYS.indexOf(r.WKST || 'MO'),
  };
}

// Calendar days as UTC midnights, so stepping never meets DST.
const dayNum = (w) => Date.UTC(w.y, w.m, w.d) / DAY_MS;
const fromDayNum = (n, w) => { const d = new Date(n * DAY_MS); return { ...w, y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; };
const weekdayOf = (n) => new Date(n * DAY_MS).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

function monthDays(y, m, rule, startW) {
  const n = daysInMonth(y, m);
  if (rule.byday && rule.byday.length) {
    const out = [];
    for (const { n: ord, wd } of rule.byday) {
      const all = [];
      for (let d = 1; d <= n; d += 1) if (new Date(Date.UTC(y, m, d)).getUTCDay() === wd) all.push(d);
      if (ord === null) out.push(...all);
      else { const pick = ord > 0 ? all[ord - 1] : all[all.length + ord]; if (pick) out.push(pick); }
    }
    return out.sort((a, b) => a - b);
  }
  const days = rule.bymonthday || [startW.d];
  return days.map((d) => (d < 0 ? n + d + 1 : d)).filter((d) => d >= 1 && d <= n).sort((a, b) => a - b);
}

// Every start (wall-clock fields) the rule produces, in order, from DTSTART,
// or from fromDay on when the caller doesn't need to count (no COUNT): a
// weekly meeting from 2019 then costs a few days of stepping, not seven
// years of it. Each step re-checks the interval against DTSTART, so where it
// starts can't shift the pattern. Capped so a malformed feed can't spin.
function* ruleStarts(startW, rule, stopAfterDay, fromDay = -Infinity) {
  const first = dayNum(startW);
  const LIMIT = 50000;
  let steps = 0;
  if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
    const weekStart = first - ((weekdayOf(first) - rule.wkst + 7) % 7);
    const days = rule.freq === 'WEEKLY' && rule.byday ? rule.byday.map((b) => b.wd) : rule.freq === 'WEEKLY' ? [weekdayOf(first)] : null;
    for (let n = Math.max(first, fromDay); n <= stopAfterDay && steps < LIMIT; n += 1, steps += 1) {
      if (rule.freq === 'DAILY') {
        if ((n - first) % rule.interval) continue;
        if (rule.byday && !rule.byday.some((b) => b.wd === weekdayOf(n))) continue;
      } else {
        if (Math.floor((n - weekStart) / 7) % rule.interval) continue;
        if (!days.includes(weekdayOf(n))) continue;
      }
      yield fromDayNum(n, startW);
    }
    return;
  }
  if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') {
    const monthStep = rule.freq === 'MONTHLY' ? rule.interval : 12 * rule.interval;
    let skip = 0;
    if (fromDay > first) {
      const d = new Date(fromDay * DAY_MS);
      const months = (d.getUTCFullYear() - startW.y) * 12 + (d.getUTCMonth() - startW.m) - 1;
      if (months > 0) skip = Math.floor(months / monthStep) * monthStep;
    }
    for (let i = skip; steps < LIMIT; i += monthStep, steps += 1) {
      const y = startW.y + Math.floor((startW.m + i) / 12);
      const m = (startW.m + i) % 12;
      if (Date.UTC(y, m, 1) / DAY_MS > stopAfterDay) return;
      for (const d of monthDays(y, m, rule, startW)) {
        const w = { ...startW, y, m, d };
        if (dayNum(w) >= first) yield w;
      }
    }
  }
}

// Occurrences overlapping [from, to]. Moved or edited instances of a series
// (RECURRENCE-ID) replace the instance they came from.
function expandICS(events, from, to, { titles = false } = {}) {
  const out = [];
  const overrides = new Map();
  for (const ev of events) if (ev.recurrenceId && ev.uid) overrides.set(`${ev.uid}|${ev.recurrenceId.t}`, true);
  const push = (ev, start, end) => {
    if (end <= from || start >= to) return;
    const o = { start, end, allDay: ev.start.allDay, availability: icsAvailability(ev), cancelled: ev.status === 'CANCELLED', declined: false };
    if (titles && ev.title) o.title = ev.title;
    out.push(o);
  };
  for (const ev of events) {
    const len = ev.end ? ev.end.t - ev.start.t : ev.duration != null ? ev.duration : ev.start.allDay ? DAY_MS : 0;
    if (!ev.rrule || ev.recurrenceId) { push(ev, ev.start.t, ev.start.t + len); continue; }
    const rule = parseRRule(ev.rrule);
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) { push(ev, ev.start.t, ev.start.t + len); continue; }
    const stopAfterDay = Math.floor(to / DAY_MS) + 1;
    // Occurrences that could still overlap `from`: back off by the event's length and a day for time zones.
    const fromDay = rule.count === null ? Math.floor((from - Math.max(0, len)) / DAY_MS) - 2 : -Infinity;
    let n = 0;
    for (const w of ruleStarts(ev.start.w, rule, stopAfterDay, fromDay)) {
      const t = wallToEpoch(w, ev.start.tz);
      if (rule.until !== null && t > rule.until) break;
      n += 1;
      if (rule.count !== null && n > rule.count) break;
      if (t >= to) break;
      if (ev.exdates.includes(t) || (ev.uid && overrides.has(`${ev.uid}|${t}`))) continue;
      push(ev, t, t + len);
    }
  }
  return out;
}

// ── While you were away ─────────────────────────────────────────────────────
// A plain, serialisable record of a busy spell, so the widget shows it now
// and the phone (F6) can read the same file later. v bumps on any shape
// change a reader would care about.
const RECAP_VERSION = 1;
const folderOf = (cwd) => String(cwd || '').split('/').filter(Boolean).pop() || '';

// What a session's move from one signal to another means for the recap.
function awayKind(prev, next) {
  if (next === prev) return null;
  if (next === 'permission-ask' || next === 'limit-hit') return 'needs-you';
  if (next === 'turn-failed') return 'failed';
  if (next === 'stop') return 'done';
  return null;
}

function startAway(now, reasons = [], sessions = []) {
  return { v: RECAP_VERSION, from: now, reasons: reasons.slice(0, 3), seen: Object.fromEntries(sessions.filter((s) => s && s.sessionId).map((s) => [s.sessionId, s.signal])), items: [], held: [] };
}

// A ping (sound, notification, knock) that waited because you were busy:
// counted per rule and signal, so the recap can say what was held back.
function noteHeld(log, { rule = null, signal = null } = {}, now = Date.now()) {
  if (!log) return log;
  if (!Array.isArray(log.held)) log.held = [];
  const name = String(rule || signal || 'a ping').slice(0, 40);
  const hit = log.held.find((h) => h.rule === name && h.signal === (signal || null));
  if (hit) { hit.count += 1; hit.last = now; } else log.held.push({ rule: name, signal: signal || null, count: 1, last: now });
  return log;
}

// sessions: the live list at this tick. Each session keeps its latest
// outcome; a later "done" replaces an earlier ask it has since got past.
function noteAway(log, sessions, now) {
  if (!log) return log;
  for (const s of sessions || []) {
    if (!s || !s.sessionId) continue;
    const kind = awayKind(log.seen[s.sessionId], s.signal);
    log.seen[s.sessionId] = s.signal;
    if (!kind) continue;
    const item = {
      kind, sessionId: s.sessionId, cwd: s.cwd || null, folder: folderOf(s.cwd), hostApp: s.hostApp || null, source: s.source || 'claude', at: now,
      detail: kind === 'needs-you' ? (s.signal === 'limit-hit' ? 'usage limit' : s.askKind === 'question' ? 'question' : s.tool ? `permission for ${s.tool}` : 'permission') : kind === 'failed' ? (s.failKind || 'error') : null,
    };
    log.items = log.items.filter((x) => x.sessionId !== s.sessionId).concat(item);
  }
  return log;
}

function plural(n, one, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

// The finished recap; stillOpen marks items whose session is still waiting
// on you when you come back, so the widget can lead with those.
function finishAway(log, now, sessions = []) {
  if (!log) return null;
  const live = new Map((sessions || []).map((s) => [s.sessionId, s.signal]));
  const items = log.items.map((x) => ({ ...x, open: x.kind === 'needs-you' ? ['permission-ask', 'limit-hit'].includes(live.get(x.sessionId)) : false }));
  const order = { 'needs-you': 0, failed: 1, done: 2 };
  items.sort((a, b) => (order[a.kind] - order[b.kind]) || (b.at - a.at));
  const counts = { done: 0, needsYou: 0, failed: 0 };
  for (const x of items) counts[x.kind === 'needs-you' ? 'needsYou' : x.kind] += 1;
  const parts = [];
  if (counts.done) parts.push(`${counts.done} done`);
  if (counts.needsYou) {
    const first = items.find((x) => x.kind === 'needs-you');
    parts.push(`${counts.needsYou} need${counts.needsYou === 1 ? 's' : ''} you${first ? ` (${first.detail} on ${first.folder || 'a session'})` : ''}`);
  }
  if (counts.failed) parts.push(`${plural(counts.failed, 'failure')}`);
  const heldPings = (Array.isArray(log.held) ? log.held : []).map((h) => ({ rule: h.rule, signal: h.signal, count: h.count })).sort((a, b) => b.count - a.count);
  const held = heldPings.reduce((n, h) => n + h.count, 0);
  if (held) parts.push(`${plural(held, 'ping')} held`);
  return {
    v: RECAP_VERSION, from: log.from, to: now, reasons: log.reasons, held, heldPings,
    counts, items, headline: parts.length ? parts.join(' · ') : 'Nothing happened',
  };
}

module.exports = { blocks, busyAt, nextBusy, parseFocusAssertions, parseFocusShortcut, combine, parseICS, expandICS, parseRRule, wallToEpoch, icsAvailability, RECAP_VERSION, awayKind, startAway, noteAway, noteHeld, finishAway, WINDOWS_TZ, ianaZone };
