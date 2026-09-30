// The waiting-input list, drawn for the widget bubble (compact, capped rows)
// and the Waiting page (every input, roomier). Everything an agent wrote
// (commands, paths, plans, questions, dialog text) is untrusted: it only
// ever goes into textContent or a plain attribute, never markup.
//
// A click sends an option id; main rebuilds the answer from the request
// file. One answer per input: its buttons lock the moment one is clicked.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./src/input-view.js'));
  else root.InputBubble = factory(root.InputView);
})(typeof self !== 'undefined' ? self : this, function (V) {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    permission: 'M8 1.8l5 2v3.6c0 3.1-2.1 5.7-5 6.8-2.9-1.1-5-3.7-5-6.8V3.8z',
    plan: 'M3.5 3.5h9M3.5 6.5h9M3.5 9.5h6M3.5 12.5h4',
    question: 'M5.8 5.8a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.6M8 12.3v.2',
    elicitation: 'M2.5 3.5h11v9h-11zM4.5 6.5h7M4.5 9.5h4',
    notification: 'M4 11V7.2a4 4 0 0 1 8 0V11l1 1.2H3zM6.6 13.8a1.5 1.5 0 0 0 2.8 0',
    blocked: 'M8 2.2l6 10.6H2zM8 6.5v3M8 11.3v.2',
    dialog: 'M2.5 3h11v10h-11zM2.5 5.5h11M4.5 8.5l1.8 1.5-1.8 1.5M8 11.5h3',
  };
  const LONG_TEXT = 220;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function icon(kind) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'ib-icon');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', ICONS[kind] || ICONS.notification);
    svg.appendChild(p);
    return svg;
  }
  const keyOf = (inputs) => inputs.map((i) => `${i.id}|${i.created_at}|${i.expires_at}|${i.danger || ''}|${i.text && i.text.length}|${i.title}`).join('\n');

  function create(container, opts = {}) {
    const api = opts.api || {};
    const mode = opts.mode === 'page' ? 'page' : 'widget';
    const maxRows = mode === 'page' ? Infinity : (opts.maxRows || 2);
    const now = opts.now || (() => Date.now());
    const onLayout = opts.onLayout || (() => {});

    let inputs = [];
    let lastKey = null;
    let expanded = null;
    let collapsedByUser = false;
    let dismissedKey = null;
    let nudge = null;
    const sending = new Set();
    const answered = new Set();
    const errors = new Map();
    const full = new Set();
    const notes = new Map(); // id → explanation shown under a blocked input
    const picked = new Map(); // id → { questionId: [optionId] }
    const typed = new Map(); // id → { questionId: text }
    const formValues = new Map(); // id → { field: value }
    const reasons = new Map(); // id → deny reason typed

    container.classList.add('ib', `ib-${mode}`);
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'Waiting on you');
    const live = el('div', 'ib-sr');
    live.setAttribute('aria-live', 'polite');

    const live_ = () => inputs.filter((i) => !answered.has(i.id));
    const current = () => {
      const list = live_();
      if (expanded && list.some((i) => i.id === expanded)) return list.find((i) => i.id === expanded);
      return null;
    };

    function setError(id, msg) { if (msg) errors.set(id, msg); else errors.delete(id); render(); }

    async function send(input, optionId, more) {
      if (!input || sending.has(input.id) || answered.has(input.id)) return;
      if (!V.canAnswer(input, now())) { setError(input.id, 'The hook stopped waiting: answer in the terminal.'); return; }
      sending.add(input.id);
      errors.delete(input.id);
      render();
      let r;
      try { r = await api.answerInput(input.id, optionId, more || {}); } catch (e) { r = { ok: false, error: e && e.message ? e.message : 'could not send' }; }
      sending.delete(input.id);
      if (r && r.ok) {
        answered.add(input.id);
        live.textContent = 'Answer sent';
        if (r.nudge) { nudge = r.nudge; }
      } else errors.set(input.id, (r && r.error) || 'Could not send: answer it in the terminal.');
      render();
    }

    async function open(input) {
      if (!input) return;
      let r;
      try { r = await api.openInput(input.id); } catch { r = null; }
      if (!r || !r.ok) setError(input.id, r && r.error === 'gone' ? 'It is no longer waiting.' : 'Could not find its terminal.');
    }

    function optionButton(input, o, extra, onClick) {
      const b = el('button', `ib-opt tone-${V.optionTone(input, o)}`, o.label);
      b.type = 'button';
      b.dataset.option = o.id;
      if (o.description) b.title = o.description;
      b.setAttribute('aria-label', `${o.label}${o.description ? `: ${o.description}` : ''} (${V.KIND_LABEL[input.kind] || 'input'} in ${V.project(input)})`);
      b.disabled = sending.has(input.id) || !V.canAnswer(input, now());
      b.addEventListener('click', (e) => { e.stopPropagation(); if (onClick) onClick(); else send(input, o.id, extra ? extra() : undefined); });
      return b;
    }

    function openButton(input, label = 'Open it') {
      const b = el('button', 'ib-opt tone-plain ib-open', label);
      b.type = 'button';
      b.setAttribute('aria-label', `${label}: go to the terminal for ${V.project(input)}`);
      b.addEventListener('click', (e) => { e.stopPropagation(); open(input); });
      return b;
    }

    function textBlock(input) {
      const text = String(input.text || '');
      if (!text) return null;
      const wrap = el('div', 'ib-textwrap');
      const pre = el('pre', `ib-text${full.has(input.id) ? ' full' : ''}`, text);
      pre.tabIndex = 0;
      pre.setAttribute('aria-label', `Full text from ${V.project(input)}`);
      wrap.appendChild(pre);
      if (text.length > LONG_TEXT || text.split('\n').length > 4) {
        const more = el('button', 'ib-link', full.has(input.id) ? 'Show less' : 'Show full');
        more.type = 'button';
        more.setAttribute('aria-expanded', String(full.has(input.id)));
        more.addEventListener('click', (e) => { e.stopPropagation(); if (full.has(input.id)) full.delete(input.id); else full.add(input.id); render(); });
        wrap.appendChild(more);
      }
      return wrap;
    }

    function reasonField(input) {
      const f = el('input', 'ib-field ib-reason');
      f.type = 'text';
      f.placeholder = 'Reason for denying (optional)';
      f.setAttribute('aria-label', 'Reason sent back to the agent if you deny (optional)');
      f.maxLength = 300;
      f.value = reasons.get(input.id) || '';
      f.dataset.focusKey = `${input.id}:reason`;
      f.addEventListener('input', () => reasons.set(input.id, f.value));
      return f;
    }
    const denyExtra = (input) => () => { const m = (reasons.get(input.id) || '').trim(); return m ? { message: m } : {}; };

    function questionControls(input, body) {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const answerable = V.canAnswer(input, now());
      const sel = picked.get(input.id) || {};
      const txt = typed.get(input.id) || {};
      const single = qs.length === 1 && !qs[0].multiSelect;
      for (const q of qs) {
        const box = el('fieldset', 'ib-q');
        const legend = el('legend', 'ib-qtext', q.header ? `${q.header}: ${q.question}` : q.question);
        box.appendChild(legend);
        const opts = el('div', 'ib-opts');
        for (const o of q.options || []) {
          if (!answerable) { opts.appendChild(el('span', 'ib-readonly', o.label)); continue; }
          if (single) { opts.appendChild(optionButton(input, o)); continue; }
          const on = [].concat(sel[q.id] || []).includes(o.id);
          const b = el('button', `ib-opt tone-plain${on ? ' on' : ''}`, o.label);
          b.type = 'button';
          b.setAttribute('aria-pressed', String(on));
          if (o.description) b.title = o.description;
          b.disabled = sending.has(input.id);
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            const cur = [].concat(sel[q.id] || []);
            sel[q.id] = q.multiSelect ? (on ? cur.filter((x) => x !== o.id) : [...cur, o.id]) : [o.id];
            picked.set(input.id, sel);
            render();
          });
          opts.appendChild(b);
        }
        box.appendChild(opts);
        if (answerable && input.freeText) {
          const f = el('input', 'ib-field');
          f.type = 'text';
          f.placeholder = 'Or type your own answer';
          f.setAttribute('aria-label', `Your own answer to: ${q.question}`);
          f.maxLength = 2000;
          f.value = txt[q.id] || '';
          f.dataset.focusKey = `${input.id}:${q.id}`;
          f.addEventListener('input', () => { txt[q.id] = f.value; typed.set(input.id, txt); });
          f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); submitQuestion(input); } });
          box.appendChild(f);
        }
        body.appendChild(box);
      }
      if (!answerable) return;
      const row = el('div', 'ib-opts');
      const sendBtn = el('button', 'ib-opt tone-yes', 'Send answer');
      sendBtn.type = 'button';
      sendBtn.disabled = sending.has(input.id);
      sendBtn.addEventListener('click', (e) => { e.stopPropagation(); submitQuestion(input); });
      if (!single || input.freeText) row.appendChild(sendBtn);
      const deny = (input.options || []).find((o) => o.id === 'deny');
      if (deny) row.appendChild(optionButton(input, deny));
      body.appendChild(row);
    }
    function submitQuestion(input) {
      const r = V.questionAnswer(input, picked.get(input.id) || {}, typed.get(input.id) || {});
      if (r.error) { setError(input.id, r.error); return; }
      send(input, r.optionId, r.answers ? { answers: r.answers } : undefined);
    }

    function elicitationControls(input, body) {
      const accept = (input.options || []).find((o) => o.id === 'accept');
      const fields = accept && accept.needsContent ? V.formFields(input.schema) : [];
      const vals = formValues.get(input.id) || {};
      if (fields.length) {
        const form = el('div', 'ib-form');
        for (const f of fields) {
          const lab = el('label', 'ib-flabel');
          lab.appendChild(el('span', null, `${f.label}${f.required ? ' *' : ''}`));
          let ctl;
          if (f.type === 'boolean') { ctl = el('input'); ctl.type = 'checkbox'; ctl.checked = !!vals[f.name]; ctl.addEventListener('change', () => { vals[f.name] = ctl.checked; formValues.set(input.id, vals); }); }
          else if (f.type === 'enum') {
            ctl = el('select', 'ib-field');
            ctl.appendChild(el('option', null, '—')).value = '';
            for (const v of f.values) { const o = el('option', null, v); o.value = v; ctl.appendChild(o); }
            ctl.value = vals[f.name] || '';
            ctl.addEventListener('change', () => { vals[f.name] = ctl.value; formValues.set(input.id, vals); });
          } else {
            ctl = el('input', 'ib-field');
            ctl.type = f.type === 'string' ? 'text' : 'number';
            ctl.value = vals[f.name] || '';
            ctl.addEventListener('input', () => { vals[f.name] = ctl.value; formValues.set(input.id, vals); });
          }
          ctl.dataset.focusKey = `${input.id}:f:${f.name}`;
          ctl.disabled = sending.has(input.id) || !V.canAnswer(input, now());
          if (f.description) ctl.title = f.description;
          lab.appendChild(ctl);
          form.appendChild(lab);
        }
        body.appendChild(form);
      }
      const row = el('div', 'ib-opts');
      for (const o of input.options || []) {
        if (o.id === 'accept' && fields.length) {
          row.appendChild(optionButton(input, o, null, () => {
            const r = V.formContent(fields, formValues.get(input.id) || {});
            if (r.error) { setError(input.id, r.error); return; }
            send(input, 'accept', { content: r.content });
          }));
        } else row.appendChild(optionButton(input, o));
      }
      body.appendChild(row);
    }

    function blockedControls(input, body) {
      if (input.reason && !String(input.text || '').includes(input.reason)) body.appendChild(el('div', 'ib-reason-text', `Reason: ${input.reason}`));
      const row = el('div', 'ib-opts');
      for (const o of input.options || []) {
        const b = el('button', 'ib-opt tone-plain', o.label);
        b.type = 'button';
        b.dataset.option = o.id;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          // Suggestions only: none of these is ever sent to Claude Code.
          if (o.id === 'run-yourself') open(input);
          else if (o.id === 'switch-mode') { notes.set(input.id, notes.get(input.id) ? null : 'Auto mode’s safety check refused this call. To let it through, switch mode in that terminal: Shift+Tab cycles the permission modes. Or run the command yourself.'); render(); }
          else if (o.id === 'add-rule' && api.openAutoRule) api.openAutoRule(input.id);
        });
        row.appendChild(b);
      }
      body.appendChild(row);
      const note = notes.get(input.id);
      if (note) body.appendChild(el('div', 'ib-note', note));
    }

    function readOnlyOptions(input, body) {
      const opts = input.options || [];
      if (!opts.length) return;
      const list = el('ol', 'ib-dialog-opts');
      list.setAttribute('aria-label', 'Choices shown in the terminal');
      for (const o of opts) list.appendChild(el('li', null, o.label));
      body.appendChild(el('div', 'ib-hint', 'In the terminal:'));
      body.appendChild(list);
    }

    function itemBody(input) {
      const t = now();
      const body = el('div', 'ib-body');
      body.id = `ib-body-${input.id}`;
      if (input.title && input.kind !== 'question') body.appendChild(el('div', 'ib-title', input.title));
      if (input.danger) {
        const w = el('div', 'ib-warn', `Needs a careful look: ${input.danger}. Enter won’t allow it.`);
        w.setAttribute('role', 'note');
        body.appendChild(w);
      }
      if (V.expired(input, t)) {
        const x = el('div', 'ib-expired', 'The widget’s turn ran out: answer in terminal.');
        x.setAttribute('role', 'status');
        body.appendChild(x);
      }
      if (input.kind !== 'question') { const tb = textBlock(input); if (tb) body.appendChild(tb); }
      if (input.cwd && mode === 'page') body.appendChild(el('div', 'ib-hint', input.cwd));
      switch (input.kind) {
        case 'permission': case 'plan':
          if (V.canAnswer(input, t)) {
            if (mode === 'page' || input.kind === 'permission') body.appendChild(reasonField(input));
            const row = el('div', 'ib-opts');
            for (const o of input.options || []) row.appendChild(optionButton(input, o, o.id === 'deny' ? denyExtra(input) : null));
            body.appendChild(row);
          }
          break;
        case 'question': questionControls(input, body); break;
        case 'elicitation': if (V.canAnswer(input, t)) elicitationControls(input, body); break;
        case 'blocked': blockedControls(input, body); break;
        default: readOnlyOptions(input, body);
      }
      if (input.kind !== 'blocked' && (!V.canAnswer(input, t)) && V.canOpen(input)) {
        const row = el('div', 'ib-opts');
        row.appendChild(openButton(input, V.expired(input, t) ? 'Open the terminal' : 'Open it'));
        body.appendChild(row);
      }
      const err = errors.get(input.id);
      if (err) { const e = el('div', 'ib-err', err); e.setAttribute('role', 'alert'); body.appendChild(e); }
      if (sending.has(input.id)) body.appendChild(el('div', 'ib-hint', 'Sending…'));
      return body;
    }

    function item(input) {
      const t = now();
      const isOpen = expanded === input.id;
      const sec = el('section', `ib-item kind-${input.kind}${V.escalated(input, t) ? ' late' : ''}${V.expired(input, t) ? ' expired' : ''}${isOpen ? ' open' : ''}`);
      sec.dataset.id = input.id;
      const row = el('button', 'ib-row');
      row.type = 'button';
      row.dataset.focusKey = `${input.id}:row`;
      row.setAttribute('aria-expanded', String(isOpen));
      row.setAttribute('aria-controls', `ib-body-${input.id}`);
      row.setAttribute('aria-label', V.rowLabel(input, t));
      row.appendChild(icon(input.kind));
      row.appendChild(el('span', 'ib-proj', V.project(input)));
      row.appendChild(el('span', 'ib-head', V.headline(input)));
      row.appendChild(el('span', 'ib-age', V.expired(input, t) ? 'answer in terminal' : V.ageText(input, t)));
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        expanded = isOpen ? null : input.id;
        collapsedByUser = isOpen;
        render();
      });
      sec.appendChild(row);
      if (isOpen) sec.appendChild(itemBody(input));
      return sec;
    }

    function nudgeCard() {
      const n = nudge;
      const card = el('div', 'ib-nudge');
      card.setAttribute('role', 'status');
      card.appendChild(el('div', 'ib-nudge-q', `You’ve approved this ${n.count} times — make it a rule?`));
      card.appendChild(el('div', 'ib-nudge-rule', `${(n.tools || []).join(', ')}: ${n.command || n.path || 'any use'}`));
      const row = el('div', 'ib-opts');
      const mk = (label, cls, fn) => { const b = el('button', `ib-opt ${cls}`, label); b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
      row.appendChild(mk('Make it a rule', 'tone-yes', () => { const k = n.key; nudge = null; render(); if (api.nudgeRule) api.nudgeRule(k); }));
      row.appendChild(mk('Not now', 'tone-plain', () => { nudge = null; render(); }));
      row.appendChild(mk('Don’t ask again', 'tone-plain', () => { const k = n.key; nudge = null; render(); if (api.nudgeMute) api.nudgeMute(k); }));
      card.appendChild(row);
      return card;
    }

    function render() {
      const active = document.activeElement;
      const focusKey = active && container.contains(active) ? active.dataset.focusKey : null;
      const list = live_();
      const key = keyOf(list);
      const kids = [];
      if (nudge) kids.push(nudgeCard());
      if (list.length && dismissedKey === key && mode === 'widget') {
        const pill = el('button', 'ib-pill', `${list.length} waiting on you · show`);
        pill.type = 'button';
        pill.addEventListener('click', (e) => { e.stopPropagation(); dismissedKey = null; render(); });
        kids.push(pill);
      } else if (list.length) {
        const { shown, more } = V.visible(list, maxRows);
        const openItem = expanded && list.find((i) => i.id === expanded);
        // An expanded input beyond the cap swaps in for the last row.
        const rows = openItem && !shown.includes(openItem) ? [...shown.slice(0, -1), openItem] : shown;
        for (const i of rows) kids.push(item(i));
        if (more > 0) {
          const m = el('button', 'ib-more', `+${more} more waiting`);
          m.type = 'button';
          m.setAttribute('aria-label', `${more} more waiting: open the Waiting on you list`);
          m.addEventListener('click', (e) => { e.stopPropagation(); if (api.openWaiting) api.openWaiting(); });
          kids.push(m);
        }
      } else if (mode === 'page') {
        kids.push(el('p', 'ib-empty', 'Nothing is waiting on you.'));
      }
      kids.push(live);
      container.replaceChildren(...kids);
      container.classList.toggle('has-items', list.length > 0 || !!nudge);
      if (focusKey) {
        const again = [...container.querySelectorAll('[data-focus-key]')].find((n) => n.dataset.focusKey === focusKey);
        if (again) again.focus();
      }
      onLayout();
    }

    function update(next) {
      inputs = Array.isArray(next) ? next.filter((i) => i && typeof i.id === 'string') : [];
      const ids = new Set(inputs.map((i) => i.id));
      for (const s of [answered, sending, full]) for (const id of [...s]) if (!ids.has(id)) s.delete(id);
      for (const m of [errors, notes, picked, typed, formValues, reasons]) for (const id of [...m.keys()]) if (!ids.has(id)) m.delete(id);
      const list = live_();
      if (expanded && !list.some((i) => i.id === expanded)) expanded = null;
      // One waiting input opens straight away, like the old Allow/Deny strip.
      if (!expanded && !collapsedByUser && list.length === 1 && mode === 'widget') expanded = list[0].id;
      if (mode === 'page' && !expanded && list.length && !collapsedByUser) expanded = list[0].id;
      const key = keyOf(list);
      if (key !== lastKey) {
        if (lastKey !== null && list.length > (lastKey ? lastKey.split('\n').length : 0)) live.textContent = `${list.length} waiting on you`;
        lastKey = key;
        if (list.length <= 1) collapsedByUser = false;
      }
      render();
    }

    // The keyboard, for whichever window has focus (the widget only once
    // someone clicked it). → true when handled.
    function keydown(e) {
      const tag = e.target && e.target.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const cur = current() || (live_().length === 1 ? live_()[0] : null);
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        const id = cur && V.denyOption(cur, now());
        if (!id) return false;
        e.preventDefault();
        send(cur, id, id === 'deny' ? denyExtra(cur)() : undefined);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typing && e.target.blur) e.target.blur();
        if (expanded) { expanded = null; collapsedByUser = true; } else if (mode === 'widget') dismissedKey = keyOf(live_());
        render();
        return true;
      }
      if (e.key === 'Enter' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (tag === 'BUTTON' || tag === 'PRE') return false; // the focused control's own action
        if (!cur) return false;
        e.preventDefault();
        const p = V.primary(cur, now());
        if (!p) { setError(cur.id, cur.danger ? 'Enter won’t allow this one: click Allow if you mean it.' : 'Pick an option.'); return true; }
        if (p.type === 'open') open(cur); else send(cur, p.id, undefined);
        return true;
      }
      return false;
    }

    // Ages move on without a status push.
    function tick() {
      for (const sec of container.querySelectorAll('.ib-item')) {
        const input = inputs.find((i) => i.id === sec.dataset.id);
        if (!input) continue;
        const t = now();
        const age = sec.querySelector('.ib-age');
        if (V.expired(input, t) && !sec.classList.contains('expired')) { render(); return; }
        if (age) age.textContent = V.expired(input, t) ? 'answer in terminal' : V.ageText(input, t);
        sec.classList.toggle('late', V.escalated(input, t));
      }
    }

    return {
      update, keydown, tick,
      showNudge(n) { nudge = n; render(); },
      get count() { return live_().length; },
    };
  }

  return { create };
});
