'use strict';
// Sessions' Agent mail panel (src/agent-mail.js). Your AI's asks wait here
// for Send or Discard; teammates' AIs' questions and handoffs (opt-in inbox)
// are answered, asked of your own AI, accepted or declined here. Every text is
// set with textContent or a field value; main re-checks everything.
(() => {
  const api = window.sessionsApi;
  const section = document.getElementById('mail');
  if (!api || !api.mailList || !section) return;
  const out = section.querySelector('.body');
  const status = document.getElementById('mail-status');
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const btn = (label, onClick, primary) => { const b = node('button', label, primary ? 'primary' : ''); b.type = 'button'; b.addEventListener('click', () => void onClick(b)); return b; };
  const say = (r, ok) => { status.textContent = r && r.ok === false ? (r.cancelled ? r.error || 'Cancelled.' : r.error || 'That did not work. Try again.') : r && (r.warning || r.note) ? r.warning || r.note : ok || ''; };
  // Kept across re-renders, by message id: the answer being written, the folder chosen,
  // and drafts: a held message's edited text, a decline reason, the AI chosen.
  const asking = new Map(); // continue-in launch id -> message id
  const answers = new Map(), folders = new Map(), drafts = new Map();
  const keep = (id, key, field) => {
    const d = drafts.get(id);
    if (d && key in d) field.value = d[key];
    field.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', () => drafts.set(id, { ...drafts.get(id), [key]: field.value }));
  };
  const opened = new Set();
  let tools = null, busy = false, generation = 0;

  async function run(control, fn, ok, again = true) {
    if (busy) return;
    busy = true; if (control) control.disabled = true;
    let r;
    try { r = await fn(); } catch { r = { ok: false, error: 'That did not work. Try again.' }; }
    busy = false; if (control) control.disabled = false;
    say(r, ok);
    if (again) void refresh();
    return r;
  }

  function heldItem(m, hub) {
    const li = node('li', null, 'mail-item');
    const to = m.to || 'a teammate';
    li.append(node('h3', m.kind === 'handoff' ? `Your AI wants to hand work to ${to}` : `Your AI wants to ask ${to}`));
    const via = m.via && (m.via.label || m.via.provider);
    li.append(node('p', [hub ? `Through ${hub}` : null, via ? `from “${via}” (self-declared)` : null, 'Nothing is sent until you press Send.'].filter(Boolean).join(' · '), 'muted'));
    const label = node('label', 'Exactly what will be sent (you can edit it)');
    const text = node('textarea'); text.value = m.body; text.rows = Math.min(14, Math.max(4, m.body.split('\n').length + 1)); text.maxLength = 4000;
    keep(m.id, 'text', text);
    label.append(text);
    const actions = node('div', null, 'row-actions');
    actions.append(
      btn('Send', (b) => run(b, () => api.mailRelease(m.id, 'send', m.digest, text.value), `Sent to ${to}.`), true),
      btn('Discard', (b) => run(b, () => api.mailRelease(m.id, 'discard', m.digest), 'Discarded. Nothing was sent.')),
    );
    li.append(label, actions);
    return li;
  }

  function answerBox(m) {
    const label = node('label', 'Your answer');
    const field = node('textarea'); field.rows = 4; field.maxLength = 4000;
    field.dataset.mail = m.id; field.value = answers.get(m.id) || '';
    field.addEventListener('input', () => answers.set(m.id, field.value));
    label.append(field);
    return { label, field };
  }

  function questionItem(m) {
    const li = node('li', null, 'mail-item');
    li.append(node('h3', `${m.from || 'A teammate'}'s AI asked you`));
    const via = m.via && (m.via.label || m.via.provider);
    if (via) li.append(node('p', `From “${via}” (self-declared)`, 'muted'));
    li.append(node('pre', m.body, 'mail-body'));
    const { label, field } = answerBox(m);
    const actions = node('div', null, 'row-actions');
    actions.append(btn('Send answer', (b) => run(b, () => api.mailAnswer(m.id, field.value), 'Answer sent.'), true));
    const launch = (tools || []).filter((t) => t.mode === 'launch');
    if (launch.length) {
      const pick = node('select'); pick.setAttribute('aria-label', 'Which AI');
      for (const t of launch) { const o = node('option', t.label); o.value = t.id; pick.append(o); }
      actions.append(pick, btn('Ask my AI', (b) => run(b, async () => {
        const r = await api.mailAskAi(m.id, pick.value);
        if (r && r.ok && r.mode === 'launched' && typeof r.id === 'string') asking.set(r.id, m.id);
        return r;
      }, 'Your AI is answering. Its reply appears in the answer box; edit it before you send.')));
    } else {
      actions.append(btn('Copy question for your AI', (b) => run(b, () => api.mailAskAi(m.id, 'copy'))));
    }
    actions.append(btn('Decline', (b) => run(b, () => api.mailDecline(m.id, ''), 'Declined.')));
    li.append(label, node('p', 'Your AI will answer from the question alone. It can’t see your code or files.', 'muted'), actions);
    return li;
  }

  function handoffItem(m) {
    const li = node('li', null, 'mail-item');
    li.append(node('h3', `${m.from || 'A teammate'}'s AI offered you work`));
    li.append(node('pre', m.body, 'mail-body'));
    if (m.handoff?.artifacts?.length) li.append(node('p', `Files: ${m.handoff.artifacts.join(', ')}`, 'muted'));
    const where = node('span', folders.get(m.id)?.label || 'No folder chosen', 'muted');
    const ai = node('select'); ai.setAttribute('aria-label', 'Which AI');
    for (const [id, label] of [['auto', 'Automatic'], ['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini CLI']]) { const o = node('option', label); o.value = id; ai.append(o); }
    keep(m.id, 'ai', ai);
    const reason = node('input'); reason.type = 'text'; reason.maxLength = 500; reason.placeholder = 'Reason (optional)'; reason.setAttribute('aria-label', 'Reason for declining');
    keep(m.id, 'reason', reason);
    const actions = node('div', null, 'row-actions');
    actions.append(
      btn('Choose a folder', async (b) => { const r = await run(b, () => api.mailPickFolder(), '', false); if (r && r.ok) { folders.set(m.id, { handle: r.handle, label: r.label }); where.textContent = r.label; } }),
      where, ai,
      btn('Accept…', (b) => run(b, () => (folders.has(m.id) ? api.mailAccept(m.id, folders.get(m.id).handle, ai.value) : { ok: false, error: 'Choose the folder it should work in first.' }), 'Accepted. It is running in Tasks.'), true),
      reason,
      btn('Decline', (b) => run(b, () => api.mailDecline(m.id, reason.value), 'Declined.')),
    );
    li.append(node('p', 'Accepting starts it in its own git worktree, only after you confirm the full text.', 'muted'), actions);
    return li;
  }

  // Hand-offs that left this Mac and how they went: the status comes back from the teammate's accept, decline or finished task.
  const SENT = { offered: 'Waiting for them', accepted: 'Accepted, running on their Mac', done: 'Finished', failed: 'Did not finish', declined: 'Declined', expired: 'Expired, not answered in time' };
  function sentItem(m) {
    const li = node('li', null, 'mail-item');
    li.append(node('h3', `Handed off to ${m.to || 'a teammate'}: ${m.goal || 'work'}`));
    li.append(node('p', `${SENT[m.state] || m.state}${m.report ? ` · ${m.report}` : ''}`, 'muted'));
    return li;
  }

  function render(s) {
    const held = (s && s.held) || [], inbox = (s && s.inbox) || [], sent = (s && s.sent) || [];
    // Signed out: say what it is and where to sign in, rather than hiding it.
    if (s && s.signedIn === false) {
      section.hidden = false;
      return out.replaceChildren(node('p', 'Agent mail lets your AI ask a teammate a question or hand them work, and shows what teammates’ AIs ask you. Nothing is sent until you press Send.', 'muted'),
        btn('Sign in to use agent mail', (b) => run(b, async () => ((await api.openAccount?.()) ? { ok: true } : { ok: false, error: 'The Account page could not be opened. Open it from Team in the sidebar.' }), '', false), true));
    }
    section.hidden = !s || !s.signedIn || (!held.length && !inbox.length && !sent.length && !s.polling);
    if (section.hidden) return out.replaceChildren();
    const live = new Set([...held, ...inbox].map((m) => m.id));
    for (const id of drafts.keys()) if (!live.has(id)) drafts.delete(id);
    const list = node('ul', null, 'mail-list');
    for (const m of held) list.append(heldItem(m, s.hub));
    for (const m of inbox) {
      if (!opened.has(m.id)) { opened.add(m.id); void api.mailOpen(m.id); }
      list.append(m.kind === 'handoff' ? handoffItem(m) : questionItem(m));
    }
    const parts = [list];
    if (sent.length) { parts.push(node('h3', 'Hand-offs you sent')); const sl = node('ul', null, 'mail-list'); for (const m of sent) sl.append(sentItem(m)); parts.push(sl); }
    if (!held.length && !inbox.length) parts.push(node('p', 'Nothing waiting. Questions your AI drafts for teammates, and teammates’ AIs’ questions to you, show up here.', 'muted'));
    if (!s.polling) parts.push(node('p', 'To see teammates’ AI questions here, turn on “Show my teammates’ AI questions” in Preferences.', 'muted'));
    out.replaceChildren(...parts);
  }

  async function refresh() {
    const request = ++generation;
    let s;
    try { s = await api.mailList(); } catch { s = null; }
    if (tools === null) { try { tools = (await api.continueMenu())?.choices || []; } catch { tools = []; } }
    // Never re-render under someone typing an answer or editing a held message.
    if (request !== generation || busy || (section.contains(document.activeElement) && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName))) return;
    render(s);
  }

  api.onContinue((ev) => {
    const mid = ev && asking.get(ev.id);
    if (!mid) return;
    if (ev.kind === 'message' && typeof ev.text === 'string') {
      answers.set(mid, ev.text.slice(0, 4000));
      const field = [...out.querySelectorAll('textarea[data-mail]')].find((f) => f.dataset.mail === mid);
      if (field) field.value = answers.get(mid);
    }
    if (ev.kind === 'closed') asking.delete(ev.id);
  });
  if (api.onMail) api.onMail(() => void refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  void refresh();
})();
