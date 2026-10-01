'use strict';
const text = (v, n = 200) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '';
const age = (value, now) => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= now + 30_000 ? Math.max(0, now - time) : null;
};
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
function availability(raw) {
  const permission = ['fullAccess', 'denied', 'restricted', 'notDetermined'].includes(raw?.calendar?.status) ? raw.calendar.status : 'unknown';
  const calendar = raw?.calendar?.on === true && permission === 'fullAccess' && !raw.calendar.error;
  const focus = raw?.focus?.on === true && ['assertions', 'shortcut'].includes(raw.focus.via) && !raw.focus.error && typeof raw.focus.focused === 'boolean';
  return { calendar: raw?.calendar?.on !== true ? 'off' : calendar ? 'available' : permission,
    focus: raw?.focus?.on !== true ? 'off' : focus ? (raw.focus.focused ? 'on' : 'off') : 'unknown',
    state: (raw?.calendar?.on === true && !calendar) || (raw?.focus?.on === true && !focus) || raw?.ics?.on === true ? 'unknown' : calendar || focus ? (raw?.busy === true ? 'busy' : 'free') : 'unknown' };
}
function createMyDayService({ work, sessions = () => [], busy = () => null, open, now = Date.now }) {
  return {
    async snapshot() {
      const result = await work(), time = now();
      const remaining = { cards: 500, decisions: 500, agents: 500 }; let truncated = false;
      const sources = (result?.sources ?? []).slice(0, 9).map(source => {
        let cut = false;
        const take = key => { const rows = source[key] ?? [], chosen = rows.slice(0, remaining[key]); if (chosen.length !== rows.length) { cut = true; truncated = true; } remaining[key] -= chosen.length; return chosen; };
        const cards = take('cards').map(row => ({ handle: row.handle, key: text(row.card.key, 100), title: text(row.card.title), board: text(row.board_name), team: text(row.team_name), start_date: date(row.card.start_date), due_date: date(row.card.due_date), state: text(row.card.run_state, 30) }));
        const decisions = take('decisions').map(row => ({ handle: row.handle, key: text(row.key, 100), title: text(row.title), board: text(row.board_name), kind: row.kind === 'permission' ? 'Permission request' : 'Question', summary: text(row.summary, 500) }));
        const agents = take('agents').map(row => ({ handle: row.handle, key: text(row.key, 100), name: text(row.ai_label, 50), state: text(row.run_state, 30), observed: row.connection === 'accepted' && Number.isFinite(row.live?.hb_age_ms) ? row.live.hb_age_ms : null, live: row.connection === 'accepted' && row.live?.green === true }));
        return { name: text(source.name), status: cut ? 'partial' : source.status, cards, decisions, agents };
      });
      const reported = sessions().slice(0, 100).filter(row => !row.remote && !row.device && !String(row.sessionId ?? '').startsWith('remote:')).map(row => {
        const elapsed = age(row.updatedAt, time);
        return { name: text(row.ai ?? row.agent ?? row.provider ?? 'Local AI', 50), label: text(row.projectName ?? row.label ?? 'Local session'), signal: text(row.signal, 40), age_ms: elapsed, freshness: elapsed == null ? 'unknown' : elapsed > 90_000 ? 'stale' : 'recent', source: 'reported' };
      });
      return { status: truncated ? 'partial' : result?.status ?? 'partial', sources, reported, availability: availability(busy()), observed_at: time };
    },
    open(handle) { return typeof handle === 'string' && handle.length <= 100 ? open(handle) : false; },
  };
}
module.exports = { createMyDayService, availability };
