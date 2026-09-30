// Dev only (unpackaged, `--buddy-mock-accounts --buddy-accounts-walk <prefix>`):
// walk the account flow against the mock hub the way a person would, typing
// into the real pages, and capture each step as <prefix>-<step>.png.
'use strict';

const { createAccountClient } = require('./accounts');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function walkAccounts({ buddy, mock, hub, prefix, fs }) {
  const page = (js) => buddy.devPage(js);
  async function until(label, fn, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await Promise.resolve().then(fn).catch(() => false)) return; await wait(100); }
    throw new Error(`timed out waiting for ${label} (${JSON.stringify(buddy.status())})`);
  }
  const onScreen = (screen) => until(`screen ${screen}`, async () => buddy.status().screen === screen && (await page(`document.getElementById('acct')?.dataset.screen === ${JSON.stringify(screen)}`)));
  const fill = (sel, v) => page(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const submit = () => page("document.querySelector('form').requestSubmit(), true");
  const click = (text) => page(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); b.click(); return true; })()`);
  async function shot(name, { sidebar = false } = {}) {
    await wait(600);
    const s = await buddy.capture();
    fs.writeFileSync(`${prefix}-${name}.png`, s.content.toPNG());
    if (sidebar) fs.writeFileSync(`${prefix}-${name}-sidebar.png`, s.sidebar.toPNG());
    console.log('[walk]', name, JSON.stringify(buddy.status()));
  }

  await wait(1200);
  buddy.select('account');
  await onScreen('account');
  await click('Sign in');
  await onScreen('hub');
  await fill('input[name=url]', hub);
  await shot('01-signin', { sidebar: true });
  await submit();
  await onScreen('email');
  await fill('input[name=email]', 'callum@example.com');
  await shot('02-email');
  await submit();
  await onScreen('code');
  await shot('03-code');
  // Typing the sixth digit submits on its own.
  await fill('input[name=code]', mock.lastCode('callum@example.com'));
  await onScreen('create-team');
  await shot('04-create-team');
  await fill('input[name=name]', 'Bondly');
  await submit();
  await onScreen('team');
  await fill('input[name=email]', 'sam@example.com');
  await submit();
  await until('invite listed', () => page("document.body.textContent.includes('sam@example.com') && document.querySelectorAll('.acct-list').length === 2"));
  await shot('05-team', { sidebar: true });

  // Someone else invites us to their team; the deep link opens the preview.
  let luke = null;
  const lukeClient = createAccountClient({ origin: hub, store: { load: () => luke, save: (o) => { luke = o; }, clear: () => { luke = null; } } });
  await lukeClient.startEmail('luke@example.com');
  await lukeClient.verifyCode(mock.lastCode('luke@example.com'), { deviceName: 'Luke’s Mac' });
  const pistor = await lukeClient.createTeam('Pistor');
  const inv = await lukeClient.invite(pistor.team.id, 'callum@example.com', 'member');
  buddy.openInvite(`claudebuddy://invite/${inv.code}`);
  await onScreen('join');
  await until('preview', () => page("document.body.textContent.includes('Join Pistor?')"));
  await shot('06-join-preview');
  await click('Join team');
  await until('board', () => buddy.status().url?.includes('org=') ?? false);
  await shot('07-board', { sidebar: true });

  // A link naming a server we have never used asks first.
  buddy.openInvite('claudebuddy://join?hub=https://buddy.stranger.example&t=inv_abc123');
  await onScreen('confirm');
  await shot('08-confirm-unknown-hub');
  await click('Cancel');

  buddy.select('thismac');
  await onScreen('thismac');
  await shot('09-this-mac');
  buddy.select('account');
  await onScreen('account');
  await shot('10-account');

  // Sign out, then sign in as the person Bondly invited: their invite is waiting.
  await click('Sign out');
  await until('signed out', () => page("document.body.textContent.includes('Signed out of')"));
  await click('Sign in');
  await onScreen('hub');
  await submit();
  await onScreen('email');
  await fill('input[name=email]', 'sam@example.com');
  await submit();
  await onScreen('code');
  await fill('input[name=code]', '000000'.replace(/0/g, () => '9'));
  await until('wrong code shown', () => page("!!document.querySelector('.acct-error')?.textContent"));
  await shot('11-wrong-code');
  await fill('input[name=code]', mock.lastCode('sam@example.com'));
  await onScreen('invites');
  await shot('12-pending-invites', { sidebar: true });
}

module.exports = { walkAccounts };
