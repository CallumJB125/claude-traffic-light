// Notification controls: snooze, quiet hours and per-project mute. All three
// only decide whether a sound, a macOS notification or a knock may happen;
// none of them touches the resolved light state. Pure: the clock is `now`
// (ms) and local time comes from it, so tests inject both.
const MIN = 60000;
const HOUR = 60 * MIN;

const SNOOZES = Object.freeze({ '15m': '15 minutes', '1h': '1 hour', tomorrow: 'until tomorrow' });
const TOMORROW_HOUR = 8;

// A snooze's end time. "Until tomorrow" is 08:00 local the next morning.
function snoozeEnd(kind, now) {
  if (kind === '15m') return now + 15 * MIN;
  if (kind === '1h') return now + HOUR;
  if (kind === 'tomorrow') {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, TOMORROW_HOUR, 0, 0, 0).getTime();
  }
  return null;
}

const toMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof hhmm === 'string' ? hhmm : '');
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
};

// Quiet hours: { enabled, start: 'HH:MM', end: 'HH:MM', days: [0..6] } where
// days (0 = Sunday) are the days a quiet period STARTS on, so a Friday
// 22:00-07:00 spell runs into Saturday morning. start === end is empty.
function normalizeQuietHours(q) {
  const o = q && typeof q === 'object' ? q : {};
  const days = Array.isArray(o.days) ? [...new Set(o.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [0, 1, 2, 3, 4, 5, 6];
  return {
    enabled: o.enabled === true,
    start: toMinutes(o.start) === null ? '22:00' : o.start,
    end: toMinutes(o.end) === null ? '07:00' : o.end,
    days,
  };
}

function inQuietHours(q, now) {
  const c = normalizeQuietHours(q);
  if (!c.enabled) return false;
  const s = toMinutes(c.start), e = toMinutes(c.end);
  if (s === e) return false;
  const d = new Date(now);
  const at = d.getHours() * 60 + d.getMinutes();
  const today = d.getDay();
  if (s < e) return at >= s && at < e && c.days.includes(today);
  if (at >= s) return c.days.includes(today);
  return at < e && c.days.includes((today + 6) % 7);
}

const norm = (p) => String(p || '').replace(/\/+$/, '');
// A muted entry is a folder path (the project and everything under it) or a
// bare folder / repo name (the last path part of the session's cwd, or any
// part of it).
function projectMuted(list, cwd) {
  const dir = norm(cwd);
  if (!dir || !Array.isArray(list)) return false;
  const parts = dir.split('/').filter(Boolean);
  return list.some((raw) => {
    const e = norm(typeof raw === 'string' ? raw.trim() : '');
    if (!e) return false;
    if (e.includes('/')) return dir === e || dir.startsWith(`${e}/`);
    return parts.includes(e);
  });
}

// Why a ping must stay quiet right now, or null. Order: a project mute is
// permanent and personal, a snooze is explicit, quiet hours are the schedule.
function reason(config, { now, cwd = null } = {}) {
  const c = config || {};
  if (cwd && projectMuted(c.mutedProjects, cwd)) return 'project';
  if (Number.isFinite(c.snoozeUntil) && now < c.snoozeUntil) return 'snooze';
  if (inQuietHours(c.quietHours, now)) return 'quiet-hours';
  return null;
}

// Every live session sits in a muted project (and there is at least one): the
// alert sound, which belongs to the resolved look rather than one session.
function allMuted(config, sessions) {
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.cwd);
  return list.length > 0 && list.every((s) => projectMuted(config && config.mutedProjects, s.cwd));
}

// A "needs input" ask held back by snooze or quiet hours still shows a silent
// badge (a count), never a sound or a notification.
const badgeFor = (why, kind) => kind === 'permission-ask' && why !== null;

function snoozeLabel(until, now) {
  if (!Number.isFinite(until) || until <= now) return null;
  const left = until - now;
  if (left < HOUR) return `Snoozed for ${Math.max(1, Math.ceil(left / MIN))} more min`;
  const d = new Date(until);
  return `Snoozed until ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

module.exports = { SNOOZES, snoozeEnd, normalizeQuietHours, inQuietHours, projectMuted, reason, allMuted, badgeFor, snoozeLabel };
