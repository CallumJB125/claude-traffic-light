'use strict';
// Home's Digest card: the daily or weekly digest main composes
// (src/digest-main.js), the copy, save and email actions, and the optional
// delivery set-up (Slack webhook, notification, schedule), all off until set
// up here. textContent only; the webhook link is sent once and never shown back.
(() => {
  const api = window.homeApi?.digest;
  const section = document.getElementById('digest');
  if (!api || !section) return;
  const REFRESH_MS = 60000;
  const $ = (sel) => section.querySelector(sel);
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const button = (label, onClick, className) => { const b = node('button', label, className); b.type = 'button'; b.addEventListener('click', onClick); return b; };
  let period = 'day', delivery = null, preview = null, generation = 0;
  const say = (text) => { $('.digest-status').textContent = text; };
  const when = (s) => (s.period === 'week' ? `every Monday at ${s.time}` : `every day at ${s.time}`);

  async function act(fn, done) {
    try { const r = await fn(); if (r && r.ok === false) { if (!r.canceled) say(r.error || 'That did not work.'); return r; } if (done) say(done); return r; }
    catch { say('That did not work. Try again in a moment.'); return null; }
  }

  function renderDigest(d) {
    const out = $('.body');
    if (!d) return out.replaceChildren(node('p', 'Couldn’t build the digest just now. It tries again in a minute.', 'muted'));
    const parts = [node('p', d.title, 'digest-title')];
    for (const s of d.sections) {
      parts.push(node('h3', s.heading));
      if (s.summary) parts.push(node('p', s.summary, 'muted'));
      if (s.items.length) { const ul = node('ul', null, 'digest-list'); s.items.forEach((i) => ul.append(node('li', i))); parts.push(ul); }
    }
    if (d.team) parts.push(node('h3', 'Your team'), node('p', d.team, 'muted digest-team'), node('p', 'Shown on Home only. It is never copied into what is sent.', 'muted'));
    out.replaceChildren(...parts);
  }

  function renderActions() {
    $('.digest-actions').replaceChildren(
      button('Copy digest', () => act(() => api.copy(period, 'text'), 'Copied.'), 'primary'),
      button('Copy as Markdown', () => act(() => api.copy(period, 'markdown'), 'Copied as Markdown.')),
      button('Save as Markdown file', () => act(() => api.save(period), 'Saved.')),
      button('Copy as email', () => act(() => api.email(period), 'Opened in your mail app. Nothing is sent until you send it.')),
    );
  }

  function field(label, control) { const l = node('label', null, 'field'); l.append(node('span', label), control); return l; }

  function renderDelivery() {
    const box = $('.delivery-body'), s = delivery;
    if (!s) return box.replaceChildren(node('p', 'Delivery settings are unavailable right now.', 'muted'));
    const often = node('select');
    [['day', 'Daily'], ['week', 'Weekly (Mondays)']].forEach(([v, t]) => { const o = node('option', t); o.value = v; o.selected = s.period === v; often.append(o); });
    often.addEventListener('change', async () => { const r = await act(() => api.set({ period: often.value }), 'Saved.'); if (r?.settings) { delivery = r.settings; preview = null; renderDelivery(); } });
    const time = node('input'); time.type = 'time'; time.value = s.time;
    time.addEventListener('change', async () => { const r = await act(() => api.set({ time: time.value }), 'Saved.'); if (r?.settings) { delivery = r.settings; renderDelivery(); } });
    const schedule = node('div', null, 'delivery-row'); schedule.append(field('How often', often), field('At', time));

    const notify = node('input'); notify.type = 'checkbox'; notify.checked = s.notify;
    notify.addEventListener('change', async () => { const r = await act(() => api.set({ notify: notify.checked }), notify.checked ? `You will get a notification ${when(s)}.` : 'Notification off.'); if (r?.settings) delivery = r.settings; renderDelivery(); });
    const notifyRow = node('label', null, 'check'); notifyRow.append(notify, node('span', 'Show a macOS notification when my digest is ready'));

    const slack = node('div', null, 'delivery-slack');
    slack.append(node('h3', 'Post to Slack'));
    if (!s.webhook) {
      slack.append(node('p', 'Paste an incoming webhook link from Slack (it starts with https://hooks.slack.com/services/). It is kept in your keychain and only its last 4 characters are shown again.', 'muted'));
      const input = node('input'); input.type = 'url'; input.placeholder = 'https://hooks.slack.com/services/…'; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-label', 'Slack webhook link');
      const row = node('div', null, 'delivery-row');
      row.append(input, button('Save webhook', async () => { const r = await act(() => api.saveWebhook(input.value), 'Webhook saved.'); input.value = ''; if (r?.settings) { delivery = r.settings; renderDelivery(); } }));
      slack.append(row);
    } else {
      slack.append(node('p', `Webhook ending in ${s.webhook.tail}.`, 'muted'));
      const row = node('div', null, 'actions');
      row.append(
        button('Send test message', () => act(() => api.test(), 'Test message sent. Check your Slack channel.')),
        button('See what will be sent', async () => { const r = await act(() => api.preview()); if (r && r.ok !== false) { preview = r.text; delivery = r.settings; renderDelivery(); } }),
        button('Remove webhook', async () => { const r = await act(() => api.removeWebhook(), 'Webhook removed.'); if (r?.settings) { delivery = r.settings; preview = null; renderDelivery(); } }),
      );
      slack.append(row);
      if (preview) slack.append(node('p', 'This is exactly what will be posted (it is rebuilt with fresh numbers each time):', 'muted'), node('pre', preview, 'digest-preview'));
      const on = node('input'); on.type = 'checkbox'; on.checked = s.slack; on.disabled = !s.slack && !s.previewed;
      on.addEventListener('change', async () => { const r = await act(() => api.set({ slack: on.checked }), on.checked ? `Your digest will be posted ${when(s)}.` : 'Slack posting off.'); if (r?.settings) delivery = r.settings; renderDelivery(); });
      const onRow = node('label', null, 'check'); onRow.append(on, node('span', `Post my digest to Slack ${when(s)}`));
      slack.append(onRow);
      if (!s.slack && !s.previewed) slack.append(node('p', 'Look at what will be sent first.', 'muted'));
    }
    if (s.failed) slack.append(node('p', `Last delivery failed: ${s.failed.error}`, 'warning'));
    box.replaceChildren(node('p', 'Everything here is off until you turn it on. Each digest is sent once per day (or week), even if Plexiform restarts.', 'muted'), schedule, notifyRow, slack);
  }

  async function refresh() {
    const request = ++generation;
    let r;
    try { r = await api.get(period); } catch { r = null; }
    if (request !== generation) return;
    renderDigest(r?.digest ?? null);
    if (r?.delivery && !delivery) { delivery = r.delivery; renderDelivery(); }
  }

  section.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
    period = b.dataset.period;
    section.querySelectorAll('[data-period]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    void refresh();
  }));
  renderActions();
  renderDelivery();
  setInterval(() => { if (!document.hidden) void refresh(); }, REFRESH_MS);
  void refresh();
})();
