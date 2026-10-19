// Email-code sign-in is opt-in (BOARD_EMAIL_SIGNIN=1): a mailer configured for
// invites never offers or accepts a sign-in code by itself. Step-up codes for a
// signed-in account still go by mail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { startAccounts } from './accounts-helpers.js';

test('config: BOARD_EMAIL_SIGNIN is off unless set to 1', () => {
  const env = { BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_ACCOUNTS_DEV: '1', BOARD_RESEND_API_KEY: 're_x', BOARD_MAIL_FROM: 'a@b.co' };
  assert.equal(loadConfig({ ...env }).emailSignin, false);
  assert.equal(loadConfig({ ...env, BOARD_EMAIL_SIGNIN: '1' }).emailSignin, true);
});

test('a hub with a mailer but no BOARD_EMAIL_SIGNIN: methods says no email, a sign-in code can be neither started nor verified, no mail goes', async () => {
  const h = await startAccounts({ config: { emailSignin: false } });
  try {
    assert.ok(h.hub.accounts.mailer, 'a mailer is configured (invites)');
    const m = await h.call('GET', '/api/auth/methods');
    assert.equal(m.body.email, false);
    const s = await h.start('alice@dev.local');
    assert.equal(s.status, 404);
    assert.equal(s.body.error.code, 'METHOD_DISABLED');
    const w = await h.start('alice@dev.local', { client: 'web' });
    assert.equal(w.body.error.code, 'METHOD_DISABLED');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM login_flows').n, 0, 'nothing written');
    assert.equal(h.mailer.last('alice@dev.local'), null, 'nothing mailed');
  } finally {
    await h.close();
  }
});

test('turning email sign-in off strands open sign-in codes; a signed-in account\'s step-up code still works with only the mailer', async () => {
  const h = await startAccounts();
  try {
    const me = await h.signIn('alice@dev.local');
    assert.equal(me.status, 200, me.text);
    const open = await h.start('bob@dev.local');
    assert.equal(open.status, 200);
    h.hub.config.emailSignin = false;
    assert.equal((await h.call('GET', '/api/auth/methods')).body.email, false);
    const v = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: open.body.flow_id, code: h.codeFor('bob@dev.local') } });
    assert.equal(v.status, 404);
    assert.equal(v.body.error.code, 'METHOD_DISABLED');
    const flowId = await h.stepUp(me.body.device_token, 'alice@dev.local');
    assert.match(flowId, /\S/);
  } finally {
    await h.close();
  }
});
