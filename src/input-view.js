// What the bubble and the Waiting page show for each PendingInput
// (docs/waiting-inputs.md), as plain data: the one-line row, the age and
// escalation, which option Enter and ⌘. mean, and how a question or an
// elicitation form turns into what answerInput sends. Pure, so it is tested
// in Node; the renderers load it as a plain script (window.InputView).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InputView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ESCALATE_MS = 5 * 60 * 1000;
  const HEADLINE_MAX = 80;

  const KIND_LABEL = {
    permission: 'Permission',
    plan: 'Plan approval',
    question: 'Question',
    elicitation: 'Input requested',
    notification: 'Needs your input',
    blocked: 'Blocked',
    dialog: 'Terminal dialog',
  };

  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function project(input) {
    const parts = String(input?.cwd || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : 'session';
  }

  function headline(input) {
    const i = input || {};
    let h;
    switch (i.kind) {
      case 'permission': h = `${i.tool || 'tool'}: ${i.headline || oneLine(i.text) || i.title || ''}`; break;
      case 'plan': h = `Plan: ${oneLine(i.text) || 'ready for approval'}`; break;
      case 'question': h = oneLine(i.questions?.[0]?.question || i.text) || i.title; break;
      case 'blocked': h = `blocked: needs your decision${i.tool ? ` (${i.tool})` : ''}`; break;
      default: h = oneLine(i.title) || oneLine(i.text);
    }
    return cut(oneLine(h) || KIND_LABEL[i.kind] || 'Waiting', HEADLINE_MAX);
  }

  function ageMs(input, now = Date.now()) {
    const t = Date.parse(input?.created_at);
    return Number.isFinite(t) ? Math.max(0, now - t) : null;
  }

  function ageText(input, now = Date.now()) {
    const ms = ageMs(input, now);
    if (ms === null) return '';
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `waiting ${min} min`;
    const h = Math.floor(min / 60);
    return `waiting ${h} h ${min % 60} min`;
  }

  const escalated = (input, now = Date.now()) => (ageMs(input, now) ?? 0) >= ESCALATE_MS;

  // The hook stopped waiting: the terminal prompt is in charge again.
  function expired(input, now = Date.now()) {
    const t = Date.parse(input?.expires_at);
    return Number.isFinite(t) && t <= now;
  }

  const canAnswer = (input, now = Date.now()) => !!input?.answerable && (input.actions || []).includes('answer') && !expired(input, now);
  const canOpen = (input) => (input?.actions || []).includes('open') || input?.kind === 'blocked';

  // What Enter does. Never the riskiest choice: never a session-wide grant,
  // never allow for a command main flagged (deny-list or destructive), never
  // a guess at a question's answer or a form's content.
  function primary(input, now = Date.now()) {
    if (!input) return null;
    if (!canAnswer(input, now)) return canOpen(input) ? { type: 'open' } : null;
    const has = (id) => (input.options || []).some((o) => o.id === id);
    if (input.kind === 'permission') {
      if (input.danger !== null && input.danger !== undefined) return null;
      return has('allow') ? { type: 'option', id: 'allow' } : null;
    }
    if (input.kind === 'plan') return has('allow') ? { type: 'option', id: 'allow' } : null;
    return null;
  }

  // What ⌘. does: the "no" of each answerable kind.
  function denyOption(input, now = Date.now()) {
    if (!canAnswer(input, now)) return null;
    const id = input.kind === 'elicitation' ? 'decline' : 'deny';
    return (input.options || []).some((o) => o.id === id) ? id : null;
  }

  // How risky each option is, for styling and so a UI can order them.
  function optionTone(input, option) {
    const id = option?.id || '';
    if (id === 'deny' || id === 'decline' || id === 'cancel') return 'no';
    if (id.startsWith('allow-session-') || id === 'allow-accept-edits') return 'wide';
    if (id === 'allow' || id === 'accept') return input?.danger ? 'risky' : 'yes';
    return 'plain';
  }

  // A question answered with the option ids the person picked (and any free
  // text): { optionId, answers } for answerInput, or { error }.
  // A single single-select question with one picked option sends that
  // option's own id, so main rebuilds the answer from the request.
  function questionAnswer(input, picked = {}, typed = {}) {
    const qs = Array.isArray(input?.questions) ? input.questions : [];
    if (!qs.length) return { error: 'no questions' };
    const answers = {};
    for (const q of qs) {
      const free = String(typed[q.id] || '').trim();
      const ids = [].concat(picked[q.id] || []).filter((id) => q.options.some((o) => o.id === id));
      if (free) answers[q.question] = free.slice(0, 2000);
      else if (ids.length) answers[q.question] = q.options.filter((o) => ids.includes(o.id)).map((o) => o.label).join(', ');
      else return { error: `Answer “${cut(q.question, 40)}” first` };
    }
    const only = qs.length === 1 && !qs[0].multiSelect ? qs[0] : null;
    if (only && !String(typed[only.id] || '').trim()) {
      const id = [].concat(picked[only.id] || [])[0];
      if (id && (input.options || []).some((o) => o.id === id)) return { optionId: id };
    }
    return { optionId: 'answers', answers };
  }

  // A form for an elicitation's requested_schema: flat string, number,
  // integer, boolean and enum fields only (what MCP's form mode allows).
  function formFields(schema) {
    const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
    return Object.keys(props).slice(0, 20).map((name) => {
      const p = props[name] && typeof props[name] === 'object' ? props[name] : {};
      const values = Array.isArray(p.enum) ? p.enum.filter((v) => typeof v === 'string').slice(0, 30) : null;
      const type = values ? 'enum' : ['string', 'number', 'integer', 'boolean'].includes(p.type) ? p.type : 'string';
      return {
        name: String(name).slice(0, 100),
        label: String(p.title || name).slice(0, 100),
        description: typeof p.description === 'string' ? p.description.slice(0, 300) : '',
        type, values, required: required.has(name),
      };
    });
  }

  // Form values (strings, or booleans for checkboxes) → content, or { error }.
  function formContent(fields, values = {}) {
    const content = {};
    for (const f of fields) {
      const v = values[f.name];
      if (f.type === 'boolean') { content[f.name] = !!v; continue; }
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s) { if (f.required) return { error: `${f.label} is required` }; continue; }
      if (f.type === 'number' || f.type === 'integer') {
        const n = Number(s);
        if (!Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) return { error: `${f.label} must be ${f.type === 'integer' ? 'a whole number' : 'a number'}` };
        content[f.name] = n;
      } else if (f.type === 'enum') {
        if (!f.values.includes(s)) return { error: `Pick a value for ${f.label}` };
        content[f.name] = s;
      } else content[f.name] = s.slice(0, 4000);
    }
    return { content };
  }

  // Oldest first (they have waited longest), capped for the widget; the rest
  // become "+N more".
  function visible(inputs, max = 2) {
    const list = (Array.isArray(inputs) ? inputs : []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
  }

  // Screen-reader name for a row.
  function rowLabel(input, now = Date.now()) {
    const age = ageText(input, now);
    return `${KIND_LABEL[input?.kind] || 'Waiting'} in ${project(input)}: ${headline(input)}${age ? `, ${age}` : ''}${expired(input, now) ? ', answer in terminal' : ''}`;
  }

  return { ESCALATE_MS, KIND_LABEL, project, headline, ageMs, ageText, escalated, expired, canAnswer, canOpen, primary, denyOption, optionTone, questionAnswer, formFields, formContent, visible, rowLabel };
});
