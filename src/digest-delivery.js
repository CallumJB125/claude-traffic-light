'use strict';

// Optional digest delivery: a Slack incoming webhook and a macOS notification,
// both off until set up, each sent at most once per slot. A slot is one local
// day (daily) or one Monday (weekly), and its key is saved before sending, so
// a restart or a slow send can never post the same digest twice. The webhook
// URL is sealed with the OS keychain (safeStorage) and only its last four
// characters are ever shown again.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SETTINGS_FILE = 'digest.json';
const WEBHOOK_FILE = 'digest-webhook.json';
const CHANNELS = ['slack', 'notify'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SLACK_PATH = /^\/services\/[A-Za-z0-9]{6,20}\/[A-Za-z0-9]{6,20}\/[A-Za-z0-9]{16,64}$/;
const SEND_TIMEOUT_MS = 10000;
const DEFAULTS = Object.freeze({ period: 'day', time: '18:00', slack: false, notify: false, tail: null, previewed: false, sent: {}, failed: null });
const TEST_TEXT = 'Plexiform test message: your digest will be posted here.';

function validateWebhook(raw) {
  const bad = (error) => ({ ok: false, error });
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 400) return bad('Paste the Slack webhook link that starts with https://hooks.slack.com/services/.');
  let u;
  try { u = new URL(raw.trim()); } catch { return bad('That is not a link. Paste the Slack webhook link that starts with https://hooks.slack.com/services/.'); }
  if (u.protocol !== 'https:') return bad('Slack webhook links start with https://. Plain http is not accepted.');
  if (u.hostname !== 'hooks.slack.com' || u.port || u.username || u.password) return bad('Only Slack incoming webhooks (hooks.slack.com) are accepted.');
  if (!SLACK_PATH.test(u.pathname) || u.search || u.hash) return bad('That does not look like a Slack incoming webhook. It should look like https://hooks.slack.com/services/T…/B…/….');
  return { ok: true, url: u.href };
}

const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// The slot `now` falls in, or null before the chosen time (or not on a Monday for weekly).
function slotOf(settings, now) {
  const m = TIME.exec(settings.time) || TIME.exec(DEFAULTS.time);
  const d = new Date(now);
  if (settings.period === 'week' && d.getDay() !== 1) return null;
  if (d.getHours() * 60 + d.getMinutes() < Number(m[1]) * 60 + Number(m[2])) return null;
  return `${settings.period}:${localDay(now)}`;
}

function due(settings, now) {
  const slot = slotOf(settings, now);
  if (!slot) return [];
  return CHANNELS.filter((ch) => settings[ch] === true && settings.sent?.[ch] !== slot).map((ch) => ({ channel: ch, slot }));
}

function sanitize(v) {
  const s = v && typeof v === 'object' ? v : {};
  const sent = {};
  for (const ch of CHANNELS) if (typeof s.sent?.[ch] === 'string' && s.sent[ch].length <= 40) sent[ch] = s.sent[ch];
  return {
    period: s.period === 'week' ? 'week' : 'day',
    time: typeof s.time === 'string' && TIME.test(s.time) ? s.time : DEFAULTS.time,
    slack: s.slack === true, notify: s.notify === true,
    tail: typeof s.tail === 'string' && /^[A-Za-z0-9]{4}$/.test(s.tail) ? s.tail : null,
    previewed: s.previewed === true,
    sent,
    failed: s.failed && typeof s.failed.error === 'string' ? { at: Number(s.failed.at) || 0, error: s.failed.error.slice(0, 200) } : null,
  };
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

async function post(fetch, url, text) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), redirect: 'error', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }); // privacy-flow: digest-slack
  if (!res.ok) throw new Error(`Slack did not accept the message (HTTP ${res.status}).`);
  return true;
}

/**
 * dir: where digest.json and the sealed webhook live. seal/unseal: the OS
 * keychain. fetch: the network (only ever called with a validated Slack URL).
 * digest(period) → a composed digest. notify(digest) shows the notification.
 */
function createDelivery({ dir, seal, unseal, fetch, digest, notify = () => {}, now = Date.now, log = () => {} }) {
  const settingsFile = path.join(dir, SETTINGS_FILE), webhookFile = path.join(dir, WEBHOOK_FILE);
  let busy = false;
  const read = () => { try { return sanitize(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch { return sanitize(null); } };
  const write = (s) => { const v = sanitize(s); writeAtomic(settingsFile, v); return v; };
  const webhook = () => {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(webhookFile, 'utf8')); } catch { return null; }
    const url = unseal(Buffer.from(String(raw?.data ?? ''), 'base64'));
    const v = validateWebhook(url);
    return v.ok ? v.url : null;
  };
  const view = () => { const s = read(); return { period: s.period, time: s.time, slack: s.slack, notify: s.notify, webhook: s.tail ? { tail: s.tail } : null, previewed: s.previewed, failed: s.failed }; };

  async function sendSlack(text) {
    const url = webhook();
    if (!url) throw new Error('No Slack webhook is saved.');
    return post(fetch, url, text);
  }

  async function tick() {
    if (busy) return [];
    busy = true;
    const done = [];
    try {
      let s = read();
      for (const { channel, slot } of due(s, now())) {
        s = write({ ...s, sent: { ...s.sent, [channel]: slot } });
        try {
          const d = await digest(s.period);
          if (channel === 'slack') await sendSlack(d.slack);
          else notify(d);
          done.push(channel);
        } catch (err) {
          log(`[digest] ${channel}: ${err?.message ?? err}`);
          s = write({ ...read(), failed: { at: now(), error: channel === 'slack' ? String(err?.message ?? err) : 'The notification could not be shown.' } });
        }
      }
    } finally { busy = false; }
    return done;
  }

  return {
    settings: view,
    validate: validateWebhook,
    saveWebhook(raw) {
      const v = validateWebhook(raw);
      if (!v.ok) return v;
      writeAtomic(webhookFile, { v: 1, data: Buffer.from(seal(v.url)).toString('base64') });
      write({ ...read(), tail: v.url.slice(-4), slack: false, previewed: false, failed: null });
      return { ok: true, settings: view() };
    },
    removeWebhook() {
      try { fs.rmSync(webhookFile, { force: true }); } catch { /* already gone */ }
      write({ ...read(), tail: null, slack: false, previewed: false });
      return { ok: true, settings: view() };
    },
    async preview() {
      const s = read();
      const d = await digest(s.period);
      write({ ...s, previewed: true });
      return { text: d.slack, plain: d.text, settings: view() };
    },
    // Turning Slack on needs a saved webhook and a preview first; turning anything off always works.
    set(patch) {
      const p = patch && typeof patch === 'object' ? patch : {};
      const s = read();
      const next = { ...s };
      if (p.period === 'day' || p.period === 'week') { next.period = p.period; if (p.period !== s.period) next.previewed = false; }
      if (typeof p.time === 'string') { if (!TIME.test(p.time)) return { ok: false, error: 'Choose a time like 09:00.' }; next.time = p.time; }
      if (typeof p.notify === 'boolean') next.notify = p.notify;
      if (p.slack === false) next.slack = false;
      if (p.slack === true) {
        if (!s.tail || !webhook()) return { ok: false, error: 'Save a Slack webhook first.' };
        if (!next.previewed) return { ok: false, error: 'Look at what will be sent before turning this on.' };
        next.slack = true;
      }
      // A channel turned on after today's time has passed starts tomorrow, not straight away.
      for (const ch of CHANNELS) if (next[ch] && !s[ch]) { const slot = slotOf(next, now()); if (slot) next.sent = { ...next.sent, [ch]: slot }; }
      write({ ...next, failed: null });
      return { ok: true, settings: view() };
    },
    async test() {
      try { await sendSlack(TEST_TEXT); return { ok: true }; } catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    tick,
    start(everyMs = 60000) {
      const t = setInterval(() => { tick().catch(() => {}); }, everyMs);
      t.unref?.();
      setTimeout(() => { tick().catch(() => {}); }, 5000).unref?.();
      return () => clearInterval(t);
    },
  };
}

module.exports = { createDelivery, validateWebhook, due, slotOf, sanitize, post, localDay, TEST_TEXT, SETTINGS_FILE, WEBHOOK_FILE };
