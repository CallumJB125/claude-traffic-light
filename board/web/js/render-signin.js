// Sign-in states (CONTRACT §4.1): Cloudflare Access in production, a dev-login
// stub only when the hub runs with BOARD_AUTH=dev on loopback, and in accounts
// mode the email sign-in link and, once signed in with no team yet, the
// create-or-join screen.
import { h } from './h.js';
import { pixelClaude } from './icons.js';
import { EMAIL_OFF } from './account-text.js';

export function signinScreen({ status, error, devLogin, devSecretKnown = false, busy, email, accounts = false, emailOff = false }) {
  const forbidden = status === 'forbidden';
  return h('div', { class: 'app app-center' },
    h('main', { class: 'signin', 'aria-labelledby': 'signin-title' },
      pixelClaude({ eyes: forbidden ? 'shut' : 'open', lamps: forbidden ? { red: true } : { amber: true }, cls: 'signin-mark' }),
      h('h1', { id: 'signin-title' }, forbidden ? 'Not on this board yet' : 'Sign in to the board'),
      forbidden
        ? h('p', null, `${email ? `You're signed in as ${email}, but that` : 'Your account'} isn't a member of this board. Ask a board admin to add your GitHub login and email.`)
        : h('p', null, accounts ? (emailOff ? EMAIL_OFF : 'Sign in with your email to see cards and give work to Claude.') : 'The team board sits behind Cloudflare Access. Sign in with GitHub to see cards and give work to Claude.'),
      forbidden
        ? (accounts ? null : h('a', { class: 'btn', href: '/cdn-cgi/access/logout' }, 'Sign in with another account'))
        : accounts
          ? (emailOff ? null : h('a', { class: 'btn btn-primary', href: '/signin' }, 'Sign in with email'))
          : h('a', { class: 'btn btn-primary', href: '/', 'data-action': 'access-login' }, 'Sign in with GitHub'),
      error ? h('p', { class: 'form-error', role: 'alert' }, error) : null,
      devLogin && !forbidden ? h('form', { class: 'devlogin', 'data-form': 'devlogin', 'aria-labelledby': 'devlogin-title' },
        h('h2', { id: 'devlogin-title' }, 'Dev login'),
        h('p', { class: 'hint' }, 'Only on a hub bound to localhost with BOARD_AUTH=dev, never behind a proxy or tunnel. Open the URL the hub printed at startup, or paste its dev secret.'),
        devSecretKnown ? null : h('div', { class: 'devlogin-row' },
          h('label', { class: 'sr-only', for: 'dev-secret' }, 'Dev secret'),
          h('input', { id: 'dev-secret', name: 'dev_secret', type: 'password', class: 'input input-sm num', placeholder: 'dev secret', autocomplete: 'off' })),
        h('div', { class: 'devlogin-row' },
          ['alice', 'bob'].map((l) => h('button', { type: 'submit', class: 'btn btn-sm', name: 'login', value: l, disabled: busy || null }, l)),
          h('label', { class: 'sr-only', for: 'dev-login' }, 'GitHub login'),
          h('input', { id: 'dev-login', name: 'github_login', class: 'input input-sm num', placeholder: 'github login', autocomplete: 'off', spellcheck: 'false' }),
          h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: busy || null }, 'Sign in'))) : null));
}

const ROLE_WORD = { admin: 'an admin', member: 'a member', viewer: 'a viewer' };

/**
 * Accounts mode, signed in, in no team yet (a new account): create one, join
 * with a code or invite link, or take an invite already addressed to you.
 * `onboard`: {busy, error, where} where the error belongs to 'create' or 'join'.
 */
export function noTeamScreen({ invites = [], onboard = {} }) {
  const err = (where) => (onboard.error && onboard.where === where ? h('p', { class: 'form-error', role: 'alert' }, onboard.error) : null);
  const busy = onboard.busy || null;
  return h('div', { class: 'app app-center' },
    h('main', { class: 'signin', 'aria-labelledby': 'noteam-title' },
      pixelClaude({ eyes: 'open', lamps: { green: true }, cls: 'signin-mark' }),
      h('h1', { id: 'noteam-title' }, 'Create or join a team'),
      h('p', null, 'You’re signed in. A team shares one board: start your own, or join the team that invited you.'),
      invites.length ? h('section', { class: 'signin-section', 'aria-labelledby': 'noteam-invites' },
        h('h2', { id: 'noteam-invites' }, invites.length === 1 ? 'An invite for you' : 'Invites for you'),
        invites.map((i) => h('div', { key: String(i.id), class: 'signin-row' },
          h('p', { class: 'hint' }, `${String(i.inviter_first_name ?? 'Someone').slice(0, 60)} invited you to ${String(i.team_name ?? 'a team').slice(0, 60)} as ${ROLE_WORD[i.role] ?? 'a member'}.`),
          h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'accept-invite', 'data-invite': String(i.id), disabled: busy }, 'Join'))),
        err('invites')) : null,
      h('section', { class: 'signin-section', 'aria-labelledby': 'noteam-create' },
        h('h2', { id: 'noteam-create' }, 'Create a team'),
        h('form', { class: 'signin-row', 'data-form': 'create-team' },
          h('label', { class: 'sr-only', for: 'team-name' }, 'Team name'),
          h('input', { id: 'team-name', name: 'name', class: 'input', maxlength: '60', placeholder: 'Team name', autocomplete: 'organization', required: true }),
          h('button', { type: 'submit', class: 'btn btn-primary', disabled: busy }, 'Create team')),
        err('create')),
      h('section', { class: 'signin-section', 'aria-labelledby': 'noteam-join' },
        h('h2', { id: 'noteam-join' }, 'Join with a code or invite link'),
        h('p', { class: 'hint' }, 'Paste the link from your invite email, or type its 8-letter code.'),
        h('form', { class: 'signin-row', 'data-form': 'join-team' },
          h('label', { class: 'sr-only', for: 'join-input' }, 'Invite link or code'),
          h('input', { id: 'join-input', name: 'invite', class: 'input', placeholder: 'ABCD-EFGH or the link', autocomplete: 'off', spellcheck: 'false', required: true }),
          h('button', { type: 'submit', class: 'btn', disabled: busy }, 'Join')),
        err('join')),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'signout', disabled: busy }, 'Sign out')));
}
