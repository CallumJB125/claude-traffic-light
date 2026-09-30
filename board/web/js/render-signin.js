// Sign-in states (CONTRACT §4.1): Cloudflare Access in production, a dev-login
// stub only when the hub runs with BOARD_AUTH=dev on loopback.
import { h } from './h.js';
import { pixelClaude } from './icons.js';

export function signinScreen({ status, error, devLogin, busy, email }) {
  const forbidden = status === 'forbidden';
  return h('div', { class: 'app app-center' },
    h('main', { class: 'signin', 'aria-labelledby': 'signin-title' },
      pixelClaude({ eyes: forbidden ? 'shut' : 'open', lamps: forbidden ? { red: true } : { amber: true }, cls: 'signin-mark' }),
      h('h1', { id: 'signin-title' }, forbidden ? 'Not on this board yet' : 'Sign in to the board'),
      forbidden
        ? h('p', null, `${email ? `You're signed in as ${email}, but that` : 'Your account'} isn't a member of this board. Ask a board admin to add your GitHub login and email.`)
        : h('p', null, 'The team board sits behind Cloudflare Access. Sign in with GitHub to see cards and give work to Claude.'),
      forbidden
        ? h('a', { class: 'btn', href: '/cdn-cgi/access/logout' }, 'Sign in with another account')
        : h('a', { class: 'btn btn-primary', href: '/', 'data-action': 'access-login' }, 'Sign in with GitHub'),
      error ? h('p', { class: 'form-error', role: 'alert' }, error) : null,
      devLogin && !forbidden ? h('form', { class: 'devlogin', 'data-form': 'devlogin', 'aria-labelledby': 'devlogin-title' },
        h('h2', { id: 'devlogin-title' }, 'Dev login'),
        h('p', { class: 'hint' }, 'Only on a hub bound to localhost with BOARD_AUTH=dev.'),
        h('div', { class: 'devlogin-row' },
          ['alice', 'bob'].map((l) => h('button', { type: 'submit', class: 'btn btn-sm', name: 'login', value: l, disabled: busy || null }, l)),
          h('label', { class: 'sr-only', for: 'dev-login' }, 'GitHub login'),
          h('input', { id: 'dev-login', name: 'github_login', class: 'input input-sm num', placeholder: 'github login', autocomplete: 'off', spellcheck: 'false' }),
          h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: busy || null }, 'Sign in'))) : null));
}
