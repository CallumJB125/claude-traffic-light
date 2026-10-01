// Account pages: sign in, create a team, team settings, join with an invite,
// account, and This Mac. One screen at a time (?screen=), drawn from main's
// state with textContent only (no innerHTML). Every action goes through
// window.buddyAccount; main decides which screen comes next.
const api = window.buddyAccount;
const root = document.getElementById('acct');
const screen = new URLSearchParams(location.search).get('screen') ?? 'hub';

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k);
  return n;
}

const ROLES = ['owner', 'admin', 'member', 'viewer'];
const ROLE = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
const ROLE_HINT = { owner: 'Can do everything, including delete the team', admin: 'Can invite people and manage the team', member: 'Can work on the board', viewer: 'Can look, not change' };

// A form whose submit runs `fn(values)`; errors show under the fields and the
// button says what it is doing meanwhile.
function form({ fields, submit, busy, fn, extra = [] }) {
  const err = el('p', { class: 'acct-error', role: 'alert' });
  const btn = el('button', { type: 'submit', class: 'btn btn-primary acct-go' }, submit);
  const f = el('form', { class: 'acct-form', novalidate: true }, fields, err, btn, extra);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = busy;
    let r;
    try { r = await fn(Object.fromEntries(new FormData(f))); } catch { r = { ok: false, error: 'Something went wrong. Try again.' }; }
    if (!r?.ok) {
      err.textContent = r?.error ?? 'Something went wrong. Try again.';
      btn.disabled = false;
      btn.textContent = submit;
      f.dispatchEvent(new CustomEvent('failed', { detail: r }));
    } else if (r.notice) {
      btn.disabled = false;
      btn.textContent = submit;
    }
  });
  return f;
}

const field = (label, input, hint) => el('label', { class: 'field' }, el('span', {}, label), input, hint ? el('small', { class: 'field-hint' }, hint) : null);
const input = (attrs) => el('input', { class: 'input', spellcheck: 'false', ...attrs });
const link = (text, onclick) => el('button', { type: 'button', class: 'acct-link', onclick }, text);
const heading = (title, sub) => [el('h1', {}, title), sub ? el('p', { class: 'acct-sub' }, sub) : null];
const notice = (text) => (text ? el('p', { class: 'acct-notice', role: 'status' }, text) : null);
// Sign-in for someone with no account: the same Google/GitHub sign-in the email screen offers, and the join page.
function signedOutActions() {
  const providers = [['google', 'Continue with Google'], ['github', 'Continue with GitHub']].map(([p, text]) => {
    const b = el('button', { type: 'button', class: `btn btn-provider btn-${p}` }, text);
    b.addEventListener('click', async () => { b.disabled = true; const r = await api.signInWith(p); if (!r?.ok) { b.disabled = false; flash(r?.error ?? 'Something went wrong. Try again.', true); } });
    return b;
  });
  return el('div', { class: 'acct-providers' }, providers, el('button', { type: 'button', class: 'btn', onclick: () => api.go('join') }, 'Join with an invite link'));
}
const hostTag = (host) => el('span', { class: 'acct-hosttag' }, host);

function roleSelect(value, { name = 'role', allowOwner = false, label = 'Role' } = {}) {
  const s = el('select', { class: 'input acct-select', name, 'aria-label': label });
  for (const r of ROLES) {
    if (r === 'owner' && !allowOwner && value !== 'owner') continue;
    const o = el('option', { value: r, title: ROLE_HINT[r] }, ROLE[r]);
    if (r === value) o.selected = true;
    s.append(o);
  }
  return s;
}

function toggle(on, label, onchange, { disabled = false } = {}) {
  const b = el('button', { type: 'button', role: 'switch', class: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled });
  b.addEventListener('click', async () => {
    b.disabled = true;
    const next = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(next));
    const r = await onchange(next);
    if (!r?.ok) b.setAttribute('aria-checked', String(!next));
    b.disabled = false;
    if (r && !r.ok && r.error) flash(r.error, true);
  });
  return b;
}

let flashEl = null;
function flash(text, isError = false) {
  flashEl?.remove();
  flashEl = el('p', { class: isError ? 'acct-error acct-flash' : 'acct-notice acct-flash', role: isError ? 'alert' : 'status' }, text);
  root.querySelector('.acct-card')?.prepend(flashEl);
}

let team = null; // the team the page rendered, for the invite panel's Email it

async function act(p, okText) {
  const r = await p;
  if (!r?.ok) { flash(r?.error ?? 'Something went wrong. Try again.', true); return r; }
  await render();
  if (okText || r.notice) flash(okText ?? r.notice);
  if (r.invite && team) showInvite(r.invite, team);
  return r;
}

function copyButton(text, box) {
  const b = el('button', { type: 'button', class: 'btn' }, 'Copy');
  b.addEventListener('click', async () => {
    box?.select();
    try { await navigator.clipboard.writeText(text); } catch { document.execCommand('copy'); }
    b.textContent = 'Copied';
  });
  return b;
}

// The hub shows an invite's link and code once, keeps only their hashes and
// sends no mail: copy them now, email them from your own mail app, or resend.
function showInvite(inv, team) {
  const rows = [];
  if (inv.link) {
    const box = el('input', { class: 'input acct-link-box', type: 'text', readonly: true, value: inv.link, 'aria-label': 'Invite link', onfocus: (e) => e.currentTarget.select() });
    rows.push(el('div', { class: 'acct-row-form' }, box, copyButton(inv.link, box)));
  }
  if (inv.code) rows.push(el('div', { class: 'acct-row-form' }, el('span', { class: 'acct-code', 'aria-label': 'Invite code' }, inv.code), copyButton(inv.code)));
  const mail = el('button', { type: 'button', class: 'btn btn-primary' }, 'Email it');
  mail.addEventListener('click', async () => { const r = await api.emailInvite(team, inv.id); if (!r?.ok) flash(r?.error ?? 'Something went wrong.', true); });
  const sec = el('section', { class: 'acct-section acct-linkshow', role: 'status' },
    el('p', { class: 'acct-hint' }, `Send ${inv.email || 'them'} the link or the code. They’re shown only this once; Resend makes new ones.`),
    rows, el('div', { class: 'acct-actions acct-actions-left' }, mail));
  root.querySelector('.acct-linkshow')?.remove();
  root.querySelector('.acct-section')?.after(sec);
}

// ── screens ───────────────────────────────────────────────────────────────

const SCREENS = {
  hub(s) {
    return [
      heading(s.forInvite ? 'Where is your team?' : s.brand.copy.signInHeading, s.forInvite ? 'This invite doesn’t say which team hub it’s for. Enter the address your team uses.' : s.brand.copy.signInSub),
      form({
        fields: field('Team hub address', input({ name: 'url', type: 'text', inputmode: 'url', autocomplete: 'url', placeholder: s.brand.defaultHost, value: s.lastHub ?? '', required: true, autofocus: true })),
        submit: 'Continue', busy: 'Checking…',
        fn: (v) => api.hub(v.url),
      }),
      s.forInvite ? null : el('p', { class: 'acct-foot' }, 'Have an invite? ', link('Join with it', () => api.go('join'))),
    ];
  },

  confirm(s) {
    return [
      el('h1', {}, 'Join a team on this server?'),
      el('p', { class: 'acct-host', title: s.host }, s.host),
      el('p', { class: 'acct-sub' }, 'The invite link sent you here, and you haven’t used this server before. Only continue if you trust it.'),
      el('div', { class: 'acct-actions' },
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => api.confirm(true) }, 'Continue'),
        el('button', { type: 'button', class: 'btn', onclick: () => api.confirm(false) }, 'Cancel')),
    ];
  },

  email(s) {
    const out = [heading('Sign in', null), el('p', { class: 'acct-sub' }, 'to ', hostTag(s.host), s.forInvite ? ' to accept your invite.' : '.')];
    const foot = el('p', { class: 'acct-foot' }, link('Use a different team hub', () => api.go('hub')));
    if (!s.methods) {
      out.push(el('p', { class: 'acct-error', role: 'alert' }, `Couldn’t check how to sign in to ${s.host ?? 'this server'}. ${s.methodsError ?? ''}`.trim()),
        el('div', { class: 'acct-actions' }, el('button', { type: 'button', class: 'btn btn-primary', onclick: () => render() }, 'Try again')), foot);
      return out;
    }
    const m = s.methods;
    const providers = [['google', 'Continue with Google'], ['github', 'Continue with GitHub']].filter(([p]) => m[p]).map(([p, text]) => {
      const b = el('button', { type: 'button', class: `btn btn-provider btn-${p}` }, text);
      b.addEventListener('click', async () => { b.disabled = true; const r = await api.oauth(p); if (!r?.ok) { b.disabled = false; flash(r?.error ?? 'Something went wrong. Try again.', true); } });
      return b;
    });
    if (!providers.length && !m.email) {
      out.push(el('p', { class: 'acct-hint' }, 'This server has no sign-in method enabled. Ask the admin.'), foot);
      return out;
    }
    if (providers.length) out.push(el('div', { class: 'acct-providers' }, providers));
    if (m.email) {
      const emailForm = form({
        fields: field('Email', input({ name: 'email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com', value: s.email ?? '', required: true, autofocus: !providers.length })),
        submit: 'Email me a code', busy: 'Sending…',
        fn: (v) => api.email(v.email),
      });
      const box = el('div', { class: 'acct-emailcode' }, el('p', { class: 'acct-hint' }, 'We’ll email you a 6-digit code. New here? This creates your account.'), emailForm);
      if (providers.length) {
        box.hidden = true;
        const show = link('Use an email code instead', () => { box.hidden = false; showWrap.remove(); box.querySelector('input')?.focus(); });
        const showWrap = el('p', { class: 'acct-foot acct-foot-tight' }, show);
        out.push(showWrap);
      }
      out.push(box);
    }
    out.push(foot);
    return out;
  },

  browser(s) {
    const who = { google: 'Google', github: 'GitHub' }[s.provider] ?? 'the sign-in page';
    return [
      heading('Continue in your browser', null),
      el('p', { class: 'acct-sub' }, `We opened ${who} in your browser. Sign in there, then come back here. `, s.host ? ['Signing in to ', hostTag(s.host), '.'] : null),
      el('p', { class: 'acct-hint', role: 'status' }, 'Waiting for your browser…'),
      el('div', { class: 'acct-actions' }, el('button', { type: 'button', class: 'btn', onclick: () => api.cancelOAuth() }, 'Cancel')),
    ];
  },

  code(s) {
    const code = input({ name: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12', placeholder: '123456', class: 'input input-code', required: true, autofocus: true, 'aria-label': '6-digit code' });
    const f = form({ fields: code, submit: 'Sign in', busy: 'Signing in…', fn: (v) => api.code(v.code) });
    // Paste or type the sixth digit and it goes: no hunting for the button.
    code.addEventListener('input', () => { if (code.value.replace(/\D/g, '').length === 6) f.requestSubmit(); });
    f.addEventListener('failed', () => { code.select(); });
    const resend = link('Send a new code', async () => { const r = await api.resend(); flash(r.ok ? r.notice : r.error, !r.ok); });
    return [
      heading('Check your email', null),
      // "Asked for", not "sent": the hub answers before it mails, so it can't know the mail went.
      el('p', { class: 'acct-sub' }, 'We’ve asked for a code to be sent to ', el('strong', {}, s.email ?? 'your email'), '. Enter the 6 digits. It expires in 10 minutes.'),
      f,
      el('p', { class: 'acct-foot' }, resend, el('span', { class: 'acct-dot', 'aria-hidden': 'true' }, '·'), link('Use a different email', () => api.go('email'))),
    ];
  },

  'create-team'(s) {
    if (!s.host) {
      return [heading('Create a team', 'Sign in to your team hub first. Your team lives there.'),
        el('div', { class: 'acct-actions' }, el('button', { type: 'button', class: 'btn btn-primary', onclick: () => api.go('hub') }, 'Sign in'))];
    }
    // Right after a first sign-in this is the whole choice: start a team, or join the one that invited you.
    return [
      heading('Create or join a team', null),
      el('p', { class: 'acct-sub' }, 'A team shares one board on ', hostTag(s.host), '. Start your own and invite people next.'),
      form({
        fields: field('Team name', input({ name: 'name', type: 'text', maxlength: '60', placeholder: 'e.g. Bondly', required: true, autofocus: true })),
        submit: 'Create team', busy: 'Creating…',
        fn: (v) => api.createTeam(v.name),
      }),
      el('section', { class: 'acct-section' }, el('h2', {}, 'Joining a team?'),
        el('p', { class: 'acct-hint' }, 'Paste the invite link you were sent, or type its 8-letter code.'),
        el('div', { class: 'acct-actions acct-actions-left' }, el('button', { type: 'button', class: 'btn', onclick: () => api.go('join') }, 'Join with a code or link'))),
    ];
  },

  integrations(s) {
    return [
      heading('Integrations', `Connect the tools your team already uses. Integrations live on your team hub (${s.brand.defaultHost}), so you need a team first.`),
      el('ul', { class: 'acct-connectors', 'aria-label': 'Tools you can connect' }, s.connectors.map((c) => el('li', { class: `acct-connector acct-connector-${c.status}` },
        el('h2', {}, c.name),
        el('p', { class: 'acct-hint' }, c.value),
        el('p', { class: 'acct-connector-status' }, c.statusText)))),
      s.signedInHubs.length
        ? el('p', { class: 'acct-hint' }, 'You’re signed in. Pick a team in the switcher at the top of the sidebar, then open Integrations again.')
        : [el('p', { class: 'acct-sub' }, 'Sign in to create a team or join one, then connect tools.'), signedOutActions()],
    ];
  },

  team(s) {
    if (!s.team && !s.signedInHubs.length) {
      return [
        heading('Team', 'Sign in to create a team or join one: invite teammates, see their agents live.'),
        el('p', { class: 'acct-hint' }, `Teams and integrations live on the team hub (${s.brand.defaultHost}). Your board on this Mac stays local until you do.`),
        signedOutActions(),
      ];
    }
    if (!s.team) {
      return [
        heading('Team', s.hasTeams ? 'Pick a team in the switcher at the top of the sidebar to see its members.' : 'You’re not in a team yet. Create one, or join with an invite.'),
        el('div', { class: 'acct-actions' },
          s.signedInHubs.length ? el('button', { type: 'button', class: 'btn btn-primary', onclick: () => api.go('create-team') }, 'Create a team') : el('button', { type: 'button', class: 'btn btn-primary', onclick: () => api.go('hub') }, 'Sign in'),
          el('button', { type: 'button', class: 'btn', onclick: () => api.go('join') }, 'Join with an invite')),
      ];
    }
    team = s.team.id;
    const out = [el('h1', {}, s.team.name), el('p', { class: 'acct-sub' }, `${ROLE[s.team.role] ?? s.team.role} · `, hostTag(s.host))];
    if (s.error) out.push(el('p', { class: 'acct-error', role: 'alert' }, s.error));

    if (s.canManage) {
      const role = roleSelect('member', { label: 'Role for the invite' });
      const email = input({ name: 'email', type: 'email', autocomplete: 'off', placeholder: 'name@example.com', required: true, 'aria-label': 'Email to invite' });
      const f = form({ fields: el('div', { class: 'acct-row-form' }, email, role), submit: 'Create invite', busy: 'Creating…', fn: (v) => act(api.invite(team, v.email, v.role)) });
      out.push(el('section', { class: 'acct-section' }, el('h2', {}, 'Invite people'), el('p', { class: 'acct-hint' }, s.brand.copy.inviteHint), f));
    }

    const rows = s.members.map((m) => {
      const canEdit = s.canManage && (m.role !== 'owner' || s.isOwner);
      const who = el('div', { class: 'acct-who' }, el('span', { class: 'acct-name' }, m.name || m.email, m.you ? el('span', { class: 'chip' }, 'you') : null), el('span', { class: 'acct-mail' }, m.email));
      let roleCell;
      if (canEdit) {
        roleCell = roleSelect(m.role, { allowOwner: s.isOwner, label: `Role for ${m.name || m.email}` });
        roleCell.addEventListener('change', async () => { const r = await act(api.setRole(team, m.id, roleCell.value), 'Role updated.'); if (!r?.ok) roleCell.value = m.role; });
      } else roleCell = el('span', { class: 'chip chip-role' }, ROLE[m.role] ?? m.role);
      // Two clicks, no modal: the first arms it, the second removes.
      const remove = canEdit && !m.you ? el('button', { type: 'button', class: 'btn btn-quiet', 'aria-label': `Remove ${m.name || m.email}`, onclick: (e) => {
        const b = e.currentTarget;
        if (b.dataset.armed) { act(api.removeMember(team, m.id), 'Removed.'); return; }
        b.dataset.armed = '1';
        b.textContent = 'Confirm';
        b.classList.add('btn-danger-text');
      } }, 'Remove') : el('span', { class: 'acct-spacer' });
      return el('li', { class: 'acct-item' }, who, roleCell, remove);
    });
    out.push(el('section', { class: 'acct-section' }, el('h2', {}, `Members (${s.members.length})`), el('ul', { class: 'acct-list' }, rows)));

    if (s.runners) out.push(el('section', { class: 'acct-section' }, el('h2', {}, 'Runners'), runnerRows(s)));

    if (s.canManage) {
      const rename = form({ fields: el('div', { class: 'acct-row-form' }, input({ name: 'name', type: 'text', maxlength: '60', value: s.team.name, required: true, 'aria-label': 'Team name' })), submit: 'Rename', busy: 'Saving…', fn: (v) => act(api.renameTeam(team, v.name)) });
      const board = form({ fields: el('div', { class: 'acct-row-form' }, input({ name: 'name', type: 'text', maxlength: '60', placeholder: 'e.g. Marketing', required: true, 'aria-label': 'New board name' })), submit: 'Add board', busy: 'Adding…', fn: (v) => act(api.addBoard(team, v.name)) });
      out.push(el('section', { class: 'acct-section' }, el('h2', {}, 'Team settings'), rename,
        el('p', { class: 'acct-hint' }, s.team.boards == null ? 'Add another board to this team.' : `${s.team.boards} board${s.team.boards === 1 ? '' : 's'}. Add another:`), board));
    }

    if (s.canManage) {
      const inv = s.invites.map((i) => el('li', { class: 'acct-item' },
        el('div', { class: 'acct-who' }, el('span', { class: 'acct-name' }, i.email), el('span', { class: 'acct-mail' }, expires(i.expires))),
        el('span', { class: 'chip chip-role' }, ROLE[i.role] ?? i.role),
        el('span', { class: 'acct-btns' },
          el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => act(api.resendInvite(team, i.id)) }, 'Resend'),
          el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => act(api.revokeInvite(team, i.id), 'Invite cancelled.') }, 'Revoke'))));
      out.push(el('section', { class: 'acct-section' }, el('h2', {}, 'Pending invites'), inv.length ? el('ul', { class: 'acct-list' }, inv) : el('p', { class: 'acct-hint' }, 'No invites waiting.')));
    }

    if (s.isOwner && s.team.slug) out.push(el('section', { class: 'acct-section' }, el('h2', {}, 'Delete team'), teamDelete(s)));
    return out;
  },

  join(s) {
    if (!s.invite) {
      return [
        heading('Join with an invite', 'Paste the invite link you were sent.'),
        s.error ? el('p', { class: 'acct-error', role: 'alert' }, s.error) : null,
        form({
          fields: field('Invite link or code', input({ name: 'code', type: 'text', autocomplete: 'off', placeholder: 'https://… or inv_…', required: true, autofocus: true })),
          submit: 'Continue', busy: 'Checking…',
          fn: (v) => api.joinCode(v.code),
        }),
        el('section', { class: 'acct-section' }, el('h2', {}, 'Have a code?'),
          el('p', { class: 'acct-hint' }, 'An invite also comes with an 8-letter code. It works when you’re signed in with the email address it was made for.'),
          form({
            fields: input({ name: 'code', type: 'text', autocomplete: 'off', maxlength: '9', placeholder: 'ABCD-EFGH', class: 'input input-code', required: true, 'aria-label': 'Invite code' }),
            submit: 'Join', busy: 'Joining…',
            fn: (v) => api.acceptCode(v.code),
          })),
      ];
    }
    const err = el('p', { class: 'acct-error', role: 'alert' });
    const more = el('div', { class: 'acct-actions' });
    const go = el('button', { type: 'button', class: 'btn btn-primary' }, 'Join team');
    go.addEventListener('click', async () => {
      go.disabled = true; go.textContent = 'Joining…'; err.textContent = ''; more.textContent = '';
      const r = await api.accept(s.invite.id);
      if (r?.ok) return;
      go.disabled = false; go.textContent = 'Join team';
      err.textContent = r?.error ?? 'Something went wrong. Try again.';
      if (r?.wrongAccount) more.append(el('button', { type: 'button', class: 'btn', onclick: () => api.switchAccount() }, 'Switch account'));
      if (r?.alreadyIn) { go.hidden = true; more.append(el('button', { type: 'button', class: 'btn btn-primary', onclick: () => api.openTeam(r.alreadyIn) }, 'Open it')); }
    });
    return [
      el('p', { class: 'acct-kicker' }, 'Invite'),
      el('h1', {}, `Join ${s.invite.team}?`),
      el('p', { class: 'acct-sub' }, `${s.invite.inviter || 'Someone'} invited you to join as ${(ROLE[s.invite.role] ?? s.invite.role).toLowerCase()}.`),
      el('p', { class: 'acct-hint' }, s.email ? `Signed in as ${s.email} on ` : 'On ', hostTag(s.host)),
      err,
      el('div', { class: 'acct-actions' }, go, el('button', { type: 'button', class: 'btn', onclick: () => api.notNow() }, 'Not now')),
      more,
    ];
  },

  invites(s) {
    const rows = s.invites.map((i) => {
      const b = el('button', { type: 'button', class: 'btn btn-primary' }, 'Join');
      b.addEventListener('click', async () => { b.disabled = true; const r = await api.acceptPending(i.id); if (!r?.ok) { b.disabled = false; flash(r?.error ?? 'Something went wrong.', true); } });
      return el('li', { class: 'acct-item' }, el('div', { class: 'acct-who' }, el('span', { class: 'acct-name' }, i.team), el('span', { class: 'acct-mail' }, `${i.inviter} invited you as ${(ROLE[i.role] ?? i.role).toLowerCase()}`)), b);
    });
    return [
      heading(s.invites.length === 1 ? `You’ve been invited to ${s.invites[0].team}` : 'You’ve been invited', 'Join now, or later with the link in your email.'),
      el('ul', { class: 'acct-list' }, rows),
      el('p', { class: 'acct-foot' }, link('Not now', () => api.skipInvites())),
    ];
  },

  account(s) {
    if (!s.accounts.length) {
      return [heading('Account', 'You’re not signed in to a team hub.'), el('div', { class: 'acct-actions' }, el('button', { type: 'button', class: 'btn btn-primary', onclick: () => api.go('hub') }, 'Sign in'))];
    }
    const out = [heading('Account', null)];
    for (const a of s.accounts) {
      const card = el('section', { class: 'acct-section' },
        el('div', { class: 'acct-who acct-who-lg' }, el('span', { class: 'acct-name' }, a.name || a.email), el('span', { class: 'acct-mail' }, a.email, ' · ', hostTag(a.host))));
      if (s.deleting === a.host && s.deleteCheck) {
        card.append(...deleteCheck(s.deleteCheck, {
          host: a.host, intro: `To delete your account on ${a.host}, confirm it’s you first.`, warn: `You’ll leave every team on ${a.host}. This can’t be undone.`,
          submit: 'Delete my account', del: () => api.deleteConfirm(''), pick: (id) => api.deleteOAuth(id),
        }));
      } else if (s.deleting === a.host) {
        card.append(
          el('p', { class: 'acct-hint' }, `We’ve asked for a code to be sent to ${a.email}. Enter it to delete your account on ${a.host}. You’ll leave every team there. This can’t be undone.`),
          form({
            fields: input({ name: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12', placeholder: '123456', class: 'input input-code', 'aria-label': '6-digit code', autofocus: true }),
            submit: 'Delete my account', busy: 'Deleting…', fn: (v) => api.deleteConfirm(v.code),
            extra: el('p', { class: 'acct-foot' },
              link('Send a new code', async () => { const r = await api.deleteStart(a.host); flash(r.ok ? `We’ve asked for a new code to be sent to ${a.email}.` : r.error, !r.ok); }),
              el('span', { class: 'acct-dot', 'aria-hidden': 'true' }, '·'),
              link('Cancel', async () => { await api.cancelDelete(); render(); })),
          }));
        card.querySelector('.acct-go').classList.add('btn-danger');
      } else {
        card.append(el('div', { class: 'acct-actions acct-actions-left' },
          el('button', { type: 'button', class: 'btn', onclick: (e) => { e.currentTarget.disabled = true; api.signOut(a.host); } }, 'Sign out'),
          el('button', { type: 'button', class: 'btn btn-quiet btn-danger-text', onclick: async () => { const r = await api.deleteStart(a.host); if (r.ok) render(); else flash(r.error, true); } }, 'Delete account…')));
      }
      out.push(card);
    }
    out.push(el('p', { class: 'acct-foot' }, link('Sign in to another team hub', () => api.go('hub'))));
    return out;
  },

  thismac(s) {
    const out = [heading('This Mac', 'Let your team hand cards to Claude on this Mac. Runs happen here, with your own setup.')];
    if (!s.hubs.length || s.hubs.every((h) => !h.teams.length)) {
      out.push(el('p', { class: 'acct-hint' }, 'Sign in and join a team to run cards here.'));
      return out;
    }
    for (const h of s.hubs) {
      const sec = el('section', { class: 'acct-section' }, el('h2', {}, h.host));
      const sums = toggle(h.summaries && h.share, `Include one-line summaries for every team on ${h.host}`, (on) => api.summaries(h.host, on), { disabled: !h.share });
      sec.append(el('div', { class: 'acct-item acct-item-toggle' },
        el('div', { class: 'acct-who' }, el('span', { class: 'acct-name' }, 'Share my live sessions'), el('span', { class: 'acct-mail' }, `Applies to every team on ${h.host}: everyone in them sees which linked repos and branches your Claude sessions are working in, and whether they’re working. Your folder paths never leave this computer. Off unless you turn it on.`)),
        toggle(h.share, `Share my live sessions with every team on ${h.host}`, async (on) => { const r = await api.presence(h.host, on); if (r?.ok) render(); return r; })));
      sec.append(el('div', { class: 'acct-item acct-item-toggle acct-item-sub' },
        el('div', { class: 'acct-who' }, el('span', { class: 'acct-name' }, 'Include one-line summaries'), el('span', { class: 'acct-mail' }, h.share ? `Adds a short line about what each session is doing, for every team on ${h.host}. Paths are removed before it leaves this Mac. Off unless you turn it on.` : 'Turn on sharing first.')),
        sums));
      for (const t of h.teams) {
        const viewer = t.role === 'viewer';
        const ended = t.state === 'removed';
        const again = ended && !viewer ? link('Turn on again', () => act(api.runner(t.id, true))) : null;
        sec.append(el('div', { class: 'acct-item acct-item-toggle' },
          el('div', { class: 'acct-who' }, el('span', { class: 'acct-name' }, `Run ${t.name} cards`), el('span', { class: 'acct-mail', 'data-state': t.state }, viewer ? 'Viewers can’t run cards.' : ended ? `This Mac isn’t sharing sessions with ${t.name} any more.` : runnerText(t)), again),
          toggle(t.enabled, `Run ${t.name} cards on this Mac`, (on) => act(api.runner(t.id, on)), { disabled: viewer })));
      }
      out.push(sec);
    }
    return out;
  },
};

let tick = null; // the delete countdown's timer; each render starts fresh

const cancelLink = () => link('Cancel', async () => { await api.cancelDelete(); render(); });

// Deleting a team: type its slug, then an emailed code (or Google/GitHub on a hub without a mailer),
// then Delete team while the check lasts. It is only ever for the team on screen.
function teamDelete(s) {
  const d = s.team.deleteStep;
  const warn = `Everyone loses ${s.team.name}, its boards and its cards at once, and runners stop. This can’t be undone from the app.`;
  if (!d) {
    const f = form({
      fields: field(`Type ${s.team.slug} to confirm`, input({ name: 'slug', type: 'text', autocomplete: 'off', required: true, placeholder: s.team.slug })),
      submit: s.team.deleteVia === 'email' ? 'Send me a code' : 'Continue', busy: s.team.deleteVia === 'email' ? 'Sending…' : 'Checking…',
      fn: async (v) => { const r = await api.teamDeleteStart(team, v.slug); if (r?.ok) render(); return r; },
    });
    return [el('p', { class: 'acct-hint' }, warn), f];
  }
  if (d.via === 'email' && d.phase === 'code') {
    const f = form({
      fields: input({ name: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12', placeholder: '123456', class: 'input input-code', 'aria-label': '6-digit code', autofocus: true }),
      submit: 'Confirm', busy: 'Checking…', fn: async (v) => { const r = await api.teamDeleteCode(team, v.code); if (r?.ok) render(); return r; },
      extra: el('p', { class: 'acct-foot' },
        link('Send a new code', async () => { const r = await api.teamDeleteResend(team); flash(r.ok ? r.notice : r.error, !r.ok); }),
        el('span', { class: 'acct-dot', 'aria-hidden': 'true' }, '·'),
        cancelLink()),
    });
    return [el('p', { class: 'acct-hint' }, `We’ve asked for a code to be sent to ${d.email ?? 'your email'}. Enter it to confirm it’s you before deleting ${s.team.name}.`), f];
  }
  return deleteCheck(d, {
    host: s.host, intro: `To delete ${s.team.name}, confirm it’s you first.`, warn, submit: 'Delete team',
    del: () => api.deleteTeam(team), pick: (id) => api.teamDeleteOAuth(team, id),
  });
}

// Google or GitHub confirms it's you (or, for a team, the emailed code did), then the delete button
// works for the few minutes the hub allows. Provider names are text, never markup.
function deleteCheck(c, { host, intro, warn, submit, del, pick }) {
  if (c.phase === 'browser') {
    return [
      el('p', { class: 'acct-hint' }, `We opened ${c.provider} in your browser. Sign in there with the account you use for ${host}, then come back here.`),
      el('p', { class: 'acct-hint', role: 'status' }, 'Waiting for your browser…'),
      el('div', { class: 'acct-actions acct-actions-left' }, el('button', { type: 'button', class: 'btn', autofocus: true, onclick: async () => { await api.cancelDeleteOAuth(); render(); } }, 'Cancel')),
    ];
  }
  if (c.phase === 'confirmed') {
    const left = el('span', {}, clock(c.secondsLeft));
    const end = Date.now() + c.secondsLeft * 1000;
    tick = setInterval(() => {
      const s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      left.textContent = clock(s);
      if (s === 0) { clearInterval(tick); tick = null; render(); }
    }, 1000);
    const f = form({ fields: [], submit, busy: 'Deleting…', fn: del });
    f.querySelector('.acct-go').classList.add('btn-danger');
    f.addEventListener('failed', (e) => { if (e.detail?.stepUp) render().then(() => flash(e.detail.error, true)); });
    return [
      el('p', { class: 'acct-hint', role: 'status' }, `Confirmed with ${c.provider}. ${warn}`),
      // The main area is a polite live region; a per-second tick there would be read out every second.
      el('p', { class: 'acct-hint', 'aria-live': 'off' }, 'Delete within ', left, ', or confirm again.'),
      f,
      el('p', { class: 'acct-foot' }, cancelLink()),
    ];
  }
  const buttons = c.providers.map((p) => {
    const b = el('button', { type: 'button', class: `btn btn-provider btn-${p.id}` }, `Confirm it’s you with ${p.name}`);
    b.addEventListener('click', async () => { b.disabled = true; const r = await pick(p.id); if (r?.ok) render(); else { b.disabled = false; flash(r?.error ?? 'Something went wrong. Try again.', true); } });
    return b;
  });
  return [
    el('p', { class: 'acct-hint' }, `${intro} ${warn}`),
    el('div', { class: 'acct-providers' }, buttons),
    el('p', { class: 'acct-foot' }, cancelLink()),
  ];
}

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// This team's runners, as text: name, who, online or last seen, "this Mac". Revoke only where the hub would allow it.
function runnerRows(s) {
  if (!s.runners.length) return el('p', { class: 'acct-hint' }, s.canManage ? 'No Macs run this team’s cards yet.' : 'You have no Macs running this team’s cards.');
  return el('ul', { class: 'acct-list' }, s.runners.map((r) => el('li', { class: 'acct-item' },
    el('div', { class: 'acct-who' },
      el('span', { class: 'acct-name' }, r.name || 'A Mac', r.current ? el('span', { class: 'chip' }, 'this Mac') : null),
      el('span', { class: 'acct-mail' }, [r.person, r.online ? 'Online' : lastSeen(r.lastSeenAt)].filter(Boolean).join(' · '))),
    r.canRevoke ? el('button', { type: 'button', class: 'btn btn-quiet', 'aria-label': `Remove ${r.name || 'this runner'}`, onclick: (e) => {
      const b = e.currentTarget;
      if (b.dataset.armed) { act(api.revokeRunner(team, r.id)); return; }
      b.dataset.armed = '1';
      b.textContent = 'Confirm';
      b.classList.add('btn-danger-text');
    } }, 'Remove') : el('span', { class: 'acct-spacer' }))));
}

function lastSeen(iso) {
  const ms = Date.now() - Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return 'Not seen yet';
  const min = Math.round(ms / 60_000);
  if (min < 2) return 'Seen just now';
  if (min < 60) return `Seen ${min} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `Seen ${h} hour${h === 1 ? '' : 's'} ago`;
  return `Seen ${Math.round(h / 24)} days ago`;
}

const RUNNER = {
  off: 'Off', starting: 'Starting…', connecting: 'Connecting…', connected: 'Running', backoff: 'Reconnecting…', restarting: 'Restarting…',
  unavailable: 'Can’t reach the team hub right now.', stopping: 'Stopping…',
};
function runnerText(t) {
  const base = !t.enabled && t.state === 'off' ? 'Off' : (['missing', 'failed'].includes(t.state) ? (t.detail ?? 'Stopped') : (RUNNER[t.state] ?? t.state));
  const parts = [base];
  if (t.parked > 0) parts.push(`Parked ${t.parked} run${t.parked === 1 ? '' : 's'}`);
  if (t.parkedPending > 0) parts.push(`${t.parkedPending} run${t.parkedPending === 1 ? ' is' : 's are'} being handed over`);
  return parts.join(' · ');
}

function expires(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return 'Waiting';
  const days = Math.round(ms / 86_400_000);
  return days >= 1 ? `Expires in ${days} day${days === 1 ? '' : 's'}` : 'Expires today';
}

const WIDE = new Set(['team', 'account', 'thismac', 'invites', 'integrations']);

async function render() {
  if (tick) { clearInterval(tick); tick = null; }
  let s;
  try { s = await api.state(); } catch { s = null; }
  if (!s?.ok) return;
  const draw = SCREENS[s.screen ?? screen] ?? SCREENS.hub;
  const alert = s.alert ? el('p', { class: 'acct-error', role: 'alert' }, s.alert) : null;
  const card = el('div', { class: `acct-card${WIDE.has(s.screen) ? ' acct-card-wide' : ''}` }, notice(s.notice), alert, draw(s));
  document.title = s.brand?.name ?? '';
  root.textContent = '';
  root.dataset.screen = s.screen ?? screen;
  root.append(card);
  root.querySelector('[autofocus]')?.focus();
}

api.onChanged(() => { if (screen === 'thismac') render(); });
render();
