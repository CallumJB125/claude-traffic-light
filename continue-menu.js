'use strict';
// "Continue in…": the small menu Running now and Search everything share
// (src/continue-in.js decides what it lists). Text is only ever textContent.
(() => {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let openMenu = null;
  const close = () => { if (!openMenu) return; const m = openMenu; openMenu = null; m.box.remove(); m.trigger.setAttribute('aria-expanded', 'false'); m.onClose(); };
  document.addEventListener('click', (e) => { if (openMenu && !openMenu.wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { const t = openMenu.trigger; close(); t.focus(); } });

  // menu() → {ok, choices:[{id,label,mode}]}; pick(choice) runs it.
  function button({ menu, pick, className = 'small', onOpen = () => {}, onClose = () => {} }) {
    const wrap = el('span', 'continue-wrap');
    const trigger = el('button', className, 'Continue in…');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', async () => {
      if (openMenu && openMenu.trigger === trigger) return close();
      close();
      const r = await Promise.resolve(menu()).catch(() => null);
      const box = el('div', 'continue-menu');
      box.setAttribute('role', 'menu');
      box.setAttribute('aria-label', 'Continue this work in');
      for (const c of r && r.ok ? r.choices : [{ id: 'copy', label: 'Copy as prompt', mode: 'copy' }]) {
        const item = el('button', 'continue-item');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.append(el('span', 'continue-label', c.label), el('span', 'continue-hint', c.id === 'copy' ? 'Paste into any AI tool' : c.mode === 'launch' ? 'Starts it here with the handover' : 'Copies the handover to paste in'));
        item.addEventListener('click', () => { close(); pick(c); });
        box.append(item);
      }
      wrap.append(box);
      openMenu = { wrap, box, trigger, onClose };
      trigger.setAttribute('aria-expanded', 'true');
      onOpen();
      box.querySelector('button')?.focus();
    });
    wrap.append(trigger);
    return wrap;
  }

  // A launched hand-off's replies, with Send and End (api: reply(id, text), end(id)).
  function panel(r, holder, api) {
    const label = r.label || 'The tool';
    const box = el('div', 'continue-panel');
    const head = el('p', 'continue-note', `${label} is reading the handover…`);
    const out = el('p', 'continue-reply');
    const form = el('div', 'continue-form'); form.hidden = true;
    const text = el('textarea'); text.setAttribute('aria-label', `Reply to ${label}`); text.maxLength = 4000;
    const note = el('p', 'continue-note');
    const send = el('button', 'small primary', 'Send'); send.type = 'button';
    const end = el('button', 'small', 'End'); end.type = 'button';
    send.addEventListener('click', async () => {
      if (!text.value.trim()) return;
      send.disabled = true; out.textContent = '';
      const res = await api.reply(r.id, text.value).catch(() => null);
      if (res && res.ok) { text.value = ''; head.textContent = `${label} is replying…`; note.textContent = ''; } else { send.disabled = false; note.textContent = (res && res.error) || 'That did not work.'; }
    });
    const ended = () => { head.textContent = `This ${label} session has ended.`; form.hidden = true; end.disabled = true; };
    end.addEventListener('click', async () => { await api.end(r.id).catch(() => null); ended(); });
    form.append(text, send, note);
    box.append(head, out, form, end);
    holder.append(box);
    return {
      event(ev) {
        if (ev.kind === 'delta') out.textContent += ev.text;
        else if (ev.kind === 'message') out.textContent = ev.text;
        else if (ev.kind === 'refused') head.textContent = `${label} asked to use a tool; sessions Plexiform starts are text-only, so it was refused.`;
        else if (ev.kind === 'done') { head.textContent = ev.status === 'completed' ? `${label} replied. Answer below, or end it.` : `The turn ${ev.status}${ev.error ? `: ${ev.error}` : ''}.`; form.hidden = false; send.disabled = false; }
        else if (ev.kind === 'closed') ended();
      },
    };
  }

  window.ContinueMenu = { button, panel, close };
})();
