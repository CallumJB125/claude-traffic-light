// Slack request verification, parsing, binding and output hygiene (the pure
// half of the Slack connector), with recorded-shape fixtures
// (test/fixtures/slack/). Signing secrets are random per run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  verify, sign, dedupeKey, parseBody, ackEarly, bindingOf, responseUrlOk, escapeMrkdwn, cleanTitle, sealMeta, openMeta, metaExpired,
} from '../integrations/slack/webhook.js';
import { raw, fixture, signed, interactionBody, commandBody, signingSecret, nowS, CONFIG } from './slack-shim.js';

const SECRET = signingSecret();
const secrets = { signing_secret: SECRET };
const check = (req, opts = {}) => verify({ ...req, secrets: opts.secrets ?? secrets, now: opts.now ?? Date.now() });
const form = (body) => ({ 'content-type': 'application/x-www-form-urlencoded' });
const json = { 'content-type': 'application/json' };

test('verify: a correctly signed command passes with a signed-timestamp replay key', () => {
  const r = check(signed(SECRET, raw('slash-command-todo.form')));
  assert.equal(r.ok, true);
  assert.match(r.dedupe_key, /^ia:\d+:[0-9a-f]{32}$/);
});

test('verify: forged, missing, malformed, tampered, wrong-secret and short-secret requests fail', () => {
  const body = raw('slash-command-todo.form');
  const good = signed(SECRET, body);
  const refuse = (req, opts, reason) => { const r = check(req, opts); assert.equal(r.ok, false); if (reason) assert.equal(r.reason, reason); };
  refuse(signed(SECRET, body, { sig: `v0=${'0'.repeat(64)}` }), {}, 'signature mismatch');
  refuse({ headers: { 'content-type': good.headers['content-type'] }, rawBody: body }, {}, 'bad timestamp');
  refuse({ headers: { ...good.headers, 'x-slack-signature': undefined }, rawBody: body }, {}, 'bad signature format');
  refuse(signed(SECRET, body, { sig: good.headers['x-slack-signature'].replace('v0=', 'v1=') }), {}, 'bad signature format');
  refuse(signed(SECRET, body, { sig: good.headers['x-slack-signature'].slice(0, -1) }), {}, 'bad signature format');
  refuse(signed(SECRET, body, { sig: `v0=${'z'.repeat(64)}` }), {}, 'bad signature format');
  refuse(signed(SECRET, body, { ts: '12a4' }), {}, 'bad timestamp');
  const tampered = Buffer.from(body); tampered[10] ^= 1;
  refuse({ headers: good.headers, rawBody: tampered }, {}, 'signature mismatch');
  refuse(signed(signingSecret(), body), {}, 'signature mismatch');
  refuse(good, { secrets: { signing_secret: 'short' } }, 'no signing secret');
  refuse(good, { secrets: {} }, 'no signing secret');
});

test('verify: a timestamp 301 s stale or 301 s in the future is refused; 300 s either way passes', () => {
  const body = raw('slash-command-todo.form');
  const now = Date.now();
  const at = (d) => check(signed(SECRET, body, { ts: Math.floor(now / 1000) + d }), { now });
  assert.equal(at(-301).ok, false);
  assert.equal(at(-301).reason, 'timestamp outside window');
  assert.equal(at(301).ok, false);
  assert.equal(at(-300).ok, true);
  assert.equal(at(300).ok, true);
});

test('verify: the failure reason never echoes the request', () => {
  const evil = 'INJECTED<script>';
  const r = check({ headers: { 'x-slack-request-timestamp': evil, 'x-slack-signature': evil }, rawBody: Buffer.from(evil) });
  assert.ok(!r.reason.includes('INJECTED'));
  const r2 = check(signed(SECRET, Buffer.from(evil), { sig: `v0=${'a'.repeat(64)}` }));
  assert.ok(!r2.reason.includes('INJECTED'));
});

test('dedupe keys: ev:<event_id> for events, uv: for url_verification, ia:<ts>:<hash> for form bodies', () => {
  const ev = Buffer.from(JSON.stringify({ type: 'event_callback', event_id: 'Ev0EVENT01', team_id: 'T0TEAM1', api_app_id: 'A0APP01', event: { type: 'app_mention' } }));
  assert.equal(dedupeKey('1', ev), 'ev:Ev0EVENT01');
  assert.equal(dedupeKey('2', ev), 'ev:Ev0EVENT01', 'a Slack retry (new timestamp, same body) is the same event');
  assert.match(dedupeKey('5', raw('url-verification.json')), /^uv:5:[0-9a-f]{32}$/);
  const a = dedupeKey('5', raw('slash-command-todo.form'));
  assert.equal(a, dedupeKey('5', raw('slash-command-todo.form')));
  assert.notEqual(a, dedupeKey('6', raw('slash-command-todo.form')));
  assert.notEqual(a, dedupeKey('5', commandBody({ trigger_id: '1.2.00000000000000000000000000000000' })));
});

test('parseBody: commands, interactions (payload= JSON), url_verification and ssl_check', () => {
  const c = parseBody({ rawBody: raw('slash-command-todo.form'), headers: form() });
  assert.equal(c.kind, 'command');
  assert.equal(c.body.command, '/plex');
  assert.equal(c.body.team_id, 'T0TEAM1');
  const i = parseBody({ rawBody: interactionBody(fixture('message-action.json')), headers: form() });
  assert.deepEqual([i.kind, i.body.type, i.body.callback_id], ['interaction', 'message_action', 'plex_create_card']);
  assert.deepEqual(parseBody({ rawBody: raw('url-verification.json'), headers: json }), { kind: 'url_verification', body: { challenge: fixture('url-verification.json').challenge } });
  assert.equal(parseBody({ rawBody: Buffer.from('ssl_check=1&token=x'), headers: form() }).kind, 'ssl_check');
});

test('parseBody: JSON only for events, form only for commands and interactivity', () => {
  assert.throws(() => parseBody({ rawBody: raw('slash-command-todo.form'), headers: json }));
  assert.throws(() => parseBody({ rawBody: raw('url-verification.json'), headers: form() }));
  assert.throws(() => parseBody({ rawBody: raw('url-verification.json'), headers: { 'content-type': 'text/plain' } }));
  assert.throws(() => parseBody({ rawBody: Buffer.from(JSON.stringify({ type: 'block_actions' })), headers: json }), 'interactions never come as JSON');
});

test('parseBody: prototype keys, duplicate or odd fields, extra fields beside payload and oversize bodies are refused', () => {
  assert.throws(() => parseBody({ rawBody: Buffer.from('payload=' + encodeURIComponent('{"type":"block_actions","__proto__":{"x":1}}')), headers: form() }));
  assert.throws(() => parseBody({ rawBody: Buffer.from('payload=' + encodeURIComponent('{"type":"block_actions","user":{"constructor":{"prototype":{}}}}')), headers: form() }));
  assert.throws(() => parseBody({ rawBody: Buffer.from('{"type":"event_callback","event":{"__proto__":{}}}'), headers: json }));
  assert.throws(() => parseBody({ rawBody: Buffer.from('__proto__=x&command=%2Fplex&team_id=T&user_id=U'), headers: form() }));
  assert.throws(() => parseBody({ rawBody: Buffer.from('command=%2Fplex&command=%2Fother&team_id=T&user_id=U'), headers: form() }));
  assert.throws(() => parseBody({ rawBody: Buffer.from('Command=%2Fplex&team_id=T&user_id=U'), headers: form() }));
  assert.throws(() => parseBody({ rawBody: Buffer.from(`payload=${encodeURIComponent('{"type":"block_actions"}')}&team_id=T`), headers: form() }));
  assert.throws(() => parseBody({ rawBody: Buffer.from(`payload=${encodeURIComponent('[1]')}`), headers: form() }));
  assert.throws(() => parseBody({ rawBody: commandBody({ text: 'x'.repeat(9000) }), headers: form() }));
  assert.throws(() => parseBody({ rawBody: Buffer.alloc(300 * 1024, 0x61), headers: form() }));
});

test('parseBody: Enterprise Grid payloads are refused in v1', () => {
  assert.throws(() => parseBody({ rawBody: commandBody({ enterprise_id: 'E0GRID1' }), headers: form() }));
  assert.throws(() => parseBody({ rawBody: commandBody({ is_enterprise_install: 'true' }), headers: form() }));
  assert.throws(() => parseBody({ rawBody: interactionBody({ ...fixture('message-action.json'), enterprise: { id: 'E0GRID1' } }), headers: form() }));
  assert.throws(() => parseBody({ rawBody: interactionBody({ ...fixture('message-action.json'), is_enterprise_install: true }), headers: form() }));
  assert.equal(parseBody({ rawBody: commandBody({ enterprise_id: '' }), headers: form() }).kind, 'command', 'an empty enterprise id is no enterprise');
  assert.throws(() => parseBody({ rawBody: commandBody({ is_enterprise_install: '1' }), headers: form() }));
  assert.throws(() => parseBody({ rawBody: interactionBody({ ...fixture('message-action.json'), is_enterprise_install: 1 }), headers: form() }));
});

test('ackEarly: true for commands, interactions, url_verification and ssl_check (ackBody only runs early); false for events', () => {
  assert.equal(ackEarly({ payload: { kind: 'command' } }), true);
  assert.equal(ackEarly({ payload: { kind: 'interaction' } }), true);
  assert.equal(ackEarly({ payload: { kind: 'event' } }), false);
  assert.equal(ackEarly({ payload: { kind: 'url_verification' } }), true);
  assert.equal(ackEarly({ payload: { kind: 'ssl_check' } }), true);
  for (const kind of ['command', 'event', 'url_verification']) assert.equal(typeof ackEarly({ payload: { kind } }), 'boolean', 'a plain boolean, never a Promise');
  assert.equal(ackEarly({ payload: undefined }), false);
});

test('bindingOf: the team and app must be the connection\'s', () => {
  const cmd = parseBody({ rawBody: raw('slash-command-todo.form'), headers: form() });
  assert.equal(bindingOf(cmd, CONFIG), null);
  assert.equal(bindingOf({ kind: 'command', body: { ...cmd.body, team_id: 'T0OTHER', api_app_id: 'A0OTHER' } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf({ kind: 'command', body: { ...cmd.body, api_app_id: 'A0OTHER' } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf({ kind: 'command', body: { ...cmd.body, api_app_id: undefined } }, CONFIG), 'wrong_workspace');
  const view = { kind: 'interaction', body: fixture('view-submission.json') };
  assert.equal(bindingOf(view, CONFIG), null);
  assert.equal(bindingOf({ kind: 'interaction', body: { ...view.body, view: { ...view.body.view, team_id: 'T0OTHER' } } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf({ kind: 'interaction', body: { ...view.body, view: { ...view.body.view, app_id: 'A0OTHER' } } }, CONFIG), 'wrong_workspace');
  const shortcut = { kind: 'interaction', body: fixture('message-action.json') };
  assert.equal(bindingOf(shortcut, CONFIG), null, 'a message shortcut has no api_app_id in Slack\'s documented shape');
  assert.equal(bindingOf({ kind: 'interaction', body: { ...shortcut.body, team: { id: 'T0OTHER' } } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf({ kind: 'interaction', body: { ...shortcut.body, api_app_id: 'A0OTHER' } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf({ kind: 'interaction', body: { ...shortcut.body, team: undefined, user: { id: 'U0ALICE' } } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf(cmd, {}), 'wrong_workspace', 'a connection with no team on record binds nothing');
});

test('bindingOf: a person from another workspace (Slack Connect) on our team and app is external_user, not a misconfiguration', () => {
  const shortcut = fixture('message-action.json');
  const view = fixture('view-submission.json');
  const ext = { id: 'U0EXT', team_id: 'T0EXTERNAL' };
  assert.equal(bindingOf({ kind: 'interaction', body: { ...shortcut, user: ext } }, CONFIG), 'external_user');
  assert.equal(bindingOf({ kind: 'interaction', body: { ...view, user: ext } }, CONFIG), 'external_user');
  // The workspace or app being someone else's is still wrong_workspace, whoever the person is.
  assert.equal(bindingOf({ kind: 'interaction', body: { ...shortcut, user: ext, team: { id: 'T0OTHER' } } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf({ kind: 'interaction', body: { ...view, user: ext, view: { ...view.view, team_id: 'T0OTHER' } } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf({ kind: 'interaction', body: { ...view, user: ext, api_app_id: 'A0OTHER' } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf({ kind: 'interaction', body: { ...shortcut, team: undefined, user: { id: 'U0ALICE', team_id: 'T0TEAM1' } } }, CONFIG), 'wrong_workspace', 'the person\'s team alone never binds the workspace');
});

test('F3: a Slack Connect command (the person\'s home team, our app, no enterprise) is external_team; another app or Enterprise is not', () => {
  const connect = parseBody({ rawBody: raw('slash-command-connect.form'), headers: form() });
  assert.equal(connect.body.team_id, 'T0PARTNER');
  assert.equal(bindingOf(connect, CONFIG), 'external_team');
  assert.equal(bindingOf({ kind: 'command', body: { ...connect.body, api_app_id: 'A0OTHER' } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf({ kind: 'command', body: { ...connect.body, api_app_id: undefined } }, CONFIG), 'wrong_workspace');
  assert.equal(bindingOf({ kind: 'command', body: { ...connect.body, enterprise_id: 'E0GRID1' } }, CONFIG), 'wrong_workspace');
  assert.throws(() => parseBody({ rawBody: commandBody({ team_id: 'T0PARTNER', enterprise_id: 'E0GRID1' }), headers: form() }), 'Enterprise is still refused');
  assert.equal(bindingOf({ kind: 'event', body: { team_id: 'T0PARTNER', api_app_id: CONFIG.app_id } }, CONFIG), 'wrong_workspace', 'only commands');
});

test('F7: a repeated header is refused, not read as its first value', () => {
  const body = raw('slash-command-todo.form');
  const good = signed(SECRET, body);
  const ts = good.headers['x-slack-request-timestamp'];
  const sig = good.headers['x-slack-signature'];
  assert.equal(check({ headers: { ...good.headers, 'x-slack-request-timestamp': [ts] }, rawBody: body }).ok, true, 'one value in an array is that value');
  assert.equal(check({ headers: { ...good.headers, 'x-slack-request-timestamp': [ts, ts] }, rawBody: body }).reason, 'bad timestamp');
  assert.equal(check({ headers: { ...good.headers, 'x-slack-signature': [sig, `v0=${'0'.repeat(64)}`] }, rawBody: body }).reason, 'bad signature format');
  assert.equal(check({ headers: { ...good.headers, 'x-slack-signature': [] }, rawBody: body }).reason, 'bad signature format');
  assert.throws(() => parseBody({ rawBody: body, headers: { 'content-type': ['application/x-www-form-urlencoded', 'application/json'] } }));
  assert.equal(parseBody({ rawBody: body, headers: { 'content-type': ['application/x-www-form-urlencoded'] } }).kind, 'command');
});

test('response_url: only https on hooks.slack.com under Slack\'s own paths', () => {
  for (const ok of ['https://hooks.slack.com/commands/T0TEAM1/1234/abc', 'https://hooks.slack.com/actions/T0TEAM1/1/x_y-z', 'https://hooks.slack.com/app-actions/T0TEAM1/2/q']) assert.equal(responseUrlOk(ok), true, ok);
  for (const bad of [
    'http://hooks.slack.com/commands/T/1/a', 'https://hooks.slack.com.evil.example/commands/T/1/a', 'https://evil.example/hooks.slack.com/commands/a',
    'https://user@hooks.slack.com/commands/T/1/a', 'https://hooks.slack.com:8443/commands/T/1/a', 'https://hooks.slack.com/commands/T/1/a?x=1',
    'https://hooks.slack.com/commands/T/1/a#f', 'https://hooks.slack.com/services/T/B/x', 'https://hooks.slack.com/commands/../x', 'https://HOOKS.slack.com/commands/T/1/a',
    'https://hooks.slack.com/commands/', ' https://hooks.slack.com/commands/T/1/a', 'https://hooks.slack.com/commands/T/1/a\n', null, 42,
  ]) assert.equal(responseUrlOk(bad), false, String(bad));
});

test('mrkdwn escaping: titles can\'t ping, mention or link', () => {
  assert.equal(escapeMrkdwn('<!channel> <@U0ALICE> <https://evil.example|Reset password> & co'), '&lt;!channel&gt; &lt;@U0ALICE&gt; &lt;https://evil.example|Reset password&gt; &amp; co');
  assert.equal(escapeMrkdwn('&lt;'), '&amp;lt;', 'already-escaped text is escaped again, never decoded');
});

test('cleanTitle: Slack markup made plain, controls and bidi stripped, capped', () => {
  assert.equal(cleanTitle(fixture('message-action.json').message.text, { firstLine: true }), 'Fix the <flaky> login test @carol');
  assert.equal(cleanTitle('see <https://x.example/a|the doc> and <https://y.example>'), 'see the doc and https://y.example');
  assert.equal(cleanTitle('a‮b\u0000c​d\nnext'), 'a b c d next');
  assert.equal(cleanTitle('<!here> now'), '@here now');
  assert.equal([...cleanTitle('é'.repeat(300))].length, 120);
  assert.equal(cleanTitle('   '), '');
  assert.equal(cleanTitle('\n\nsecond', { firstLine: true }), 'second');
});

test('cleanTitle: a title made only of invisible characters is empty', () => {
  for (const t of ['\u3164', '\u3164\u3164', '\u2800\u2800', '\u115F\u1160', '\u034F', '\uFFA0', '\uFE0F\u200B', '\u{E0041}\u00AD', ' \u3164 \u2800 ']) {
    assert.equal(cleanTitle(t), '', JSON.stringify(t));
  }
  assert.equal(cleanTitle('fix\u3164login'), 'fix login', 'visible text around a filler is kept');
});

test('private_metadata: sealed to team, user and message; tampering, another user, another team, age or another secret are refused', () => {
  const now = Date.now();
  const m = sealMeta(SECRET, { team: 'T0TEAM1', channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0ALICE' }, now);
  assert.deepEqual(openMeta(SECRET, m, { team: 'T0TEAM1', user: 'U0ALICE' }, now), { team: 'T0TEAM1', channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0ALICE' });
  const [body, mac] = m.split('.');
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), c: 'C0OTHER' })).toString('base64url');
  assert.equal(openMeta(SECRET, `${edited}.${mac}`, { team: 'T0TEAM1', user: 'U0ALICE' }, now), null);
  assert.equal(openMeta(SECRET, `${body}.${mac.slice(0, -2)}AA`, { team: 'T0TEAM1', user: 'U0ALICE' }, now), null);
  assert.equal(openMeta(SECRET, m, { team: 'T0TEAM1', user: 'U0MALLORY' }, now), null);
  assert.equal(openMeta(SECRET, m, { team: 'T0OTHER', user: 'U0ALICE' }, now), null);
  assert.equal(openMeta(signingSecret(), m, { team: 'T0TEAM1', user: 'U0ALICE' }, now), null);
  assert.deepEqual(openMeta(SECRET, m, { team: 'T0TEAM1', user: 'U0ALICE' }, now + 61 * 60_000), { expired: true }, 'refused as expired');
  assert.equal(openMeta(SECRET, 'garbage', { team: 'T0TEAM1', user: 'U0ALICE' }, now), null);
  assert.equal(openMeta(SECRET, undefined, { team: 'T0TEAM1', user: 'U0ALICE' }, now), null);
});

test('F2: an authentic form left open past the hour is {expired}, told apart from a bad MAC (null); metaExpired reads the age alone', () => {
  const now = Date.now();
  const at = { team: 'T0TEAM1', user: 'U0ALICE' };
  const m = sealMeta(SECRET, { team: 'T0TEAM1', channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0ALICE' }, now - 61 * 60_000);
  assert.deepEqual(openMeta(SECRET, m, at, now), { expired: true });
  const [body, mac] = m.split('.');
  assert.equal(openMeta(SECRET, `${body}.${mac.slice(0, -2)}AA`, at, now), null, 'an old form with a bad MAC is tampering, not expiry');
  assert.equal(openMeta(signingSecret(), m, at, now), null);
  assert.equal(openMeta(SECRET, m, { team: 'T0TEAM1', user: 'U0MALLORY' }, now), null, 'another person\'s form is refused whatever its age');
  assert.equal(metaExpired(m, now), true);
  assert.equal(metaExpired(sealMeta(SECRET, { team: 'T0TEAM1', channel: 'C0CHAN1', ts: '1.1', user: 'U0ALICE' }, now), now), false);
  for (const bad of ['garbage', '', undefined, 'a.b.c', `${Buffer.from('{"i":"x"}').toString('base64url')}.x`]) assert.equal(metaExpired(bad, now), false, String(bad));
});

test('fixtures carry no token-shaped strings', () => {
  for (const f of ['slash-command-todo.form', 'slash-command-connect.form', 'message-action.json', 'view-submission.json', 'oauth-v2-access.json', 'apps-manifest-create.json', 'url-verification.json', 'block-actions.json']) {
    assert.doesNotMatch(readFileSync(new URL(`./fixtures/slack/${f}`, import.meta.url), 'utf8'), /xox[a-z]-|xapp-/);
  }
  assert.equal(typeof sign, 'function');
  assert.ok(nowS() > 0);
});

test('modal fields and confirmed title must be primitive strings, including signed array coercions', () => {
  const fields = { team: 'T0TEAM1', channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0ALICE', board: 'board-1', authority: 'a'.repeat(64) };
  for (const key of Object.keys(fields)) {
    const m = sealMeta(SECRET, { ...fields, [key]: [fields[key]] });
    assert.equal(openMeta(SECRET, m, { team: fields.team, user: fields.user }), null, key);
  }
  for (const text of [null, 1, ['Confirmed'], { text: 'Confirmed' }]) assert.equal(cleanTitle(text), '');
  const m = sealMeta(SECRET, fields);
  assert.deepEqual(openMeta(SECRET, m, { team: fields.team, user: fields.user }), fields);
});
