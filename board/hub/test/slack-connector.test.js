// Slack connector behaviour against a stub ctx with the framework shapes
// (slice A: ctx.boards / ctx.card, board-only createCard, act(…, {subject});
// slice B: connect.prepare / handshake, identity, ctx.memberFor,
// settings.pinned; slice C: settings.provider, ctx.hubUrl, ctx.linkState,
// onAckedFailure, rateSubject). See slack-shim.js. slack-e2e.test.js drives a real hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  spec, modalAuthority, TARGET_CHANGED, TARGET_UNAVAILABLE, ackBody, parseCommand, manifest, rateSubject, onAckedFailure, PREPARE_INPUTS, HELP, LINK, UNLINKED, VIEWER, INACTIVE, FAILED, SLOW, EXTERNAL, MODAL_ID, BOT_SCOPES,
} from '../integrations/slack/spec.js';
import { parseBody, sealMeta as rawSealMeta } from '../integrations/slack/webhook.js';
import { raw, fixture, interactionBody, commandBody, stubCtx, fakeSlack, botToken, signingSecret, clientSecret, CONFIG, PINNED, PROVIDER, MARKERS, HUB, TEAM } from './slack-shim.js';

// Synthetic fixture authority matches the default explicitly selected connection.
const sealMeta = (secret, fields, now) => rawSealMeta(secret, { ...fields, board: 'board-1', authority: modalAuthority(stubCtx({ secrets: { signing_secret: secret } }), fields.user === 'U0BOB' ? 'member-bob' : 'member-alice') }, now);

const form = { 'content-type': 'application/x-www-form-urlencoded' };
const cmd = (over) => parseBody({ rawBody: commandBody(over), headers: form });
const ia = (p) => parseBody({ rawBody: interactionBody(p), headers: form });
const setup = (opts = {}) => {
  const secrets = { bot_token: botToken(), signing_secret: signingSecret(), client_secret: clientSecret() };
  return { secrets, ctx: stubCtx({ secrets, ...opts }) };
};
const run = (ctx, payload) => spec.handleWebhook({ headers: form, payload, ctx });
const submission = (secrets, { meta, board = 'board-1', title, user } = {}) => {
  const p = fixture('view-submission.json');
  p.view.private_metadata = meta ?? sealMeta(secrets.signing_secret, { team: 'T0TEAM1', channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0ALICE' });
  p.view.state.values.board_block.board.selected_option.value = board;
  if (title !== undefined) p.view.state.values.title_block.title.value = title;
  if (user) p.user = { ...p.user, id: user };
  return ia(p);
};

test('ackBody per payload type: help/link ephemeral, todo and interactions empty, modal errors, the challenge', () => {
  assert.deepEqual(ackBody({ payload: cmd({ text: 'help' }) }), { response_type: 'ephemeral', text: HELP });
  assert.deepEqual(ackBody({ payload: cmd({ text: '' }) }), { response_type: 'ephemeral', text: HELP });
  assert.deepEqual(ackBody({ payload: cmd({ text: 'frobnicate' }) }), { response_type: 'ephemeral', text: HELP });
  assert.deepEqual(ackBody({ payload: cmd({ text: 'LINK' }) }), { response_type: 'ephemeral', text: LINK });
  assert.equal(ackBody({ payload: cmd({ text: 'todo x' }) }), undefined);
  assert.equal(ackBody({ payload: cmd({ command: '/other' }) }), undefined);
  assert.equal(ackBody({ payload: ia(fixture('block-actions.json')) }), undefined);
  assert.equal(ackBody({ payload: ia(fixture('message-action.json')) }), undefined);
  const secrets = { signing_secret: signingSecret() };
  assert.equal(ackBody({ payload: submission(secrets) }), undefined);
  assert.deepEqual(ackBody({ payload: submission(secrets, { title: ' ​ ' }) }), { response_action: 'errors', errors: { title_block: 'Give the card a title.' } });
  assert.equal(ackBody({ payload: { kind: 'url_verification', body: { challenge: 'abc123' } } }), 'abc123', 'plain text: the only answer a pending id may give');
  assert.equal(ackBody({ payload: { kind: 'url_verification', body: { challenge: '<x>' } } }), undefined);
  assert.equal(ackBody({ payload: { kind: 'ssl_check', body: {} } }), undefined);
  for (const p of [cmd({ text: 'help' }), cmd({ text: 'link' })]) assert.ok(Buffer.byteLength(JSON.stringify(ackBody({ payload: p }))) < 4096);
});

test('/plex link never carries a link to follow: linking starts in Plexiform', () => {
  assert.doesNotMatch(LINK, /https?:\/\//);
  assert.equal(parseCommand('link https://evil.example').name, 'link');
});

test('/plex todo by a linked user creates one card on the selected board, answered ephemerally with a link', async () => {
  const { ctx } = setup({ hubUrl: HUB });
  await run(ctx, cmd());
  assert.equal(ctx.cards.size, 1);
  const card = [...ctx.cards.values()][0];
  assert.deepEqual([card.title, card.board_id, card.created_by], ['Draft the launch post slackfixture-marker-todo-4b1e', 'board-1', 'member-alice']);
  assert.deepEqual(ctx.acts.map((a) => [a.action, a.meta.subject]), [['slack.create_card', 'U0ALICE']]);
  const replies = ctx.slack.replies();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].response_type, 'ephemeral');
  assert.equal(replies[0].text, `Created <https://board.example.test/#card=card-1|BDL-1>: Draft the launch post slackfixture-marker-todo-4b1e`);
  const call = ctx.slack.calls[0];
  assert.equal(call.url, 'https://hooks.slack.com/commands/T0TEAM1/1234567890/abcDEFghiJKLmno');
  assert.equal(call.headers.authorization, undefined, 'the bot token never goes to a response_url');
});

test('/plex todo: a retry (the same command again) creates exactly one card', async () => {
  const { ctx } = setup();
  await run(ctx, cmd());
  await run(ctx, cmd());
  assert.equal(ctx.cards.size, 1);
  assert.equal(ctx.slack.replies().length, 2);
  assert.equal(ctx.slack.replies()[1].text, ctx.slack.replies()[0].text, 'the retry answers with the same card');
});

test('/plex todo by an unlinked user creates nothing and is told to link in Plexiform', async () => {
  const { ctx } = setup({ linked: {} });
  await run(ctx, cmd());
  assert.equal(ctx.cards.size, 0);
  assert.equal(ctx.acts.length, 0);
  assert.deepEqual(ctx.slack.replies(), [{ response_type: 'ephemeral', text: UNLINKED, unfurl_links: false, unfurl_media: false }]);
});

test('/plex todo: the per-subject limit is passed as act(…, {subject}) and a 6th card in the hour is refused politely', async () => {
  const { ctx } = setup();
  for (let i = 0; i < 6; i += 1) await run(ctx, cmd({ text: `todo card ${i}`, trigger_id: `1000.${i}.${'ab'.repeat(16)}` }));
  assert.equal(ctx.cards.size, 5);
  assert.ok(ctx.acts.every((a) => a.meta.subject === 'U0ALICE'));
  assert.match(ctx.slack.replies().at(-1).text, /a lot of cards/);
});

test('/plex todo: a selected board from settings is used when it is still one of the team\'s boards', async () => {
  const { ctx } = setup({ targetBoardId: 'board-2' });
  await run(ctx, cmd());
  assert.equal([...ctx.cards.values()][0].board_id, 'board-2');
  const gone = setup({ targetBoardId: 'board-of-another-team' });
  await run(gone.ctx, cmd());
  assert.equal(gone.ctx.cards.size, 0, 'missing target must never fall back');
  assert.equal(gone.ctx.slack.replies()[0].text, TARGET_UNAVAILABLE);
});

test('/plex todo: an empty title or a missing response_url creates nothing harmful', async () => {
  const { ctx } = setup();
  await run(ctx, cmd({ text: 'todo  ​ ' }));
  assert.equal(ctx.cards.size, 0);
  assert.match(ctx.slack.replies()[0].text, /Usage/);
  const bad = setup();
  await run(bad.ctx, cmd({ response_url: 'https://hooks.slack.com.evil.example/commands/T/1/a' }));
  assert.equal(bad.ctx.cards.size, 1, 'the card is still made');
  assert.equal(bad.ctx.slack.calls.length, 0, 'nothing is sent to a URL off the allowlist');
});

test('mrkdwn: a hostile title is escaped in the reply', async () => {
  const { ctx } = setup();
  await run(ctx, cmd({ text: 'todo <!channel> <https://evil.example|Reset password> & more' }));
  const text = ctx.slack.replies()[0].text;
  assert.match(text, /: @channel Reset password &amp; more$/);
  const hostile = setup();
  hostile.ctx.cards.set('card-x', { id: 'card-x', key: 'BDL-<!here>', title: 't', board_id: 'board-1' });
  const { cardLink } = await import('../integrations/slack/spec.js');
  assert.equal(cardLink(HUB, hostile.ctx.cards.get('card-x')), '<https://board.example.test/#card=card-x|BDL-&lt;!here&gt;>');
  assert.equal(cardLink('https://x.example|<evil>', { id: 'c', key: 'K' }), 'K', 'a hub URL that could break out of the link is not used');
});

test('a correctly signed payload for another workspace or app does nothing and fails as wrong_workspace', async () => {
  const { ctx } = setup();
  await assert.rejects(run(ctx, cmd({ team_id: 'T0OTHER', api_app_id: 'A0OTHER' })), (e) => e.healthCode === 'wrong_workspace');
  await assert.rejects(run(ctx, cmd({ api_app_id: 'A0OTHER' })), (e) => e.healthCode === 'wrong_workspace');
  await assert.rejects(run(ctx, ia({ ...fixture('message-action.json'), team: { id: 'T0OTHER' } })), (e) => e.healthCode === 'wrong_workspace');
  assert.equal(ctx.cards.size, 0);
  assert.equal(ctx.slack.calls.length, 0);
});

// ── F-1 / C1: bindings come from what no settings PATCH can change ──

const refusedAs = (code) => (e) => e.healthCode === code;

test('C1: the install binds to external_id and settings.provider only; config is never read for a workspace, app or client id', async () => {
  const evil = { ...CONFIG, team_id: 'T0OTHER', app_id: 'A0OTHER1', client_id: '1.2', hub_url: 'https://evil-phish.example/login' };
  const { ctx } = setup({ config: evil });
  await assert.rejects(run(ctx, cmd({ team_id: 'T0OTHER', api_app_id: 'A0OTHER1', text: 'todo from another workspace' })), refusedAs('wrong_workspace'), 'a payload for the workspace and app config names');
  await run(ctx, cmd());
  assert.equal(ctx.cards.size, 1, 'ours still works: config binds nothing either way');
  assert.doesNotMatch(JSON.stringify(ctx.slack.calls), /evil-phish/);
  const trimmed = setup({ targetBoardId: 'board-2' });
  await run(trimmed.ctx, cmd());
  assert.equal([...trimmed.ctx.cards.values()][0].board_id, 'board-2', 'the admin\'s selected board still applies');
  const providerOnly = setup({ pinned: null });
  await run(providerOnly.ctx, cmd());
  assert.equal(providerOnly.ctx.cards.size, 1, 'provider alone binds');
  assert.deepEqual(spec.configKeys, ['channel_id'], 'the only key an admin may set');
});

test('C1 fail closed: no settings.provider (a connection made before 026), or one without a usable app or client id → reconnect_required; nothing runs, nothing is sent', async () => {
  const cases = [
    { provider: null }, { provider: null, pinned: null, config: CONFIG }, { provider: { ...PROVIDER, app_id: 'a0lower' } },
    { provider: { client_id: PINNED.client_id } }, { provider: { app_id: PINNED.app_id } }, { externalId: 'not-a-team' },
  ];
  for (const opts of cases) {
    const { ctx } = setup(opts);
    for (const p of [cmd(), ia(fixture('message-action.json'))]) await assert.rejects(run(ctx, p), refusedAs('reconnect_required'), JSON.stringify(opts));
    assert.equal(ctx.cards.size + ctx.acts.length + ctx.slack.calls.length, 0, JSON.stringify(opts));
  }
});

test('C1 fail closed: provider.team_id ≠ external_id, or a provider app or client id that contradicts settings.pinned → wrong_workspace (a binding error)', async () => {
  for (const opts of [
    { provider: { ...PROVIDER, team_id: 'T0OTHER' } },
    { provider: { ...PROVIDER, app_id: 'A0OTHER1' } },
    { provider: { ...PROVIDER, client_id: '555.666' } },
    { pinned: { ...PINNED, client_id: '555.666' } },
    { pinned: { ...PINNED, extra: 'x' } },
  ]) {
    const { ctx } = setup(opts);
    await assert.rejects(run(ctx, cmd()), refusedAs('wrong_workspace'), JSON.stringify(opts));
    await assert.rejects(run(ctx, ia(fixture('message-action.json'))), refusedAs('wrong_workspace'), JSON.stringify(opts));
    assert.equal(ctx.cards.size + ctx.acts.length + ctx.slack.calls.length, 0);
  }
  const agrees = setup({ provider: { ...PROVIDER, team_id: TEAM } });
  await run(agrees.ctx, cmd());
  assert.equal(agrees.ctx.cards.size, 1, 'a provider team id that is external_id is fine');
});

test('C1: a card link comes only from ctx.hubUrl (an https origin), never from provider.hub_url or config; with none, no link', async () => {
  const none = setup({ config: { hub_url: 'https://evil-phish.example/login' }, provider: { ...PROVIDER, hub_url: 'https://stale.example' } });
  await run(none.ctx, cmd());
  assert.equal(none.ctx.slack.replies()[0].text, 'Created BDL-1: Draft the launch post slackfixture-marker-todo-4b1e');
  assert.doesNotMatch(JSON.stringify(none.ctx.slack.calls), /evil-phish|stale\.example/);
  const fromCtx = setup({ config: { hub_url: 'https://evil-phish.example' }, hubUrl: HUB });
  await run(fromCtx.ctx, cmd());
  assert.match(fromCtx.ctx.slack.replies()[0].text, /^Created <https:\/\/board\.example\.test\/#card=card-1\|BDL-1>: /);
  for (const hubUrl of ['http://board.example.test', 'http://127.0.0.1:8787', 'javascript:alert(1)', 'https://x.example|<evil>', `${HUB}/path`, null]) {
    const bad = setup({ hubUrl });
    await run(bad.ctx, cmd());
    assert.equal(bad.ctx.slack.replies()[0].text, 'Created BDL-1: Draft the launch post slackfixture-marker-todo-4b1e', String(hubUrl));
  }
});

test('C1: authorizeUrl and exchange take the client id from provider (the pending row\'s prepare settings), never from config', async () => {
  const u = new URL(spec.connect.authorizeUrl({ state: 's', redirectUri: REDIRECT, provider: { ...PINNED }, config: { client_id: '555.666' } }));
  assert.equal(u.searchParams.get('client_id'), PINNED.client_id);
  assert.throws(() => spec.connect.authorizeUrl({ state: 's', redirectUri: REDIRECT, provider: {}, config: { client_id: PINNED.client_id } }), /no client id/);
  const x = exchangeWith(access(), { config: { client_id: '555.666' } });
  await x.run();
  assert.match(x.calls[0].init.headers.authorization, new RegExp(`^Basic ${Buffer.from(`${PINNED.client_id}:`).toString('base64').slice(0, 20)}`));
  await assert.rejects(exchangeWith(access(), { provider: { client_id: undefined } }).run(), /no pending app/);
});

test('F-1: identity pins to the connection\'s external_id, provider and pinned client id', async () => {
  const redirectUri = 'https://board.example.test/integrations/slack/identity/callback';
  const foreign = { external_id: TEAM, settings: { provider: { ...PROVIDER, team_id: 'T0OTHER' }, pinned: PINNED } };
  assert.throws(() => spec.identity.authorizeUrl({ state: 'st', nonce: 'n', redirectUri, connection: foreign }), /not connected/);
  assert.throws(() => spec.identity.authorizeUrl({ state: 'st', nonce: 'n', redirectUri, config: CONFIG }), /not connected/, 'a bare config is not enough');
  const unpinned = { external_id: TEAM, settings: { provider: PROVIDER } };
  assert.throws(() => spec.identity.authorizeUrl({ state: 'st', nonce: 'n', redirectUri, connection: unpinned }), /not connected/, 'the registry\'s audience is pinned.client_id: without it, no link');
  const legacy = { external_id: TEAM, settings: { pinned: PINNED } };
  assert.throws(() => spec.identity.authorizeUrl({ state: 'st', nonce: 'n', redirectUri, connection: legacy }), /not connected/, 'no provider facts, no link');
  const other = { app_id: CONFIG.app_id, client_id: '555.666' };
  const pinned = { external_id: TEAM, settings: { provider: { ...PROVIDER, ...other }, pinned: other } };
  assert.equal(new URL(spec.identity.authorizeUrl({ state: 'st', nonce: 'n', redirectUri, connection: pinned })).searchParams.get('client_id'), '555.666');
  const x = oidc(foreign);
  await assert.rejects(x.run(), /not connected/);
  assert.equal(x.calls.length, 0, 'nothing is sent to Slack');
});

// ── F-3: Slack Connect users ────────────────────────────────────────────

test('F-3: a person from another workspace on our shortcut is told privately; no modal, no card, no health failure', async () => {
  const { ctx, secrets } = setup();
  const p = { ...fixture('message-action.json'), user: { id: 'U0EXT', name: 'ext', team_id: 'T0EXTERNAL' } };
  await run(ctx, ia(p));
  assert.deepEqual(ctx.slack.replies(), [{ response_type: 'ephemeral', text: EXTERNAL, unfurl_links: false, unfurl_media: false }]);
  assert.equal(ctx.slack.api('views.open').length, 0);
  const view = fixture('view-submission.json');
  view.user = { id: 'U0EXT', team_id: 'T0EXTERNAL' };
  view.view.private_metadata = sealMeta(secrets.signing_secret, { team: TEAM, channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0EXT' });
  view.view.state.values.board_block.board.selected_option.value = 'board-1';
  await run(ctx, ia(view));
  assert.equal(ctx.cards.size, 0);
  assert.equal(ctx.acts.length, 0);
});

// ── re-review: F2, F3, F4, F6 ───────────────────────────────────────────

const EXPIRED = 'This form expired. Use the shortcut again.';
const throwing = (ctx, e) => { ctx.act = async () => { throw e; }; return ctx; };
const forbiddenErr = () => Object.assign(new Error('this integration may not act as that member'), { code: 'FORBIDDEN' });
const unavailable = (scope) => Object.assign(new Error('that member can no longer act'), { code: 'ACTOR_UNAVAILABLE', scope });
const ephemeralText = (ctx) => JSON.parse(ctx.slack.api('chat.postEphemeral')[0].body).text;

test('C2 linkState: unlinked, a linked viewer and access lost mid-request each get their own fixed text; Slack Connect keeps EXTERNAL', async () => {
  assert.equal(UNLINKED, 'Link your Slack account in Plexiform: Integrations → Slack → Link my account.');
  assert.equal(VIEWER, "You can view this team's board but not add cards; ask an admin for write access.");
  assert.equal(new Set([UNLINKED, VIEWER, INACTIVE, EXTERNAL, FAILED, SLOW]).size, 6);
  for (const [opts, want] of [[{ linked: {} }, UNLINKED], [{ linked: {}, viewers: ['U0ALICE'] }, VIEWER]]) {
    const todo = setup(opts);
    await run(todo.ctx, cmd());
    const shortcut = setup(opts);
    await run(shortcut.ctx, ia(fixture('message-action.json')));
    const submit = setup(opts);
    await run(submit.ctx, submission({ signing_secret: submit.ctx.secret('signing_secret') }));
    assert.deepEqual([todo.ctx.slack.replies()[0].text, shortcut.ctx.slack.replies()[0].text, ephemeralText(submit.ctx)], [want, want, want]);
    assert.equal(todo.ctx.acts.length + shortcut.ctx.acts.length + submit.ctx.acts.length + shortcut.ctx.slack.api('views.open').length, 0);
  }
  for (const t of [UNLINKED, VIEWER, INACTIVE, FAILED, SLOW]) assert.doesNotMatch(t, /https?:\/\/|<|>/, 'no link to follow in a fixed text');
});

test('C2: access lost between linkState and act() (FORBIDDEN, or ACTOR_UNAVAILABLE for a member) is answered, not thrown: viewer text while still linked, else INACTIVE; no card', async () => {
  for (const [e, demoted, want] of [[forbiddenErr(), false, INACTIVE], [unavailable('member'), false, INACTIVE], [unavailable('member'), true, VIEWER]]) {
    // act() fails as the registry's would; a demotion meanwhile leaves the link 'unavailable', a removal 'none'.
    const lose = (ctx) => { ctx.act = async () => { ctx.linkState = () => (demoted ? 'unavailable' : 'none'); throw e; }; return ctx; };
    const todo = lose(setup().ctx);
    await run(todo, cmd());
    assert.deepEqual(todo.slack.replies().map((r) => r.text), [want], `${e.code} demoted=${demoted}`);
    const submit = lose(setup().ctx);
    await run(submit, submission({ signing_secret: submit.secret('signing_secret') }));
    assert.equal(ephemeralText(submit), want);
    assert.equal(todo.cards.size + submit.cards.size, 0);
  }
  const other = throwing(setup().ctx, Object.assign(new Error('boom'), { code: 'INTERNAL' }));
  await assert.rejects(run(other, cmd()), /boom/, 'other failures still surface');
});

test('C2: the connecting member\'s own loss (ACTOR_UNAVAILABLE scope connection) is answered, then rethrown so the registry records actor_unavailable health', async () => {
  const e = unavailable('connection');
  const todo = throwing(setup().ctx, e);
  await assert.rejects(run(todo, cmd()), (x) => x === e);
  assert.deepEqual(todo.slack.replies().map((r) => r.text), [INACTIVE]);
  const submit = throwing(setup().ctx, e);
  await assert.rejects(run(submit, submission({ signing_secret: submit.secret('signing_secret') })), (x) => x === e);
  assert.equal(ephemeralText(submit), INACTIVE);
});

test('F2: a form left open past the hour is answered "expired" in the ack and dropped quietly by the handler: no throw, no Slack call', async () => {
  const { ctx } = setup();
  const lines = [];
  ctx.log = (...a) => lines.push(a);
  const s = ctx.secret('signing_secret');
  const old = sealMeta(s, { team: TEAM, channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0ALICE' }, Date.now() - 61 * 60_000);
  const p = submission({ signing_secret: s }, { meta: old });
  assert.deepEqual(ackBody({ payload: p }), { response_action: 'errors', errors: { title_block: EXPIRED } });
  assert.deepEqual(ackBody({ payload: submission({ signing_secret: s }, { meta: old, title: '' }) }), { response_action: 'errors', errors: { title_block: EXPIRED } }, 'expiry first');
  await run(ctx, p);
  assert.deepEqual(lines, [['slack modal expired']]);
  assert.equal(ctx.slack.calls.length + ctx.cards.size + ctx.acts.length, 0);
  // Expired and unlinked meanwhile: still quiet.
  const gone = setup({ linked: {} });
  await run(gone.ctx, submission({ signing_secret: gone.ctx.secret('signing_secret') }, { meta: sealMeta(gone.ctx.secret('signing_secret'), { team: TEAM, channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0ALICE' }, Date.now() - 2 * 60 * 60_000) }));
  assert.equal(gone.ctx.slack.calls.length, 0);
  // A bad MAC on an old form is still tampering.
  const [b, mac] = old.split('.');
  await assert.rejects(run(ctx, submission({ signing_secret: s }, { meta: `${b}.${mac.slice(0, -2)}AA` })), (e) => e.healthCode === 'bad_metadata');
});

test('F3: a Slack Connect /plex command (recorded shape: their home team_id, our app) is told EXTERNAL via response_url; no throw, no act', async () => {
  const { ctx } = setup();
  const connect = parseBody({ rawBody: raw('slash-command-connect.form'), headers: form });
  await run(ctx, connect);
  assert.deepEqual(ctx.slack.replies(), [{ response_type: 'ephemeral', text: EXTERNAL, unfurl_links: false, unfurl_media: false }]);
  assert.equal(ctx.slack.calls[0].url, 'https://hooks.slack.com/commands/T0PARTNER/1234567891/pqrSTUvwxYZabcd');
  assert.equal(ctx.acts.length + ctx.cards.size, 0);
  await assert.rejects(run(ctx, { ...connect, body: { ...connect.body, api_app_id: 'A0OTHER' } }), (e) => e.healthCode === 'wrong_workspace');
});

// ── per-request Slack errors are quiet outcomes ─────────────────────────

const GONE = 'That message is no longer available.';
const TOO_SLOW = 'That took too long; use the shortcut again.';

test('quiet Slack errors: getPermalink/views.open codes about this one request get a fixed answer, a fixed log line, no throw and no card; slackApi tags the code on the error', async () => {
  for (const code of ['channel_not_found', 'message_not_found', 'not_in_channel']) {
    const sub = setup({ slack: fakeSlack({ fail: { 'chat.getPermalink': code } }) });
    const lines = [];
    sub.ctx.log = (...a) => lines.push(a);
    await run(sub.ctx, submission(sub.secrets));
    assert.equal(ephemeralText(sub.ctx), GONE, code);
    assert.equal(sub.ctx.cards.size, 0, code);
    assert.equal(sub.ctx.acts.length, 1, 'provider await is inside a captured, non-mutating act scope');
    assert.deepEqual(lines, [['slack request skipped', { code }]], code);
  }
  for (const code of ['expired_trigger_id', 'trigger_expired']) {
    const sc = setup({ slack: fakeSlack({ fail: { 'views.open': code } }) });
    const lines = [];
    sc.ctx.log = (...a) => lines.push(a);
    await run(sc.ctx, ia(fixture('message-action.json')));
    assert.deepEqual(sc.ctx.slack.replies().map((r) => r.text), [TOO_SLOW], code);
    assert.deepEqual(lines, [['slack request skipped', { code }]], code);
  }
  const gone = setup({ slack: fakeSlack({ fail: { 'views.open': 'channel_not_found' } }) });
  await run(gone.ctx, ia(fixture('message-action.json')));
  assert.deepEqual(gone.ctx.slack.replies().map((r) => r.text), [GONE]);
  // The error carries Slack's code as a field; nothing parses the message.
  const tagged = setup({ slack: fakeSlack({ fail: { 'chat.postEphemeral': 'channel_not_found' } }) });
  const lines = [];
  tagged.ctx.log = (...a) => lines.push(a);
  await run(tagged.ctx, submission(tagged.secrets));
  assert.equal(lines.length, 1);
});

test('everything else from Slack keeps today\'s behaviour: invalid_auth, token_revoked, rate limits and 5xx still throw provider_error with the code on the error', async () => {
  for (const code of ['invalid_auth', 'token_revoked', 'ratelimited', 'account_inactive']) {
    const sub = setup({ slack: fakeSlack({ fail: { 'chat.getPermalink': code } }) });
    await assert.rejects(run(sub.ctx, submission(sub.secrets)), (e) => e.healthCode === 'provider_error' && e.slackError === code, code);
    const sc = setup({ slack: fakeSlack({ fail: { 'views.open': code } }) });
    await assert.rejects(run(sc.ctx, ia(fixture('message-action.json'))), (e) => e.healthCode === 'provider_error' && e.slackError === code, code);
    assert.equal(sc.ctx.slack.replies().length, 0);
  }
  const five = setup({ slack: fakeSlack({ answer: (m) => (m === 'views.open' ? { ok: false } : undefined) }) });
  await assert.rejects(run(five.ctx, ia(fixture('message-action.json'))), (e) => e.healthCode === 'provider_error' && e.slackError === 'error');
});

test('F3 external_team: a Slack Connect command is told apart from wrong_workspace by a logged code; no throw, no act', async () => {
  const { ctx } = setup();
  const lines = [];
  ctx.log = (...a) => lines.push(a);
  await run(ctx, parseBody({ rawBody: raw('slash-command-connect.form'), headers: form }));
  assert.deepEqual(lines, [['slack request refused', { code: 'external_team' }]]);
  assert.equal(ctx.acts.length + ctx.cards.size, 0);
  const shortcut = setup();
  const l2 = [];
  shortcut.ctx.log = (...a) => l2.push(a);
  const p = fixture('message-action.json');
  await run(shortcut.ctx, ia({ ...p, user: { ...p.user, team_id: 'T0PARTNER' } }));
  assert.deepEqual(l2, [['slack request refused', { code: 'external_user' }]]);
});

test('PRIVACY.md (Slack): the per-user command count is memory-only under a keyed hash, dropped ~10 minutes after the last command and on restart; the form carries board ids and a sealed reference', () => {
  const privacy = readFileSync(new URL('../../../PRIVACY.md', import.meta.url), 'utf8');
  const stored = /\*\*What is stored\.\*\*[^\n]*/.exec(privacy)?.[0] ?? '';
  for (const need of [/in memory only/, /keyed hash of their Slack user id/, /ten minutes after (?:that person's|their) last command/, /hub restarts?/]) assert.match(stored, need);
  const sent = /\*\*What is sent to Slack\.\*\*[^\n]*/.exec(privacy)?.[0] ?? '';
  for (const need of [/board id/, /sealed reference/, /workspace id, the channel id, the message's timestamp, your Slack user id, a timestamp and a MAC/, /sends back when/]) assert.match(sent, need);
});

test('F1: PRIVACY.md says what the shortcut sends to Slack: the form with board names and the suggested title, and the permalink request', () => {
  const privacy = readFileSync(new URL('../../../PRIVACY.md', import.meta.url), 'utf8');
  const bullet = /\*\*What is sent to Slack\.\*\*[^\n]*/.exec(privacy)?.[0] ?? '';
  for (const need of [/form/, /name of the explicitly selected team board/, /first line/, /link to that message|permalink/, /views\.open/, /chat\.getPermalink/]) assert.match(bullet, need);
});

// ── F-2: the same message carded twice ─────────────────────────────────

test('F-2: a second member carding the same message is shown the stored title, not their own', async () => {
  const { ctx } = setup({ linked: { U0ALICE: 'member-alice', U0BOB: 'member-bob' } });
  const s = ctx.secret('signing_secret');
  await run(ctx, submission({ signing_secret: s }, { title: 'Alice title' }));
  const bob = sealMeta(s, { team: TEAM, channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0BOB' });
  await run(ctx, submission({ signing_secret: s }, { title: 'Bob title', user: 'U0BOB', meta: bob }));
  assert.equal(ctx.cards.size, 1);
  const last = JSON.parse(ctx.slack.api('chat.postEphemeral').at(-1).body);
  assert.equal(last.user, 'U0BOB');
  assert.equal(last.text, 'Already on the board as BDL-1: Alice title');
});

// ── F-4: invisible titles ──────────────────────────────────────────────

test('F-4: a title of Hangul fillers, braille blanks or other invisibles is refused, in the modal and in /plex todo', async () => {
  const secrets = { signing_secret: signingSecret() };
  for (const t of ['ㅤ', '⠀⠀', 'ᅟᅠ', '͏', 'ㅤ ​']) {
    assert.deepEqual(ackBody({ payload: submission(secrets, { title: t }) }), { response_action: 'errors', errors: { title_block: 'Give the card a title.' } }, JSON.stringify(t));
    const { ctx } = setup();
    await run(ctx, cmd({ text: `todo ${t}` }));
    assert.equal(ctx.cards.size, 0, JSON.stringify(t));
    assert.match(ctx.slack.replies()[0].text, /Usage/);
  }
});

// ── output hygiene and the per-user limit hook ─────────────────────────

test('no outbound Slack body asks Slack to parse or link names (slice 2 posts are visible)', async () => {
  const { ctx, secrets } = setup({ hubUrl: HUB });
  await run(ctx, cmd());
  await run(ctx, ia(fixture('message-action.json')));
  await run(ctx, submission(secrets));
  assert.ok(ctx.slack.calls.length >= 4);
  for (const c of ctx.slack.calls) {
    const body = c.body.startsWith('{') ? JSON.parse(c.body) : Object.fromEntries(new URLSearchParams(c.body));
    for (const k of ['link_names', 'parse']) assert.equal(Object.hasOwn(body, k), false, `${c.method}: ${k}`);
  }
});

test('rateSubject: the Slack user of a command or interaction, else null', () => {
  assert.equal(rateSubject({ payload: cmd() }), 'U0ALICE');
  assert.equal(rateSubject({ payload: ia(fixture('message-action.json')) }), 'U0ALICE');
  assert.equal(rateSubject({ payload: ia(fixture('view-submission.json')) }), 'U0ALICE');
  assert.equal(rateSubject({ payload: { kind: 'event', body: { user: 'U0ALICE' } } }), null);
  assert.equal(rateSubject({ payload: { kind: 'command', body: { user_id: 'not a user' } } }), null);
  assert.equal(rateSubject({ payload: { kind: 'interaction', body: {} } }), null);
  assert.equal(rateSubject({}), null);
  assert.equal(spec.rateSubject, rateSubject);
});

test('C3 ackBody rateLimited: a command and a modal submit are told to slow down in fixed text; a shortcut ack stays empty; nothing echoed', () => {
  const secrets = { signing_secret: signingSecret() };
  for (const p of [cmd(), cmd({ text: 'help' }), cmd({ text: `todo ${MARKERS[0]}` })]) assert.deepEqual(ackBody({ payload: p, rateLimited: true }), { response_type: 'ephemeral', text: SLOW });
  assert.deepEqual(ackBody({ payload: submission(secrets, { title: MARKERS[1] }), rateLimited: true }), { response_action: 'errors', errors: { title_block: SLOW } });
  assert.equal(ackBody({ payload: ia(fixture('message-action.json')), rateLimited: true }), undefined);
  assert.equal(ackBody({ payload: { kind: 'url_verification', body: { challenge: 'abc123' } }, rateLimited: true }), undefined);
  assert.deepEqual(ackBody({ payload: cmd({ text: 'help' }), rateLimited: false }), { response_type: 'ephemeral', text: HELP }, 'rateLimited false is a normal ack');
});

test('C2 onAckedFailure: one fixed "couldn\'t do that" to the payload\'s allowlisted response_url, without the error or the input; nothing for actor_unavailable or without a response_url', async () => {
  const slack = fakeSlack();
  await onAckedFailure({ payload: cmd({ text: `todo ${MARKERS[0]}` }), headers: form, error_code: 'handler_failed', fetch: slack.fetch });
  await onAckedFailure({ payload: ia(fixture('message-action.json')), headers: form, error_code: 'provider_error', fetch: slack.fetch });
  assert.deepEqual(slack.calls.map((c) => c.url), ['https://hooks.slack.com/commands/T0TEAM1/1234567890/abcDEFghiJKLmno', fixture('message-action.json').response_url]);
  for (const r of slack.replies()) assert.deepEqual(r, { response_type: 'ephemeral', text: FAILED, unfurl_links: false, unfurl_media: false });
  assert.ok(!JSON.stringify(slack.calls).includes(MARKERS[0]) && !JSON.stringify(slack.calls).includes('handler_failed'));
  const quiet = fakeSlack();
  await onAckedFailure({ payload: cmd(), error_code: 'actor_unavailable', fetch: quiet.fetch });
  await onAckedFailure({ payload: cmd({ response_url: 'https://hooks.slack.com.evil.example/commands/T/1/a' }), error_code: 'handler_failed', fetch: quiet.fetch });
  await onAckedFailure({ payload: submission({ signing_secret: signingSecret() }), error_code: 'bad_metadata', fetch: quiet.fetch });
  await onAckedFailure({ payload: null, error_code: 'handler_failed', fetch: quiet.fetch });
  assert.equal(quiet.calls.length, 0);
});

test('shortcut → modal: views.open with the trigger, a cleaned title prefill, the team\'s boards and sealed metadata', async () => {
  const { ctx, secrets } = setup();
  await run(ctx, ia(fixture('message-action.json')));
  const [open] = ctx.slack.api('views.open');
  assert.ok(open, 'views.open was called');
  assert.equal(ctx.slack.calls[0].method, 'views.open', 'first, before the trigger expires');
  assert.equal(open.headers.authorization, `Bearer ${secrets.bot_token}`);
  const body = JSON.parse(open.body);
  assert.equal(body.trigger_id, fixture('message-action.json').trigger_id);
  assert.equal(body.view.callback_id, MODAL_ID);
  assert.equal(body.view.blocks[0].element.initial_value, 'Fix the <flaky> login test @carol');
  assert.deepEqual(body.view.blocks[1].element.options.map((o) => o.value), ['board-1']);
  assert.ok(!JSON.stringify(body).includes(MARKERS[0]), 'only the first line is offered');
  assert.ok(!JSON.stringify(body).includes('U0BOBBYX'), 'the author is never sent back or kept');
  assert.equal(ctx.cards.size, 0, 'nothing is created until the person submits');
});

test('shortcut by an unlinked user opens nothing and is told to link in Plexiform', async () => {
  const { ctx } = setup({ linked: {} });
  await run(ctx, ia(fixture('message-action.json')));
  assert.equal(ctx.slack.api('views.open').length, 0);
  assert.equal(ctx.slack.replies()[0].text, UNLINKED);
});

test('submit: one card with the confirmed title and the permalink, a thread link, and an ephemeral confirmation', async () => {
  const { ctx } = setup({ hubUrl: HUB });
  await run(ctx, submission(ctx.connection && { signing_secret: ctx.secret('signing_secret') }));
  assert.equal(ctx.cards.size, 1);
  const card = [...ctx.cards.values()][0];
  assert.equal(card.title, 'Fix the <flaky> login test');
  assert.equal(card.body, 'From Slack: https://acme.slack.com/archives/C0CHAN1/p1759312700000200');
  assert.equal(ctx.linked('thread', 'C0CHAN1:1759312700.000200'), card.id);
  const permalink = ctx.slack.api('chat.getPermalink')[0];
  assert.equal(new URLSearchParams(permalink.body).get('message_ts'), '1759312700.000200');
  const eph = JSON.parse(ctx.slack.api('chat.postEphemeral')[0].body);
  assert.deepEqual([eph.channel, eph.user], ['C0CHAN1', 'U0ALICE']);
  assert.equal(eph.text, 'Created <https://board.example.test/#card=card-1|BDL-1>: Fix the &lt;flaky&gt; login test');
  assert.equal(ctx.acts[0].meta.subject, 'U0ALICE');
  assert.equal(ctx.acts[0].meta.external_ref, 'slack:C0CHAN1:1759312700.000200');
});

test('submit twice (a double click, or the same message again later) gives one card', async () => {
  const { ctx } = setup();
  const meta = { signing_secret: ctx.secret('signing_secret') };
  await run(ctx, submission(meta));
  await run(ctx, submission(meta, { title: 'An edited title' }));
  assert.equal(ctx.cards.size, 1);
  assert.equal([...ctx.cards.values()][0].title, 'Fix the <flaky> login test');
  const again = setup();
  const m = { signing_secret: again.ctx.secret('signing_secret') };
  await run(again.ctx, submission(m));
  await run(again.ctx, submission(m, { board: 'board-2' }));
  assert.equal(again.ctx.cards.size, 1, 'the same message on another board is a conflict, not a second card');
  assert.equal(JSON.parse(again.ctx.slack.api('chat.postEphemeral').at(-1).body).text, TARGET_CHANGED);
});

test('submit: tampered, foreign or forged private_metadata is refused and creates nothing', async () => {
  const { ctx } = setup();
  const s = ctx.secret('signing_secret');
  const good = sealMeta(s, { team: 'T0TEAM1', channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0ALICE' });
  const [b, mac] = good.split('.');
  const moved = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url')), c: 'C0SECRET', m: '1.1' })).toString('base64url');
  const cases = [
    `${moved}.${mac}`,
    sealMeta(signingSecret(), { team: 'T0TEAM1', channel: 'C0SECRET', ts: '1.1', user: 'U0ALICE' }),
    JSON.stringify({ channel: 'C0SECRET', ts: '1.1' }),
    '',
  ];
  for (const meta of cases) await assert.rejects(run(ctx, submission({ signing_secret: s }, { meta })), (e) => e.healthCode === 'bad_metadata', meta);
  // Sealed for alice, submitted by mallory (a linked user too).
  const spoof = setup({ linked: { U0ALICE: 'member-alice', U0MALLORY: 'member-mallory' } });
  const sm = spoof.ctx.secret('signing_secret');
  await assert.rejects(run(spoof.ctx, submission({ signing_secret: sm }, { user: 'U0MALLORY' })), (e) => e.healthCode === 'bad_metadata');
  assert.equal(ctx.cards.size + spoof.ctx.cards.size, 0);
});

test('submit: the member mapping is checked again (unlinked since the modal opened), and the board must be the team\'s', async () => {
  const { ctx } = setup({ linked: {} });
  await run(ctx, submission({ signing_secret: ctx.secret('signing_secret') }));
  assert.equal(ctx.cards.size, 0);
  assert.equal(JSON.parse(ctx.slack.api('chat.postEphemeral')[0].body).text, UNLINKED);
  const other = setup();
  await run(other.ctx, submission({ signing_secret: other.ctx.secret('signing_secret') }, { board: 'board-of-another-team' }));
  assert.equal(other.ctx.cards.size, 0);
  assert.equal(other.ctx.slack.api('chat.getPermalink').length, 0);
});

test('submit: a permalink that is not https on slack.com is refused', async () => {
  for (const permalink of ['http://acme.slack.com/archives/C/p1', 'https://acme.slack.com.evil.example/archives/C/p1', 'https://u@acme.slack.com/x', 'javascript:alert(1)']) {
    const secrets = { bot_token: botToken(), signing_secret: signingSecret() };
    const ctx = stubCtx({ secrets, slack: fakeSlack({ permalink }) });
    await assert.rejects(run(ctx, submission(secrets)), (e) => e.healthCode === 'provider_error', permalink);
    assert.equal(ctx.cards.size, 0);
  }
});

test('stored card rows hold only the confirmed title and the permalink: no other message text, no author id', async () => {
  const { ctx, secrets } = setup();
  await run(ctx, ia(fixture('message-action.json')));
  await run(ctx, submission(secrets));
  await run(ctx, ia(fixture('block-actions.json')));
  const stored = JSON.stringify([...ctx.cards.values(), ...ctx.links.entries(), ...ctx.acts]);
  for (const m of MARKERS) assert.ok(!stored.includes(m), m);
  assert.ok(!stored.includes('U0BOBBYX'));
  assert.ok(!stored.includes('hooks.slack.com'), 'no response_url is kept');
});

test('block_actions and other callbacks are ignored', async () => {
  const { ctx } = setup();
  await run(ctx, ia(fixture('block-actions.json')));
  await run(ctx, ia({ ...fixture('message-action.json'), callback_id: 'someone_else' }));
  assert.equal(ctx.slack.calls.length, 0);
});

// ── connect ─────────────────────────────────────────────────────────────

const jsonRes = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const WEBHOOK = 'https://board.example.test/integrations/0b6f0c1e-7a1f-4c55-9a3e-4b2f0e6d9c11/webhook';
const REDIRECT = 'https://board.example.test/integrations/slack/callback';
const ID_REDIRECT = 'https://board.example.test/integrations/slack/identity/callback';
const URLS = Object.freeze({ webhookUrl: WEBHOOK, redirectUri: REDIRECT, identityRedirectUri: ID_REDIRECT });

test('manifest: slice 1 bot scopes, openid as the only user scope, both callbacks, no events, no org deploy, no token rotation', () => {
  const m = manifest(URLS);
  assert.deepEqual(m.oauth_config, { redirect_urls: [REDIRECT, ID_REDIRECT], scopes: { bot: ['chat:write', 'commands'], user: ['openid'] } });
  assert.equal(m.features.slash_commands[0].url, WEBHOOK);
  assert.equal(m.settings.interactivity.request_url, WEBHOOK);
  assert.equal(m.settings.event_subscriptions, undefined);
  assert.deepEqual([m.settings.org_deploy_enabled, m.settings.token_rotation_enabled, m.settings.socket_mode_enabled], [false, false, false]);
  assert.deepEqual(m.features.shortcuts, [{ name: 'Create Plexiform card', type: 'message', callback_id: 'plex_create_card', description: 'Make a card from this message' }]);
  assert.ok(m.display_information.name.length <= 35);
});

test('prepare: the config token creates the app once and is never returned; the pending secrets, settings and match come back', async () => {
  const token = ['xo', 'xe.', 'xo', 'xp-1-'].join('') + signingSecret();
  const cs = clientSecret();
  const ss = signingSecret();
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); const f = fixture('apps-manifest-create.json'); return jsonRes({ ...f, credentials: { ...f.credentials, client_secret: cs, signing_secret: ss, verification_token: 'v' } }); };
  const out = await spec.connect.prepare({ input: { config_token: token }, fetch, ...URLS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://slack.com/api/apps.manifest.create');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(new URLSearchParams(calls[0].init.body).get('manifest')), manifest(URLS));
  assert.deepEqual(out, { secrets: { client_secret: cs, signing_secret: ss }, settings: { ...PINNED }, match: { ...PINNED } });
  assert.ok(!JSON.stringify(out).includes(token), 'the config token is not in what prepare returns');
  assert.deepEqual([...spec.connect.prepareInputs], [...PREPARE_INPUTS]);
  assert.deepEqual([...PREPARE_INPUTS], ['config_token', 'app_id', 'client_id', 'client_secret', 'signing_secret']);
});

test('prepare: nothing pasted asks for the four values with a prefilled create link; pasted values are checked; failures are fixed text', async () => {
  const cs = clientSecret();
  const ss = signingSecret();
  const none = async () => { throw new Error('no fetch here'); };
  for (const input of [undefined, {}]) {
    const ask = await spec.connect.prepare({ input, fetch: none, ...URLS });
    assert.deepEqual(ask.needs.fields, ['app_id', 'client_id', 'client_secret', 'signing_secret']);
    assert.equal(ask.needs.create_url, spec.connect.manifestLink(URLS));
    const u = new URL(ask.needs.create_url);
    assert.equal(`${u.origin}${u.pathname}`, 'https://api.slack.com/apps');
    assert.ok(spec.hosts.includes(u.hostname), 'the registry only passes a create_url on hosts');
    assert.deepEqual(JSON.parse(u.searchParams.get('manifest_json')), manifest(URLS));
  }
  const out = await spec.connect.prepare({ input: { app_id: 'A0APP01', client_id: '1234567890.9876543210', client_secret: cs, signing_secret: ss }, fetch: none, ...URLS });
  assert.deepEqual(out, { secrets: { client_secret: cs, signing_secret: ss }, settings: { ...PINNED }, match: { ...PINNED } });
  await assert.rejects(spec.connect.prepare({ input: { client_id: '1.2', client_secret: cs, signing_secret: ss }, fetch: none, ...URLS }), /incomplete/);
  await assert.rejects(spec.connect.prepare({ input: { app_id: 'A0APP01', client_id: '1.2', client_secret: cs, signing_secret: 'short' }, fetch: none, ...URLS }), /incomplete/);
  await assert.rejects(spec.connect.prepare({ input: { config_token: 'bad token!' }, fetch: none, ...URLS }));
  await assert.rejects(spec.connect.prepare({ input: { config_token: 'a'.repeat(30) }, fetch: none, webhookUrl: WEBHOOK, redirectUri: REDIRECT }), /no hub urls/, 'the manifest needs the identity callback too');
  const good = { app_id: 'A0APP01', client_id: '1234567890.9876543210', client_secret: cs, signing_secret: ss };
  for (const over of [
    { signing_secret: 'a'.repeat(16) }, { client_secret: 'A'.repeat(32) }, { signing_secret: ss.slice(0, 31) }, { client_secret: `${cs}0` },
    { app_id: 'A0X1' }, { app_id: 'a0app01' }, { client_id: '12345' }, { client_id: '1.2.3' },
  ]) {
    const err = await spec.connect.prepare({ input: { ...good, ...over }, fetch: none, ...URLS }).then(() => null, (e) => e);
    assert.match(err?.message ?? '', /^the app credentials are incomplete$/, JSON.stringify(over));
    for (const v of Object.values(over)) assert.ok(!err.message.includes(v), 'no input in the error');
  }
  await assert.rejects(spec.connect.prepare({ input: { config_token: 'a'.repeat(30) }, fetch: async () => jsonRes({ ok: false, error: 'invalid_auth' }), ...URLS }), /invalid_auth/);
});

test('handshake: only a parsed url_verification', () => {
  assert.equal(spec.connect.handshake({ payload: parseBody({ rawBody: raw('url-verification.json'), headers: { 'content-type': 'application/json' } }) }), true);
  for (const payload of [cmd(), ia(fixture('message-action.json')), { kind: 'ssl_check', body: {} }, { type: 'url_verification' }, null]) assert.equal(spec.connect.handshake({ payload }), false);
});

const access = (over = {}) => ({ ...fixture('oauth-v2-access.json'), access_token: botToken(), ...over });
const exchangeWith = (body, opts = {}) => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return jsonRes(body); };
  const cs = clientSecret();
  return { calls, cs, run: () => spec.connect.exchange({ query: new URLSearchParams({ code: '1234.5678.abcd', state: 's' }), redirectUri: REDIRECT, provider: { app_id: 'A0APP01', client_id: '1234567890.9876543210', ...opts.provider }, config: { ...opts.config }, secrets: { client_secret: cs, signing_secret: signingSecret() }, fetch }) };
};

test('exchange: oauth.v2.access with HTTP Basic; external_id is team.id; only the bot token is sealed; match names the installed app', async () => {
  const body = access();
  const x = exchangeWith(body);
  const out = await x.run();
  assert.equal(x.calls[0].url, 'https://slack.com/api/oauth.v2.access');
  assert.equal(x.calls[0].init.headers.authorization, `Basic ${Buffer.from(`1234567890.9876543210:${x.cs}`).toString('base64')}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(x.calls[0].init.body)), { code: '1234.5678.abcd', redirect_uri: REDIRECT, grant_type: 'authorization_code' });
  assert.equal(out.external_id, 'T0TEAM1');
  assert.deepEqual(out.secrets, { bot_token: body.access_token });
  assert.deepEqual(out.scopes, [...BOT_SCOPES]);
  assert.deepEqual(out.settings, { bot_user_id: 'U0BOT001' }, 'F5: no hub_url or team_id: the team is external_id, the hub URL ctx.hubUrl');
  assert.deepEqual(out.match, { ...PINNED });
  const other = await exchangeWith(access({ app_id: 'A0OTHER1' })).run();
  assert.deepEqual(other.match, { app_id: 'A0OTHER1', client_id: PINNED.client_id }, 'another app is reported as it is: the registry refuses the mismatch');
});

test('exchange refuses: extra or missing scopes, no app id, no team, Enterprise Grid, a user token, a non-bot token, Slack errors', async () => {
  const bad = [
    access({ scope: 'commands,chat:write,channels:history' }), access({ scope: 'commands' }), access({ scope: 'commands,chat:write,chat:write' }),
    access({ app_id: 'not-an-app' }), access({ app_id: undefined }), access({ team: { id: 'not-a-team' } }), access({ team: null }),
    access({ enterprise: { id: 'E0GRID1', name: 'grid' } }), access({ is_enterprise_install: true }),
    access({ is_enterprise_install: 'true' }), access({ is_enterprise_install: 1 }),
    access({ authed_user: { id: 'U0ADMIN1', scope: 'search:read' } }), access({ incoming_webhook: { channel: '#general', url: 'https://hooks.slack.com/x' } }),
    access({ authed_user: { id: 'U0ADMIN1', access_token: 'user-token', scope: 'chat:write' } }),
    access({ token_type: 'user' }), access({ access_token: 'not-a-bot-token' }), access({ bot_user_id: 'nobody' }),
    { ok: false, error: 'invalid_code' }, { ok: true },
  ];
  for (const body of bad) await assert.rejects(exchangeWith(body).run(), JSON.stringify(body).slice(0, 80));
  await assert.rejects(spec.connect.exchange({ query: new URLSearchParams({ code: 'x y' }), provider: PINNED, secrets: { client_secret: 'c' }, fetch: async () => jsonRes(access()) }), /bad oauth code/);
  await assert.rejects(exchangeWith(access(), { provider: { client_id: undefined } }).run(), /no pending app/);
});

// ── identity (Sign in with Slack) ──────────────────────────────────────

// What the D98 hooks get (C1): {external_id, settings: {pinned, provider}}, never config.
const CONNECTION = Object.freeze({ external_id: TEAM, settings: Object.freeze({ pinned: PINNED, provider: PROVIDER }) });
const ID_CB = 'https://board.example.test/integrations/slack/identity/callback';

test('identity: the D98 shape (issuer and JWKS on slack.com, the team claim, the user id pattern)', () => {
  const c = spec.identity;
  assert.deepEqual([c.issuer, c.jwksUrl, c.workspaceClaim], ['https://slack.com', 'https://slack.com/openid/connect/keys', 'https://slack.com/team_id']);
  assert.equal(String(c.subjectRe), '/^[UW][A-Z0-9]{2,20}$/');
  assert.equal(c.subjectRe.flags, '');
});

test('identity.authorizeUrl: OIDC, openid only, the pinned client id, this workspace, the registry\'s nonce', () => {
  const u = new URL(spec.identity.authorizeUrl({ state: 'st', redirectUri: ID_CB, nonce: 'n1', connection: CONNECTION }));
  assert.equal(`${u.origin}${u.pathname}`, 'https://slack.com/openid/connect/authorize');
  assert.deepEqual(Object.fromEntries(u.searchParams), { response_type: 'code', scope: 'openid', client_id: CONFIG.client_id, state: 'st', nonce: 'n1', redirect_uri: ID_CB, team: 'T0TEAM1' });
  assert.throws(() => spec.identity.authorizeUrl({ state: 'st', redirectUri: ID_CB, connection: CONNECTION }), /incomplete/, 'no nonce, no link');
});

const oidc = (connection = CONNECTION, tokenRes = null) => {
  const calls = [];
  const idToken = ['eyJhbGciOiJSUzI1NiJ9', Buffer.from('{"sub":"U0ALICE"}').toString('base64url'), randomSig()].join('.');
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonRes(tokenRes ?? { ok: true, access_token: 'opaque-user-access', token_type: 'Bearer', id_token: idToken });
  };
  const cs = clientSecret();
  return { calls, idToken, cs, run: () => spec.identity.exchange({ query: new URLSearchParams({ code: '99.88.ff' }), state: 'st', redirectUri: ID_CB, connection, secrets: { client_secret: cs }, fetch }) };
};
function randomSig() { return Buffer.from(signingSecret()).toString('base64url'); }

test('identity.exchange: one openid.connect.token call with the pinned client id; only the id_token comes back (the registry verifies it)', async () => {
  const x = oidc();
  assert.deepEqual(await x.run(), { id_token: x.idToken });
  assert.deepEqual(x.calls.map((c) => c.url), ['https://slack.com/api/openid.connect.token'], 'no userInfo read, no auth.revoke');
  assert.equal(x.calls[0].init.headers.authorization, `Basic ${Buffer.from(`${PINNED.client_id}:${x.cs}`).toString('base64')}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(x.calls[0].init.body)), { code: '99.88.ff', redirect_uri: ID_CB, grant_type: 'authorization_code' });
});

test('identity.exchange refuses a missing or malformed id_token and Slack errors, with fixed text', async () => {
  for (const res of [{ ok: true, access_token: 'a' }, { ok: true, id_token: 'not a jwt' }, { ok: true, id_token: 'a.b' }, { ok: false, error: 'invalid_code' }]) {
    const err = await oidc(CONNECTION, res).run().then(() => null, (e) => e);
    assert.ok(err, JSON.stringify(res));
    assert.ok(!/not a jwt|a\.b/.test(err.message));
  }
  await assert.rejects(spec.identity.exchange({ query: new URLSearchParams({ code: 'x y' }), redirectUri: ID_CB, connection: CONNECTION, secrets: { client_secret: 'c' }, fetch: async () => jsonRes({}) }), /bad oauth code/);
});

test('spec: hosts, secrets, scopes and the slice A/B keys', () => {
  assert.deepEqual(spec.hosts, ['slack.com', 'hooks.slack.com', 'api.slack.com']);
  assert.deepEqual(spec.secrets, ['bot_token', 'signing_secret', 'client_secret']);
  assert.equal(spec.workspaceUnique, true);
  assert.equal(typeof spec.ackEarly, 'function');
  for (const k of ['parseBody', 'ackBody', 'verify', 'handleWebhook', 'rateSubject', 'onAckedFailure']) assert.equal(typeof spec[k], 'function', k);
  for (const k of ['prepare', 'authorizeUrl', 'exchange', 'handshake']) assert.equal(typeof spec.connect[k], 'function', k);
  for (const k of ['authorizeUrl', 'exchange']) assert.equal(typeof spec.identity[k], 'function', k);
  assert.deepEqual(Object.keys(spec.actions), ['slack.create_card']);
});

test('no token-shaped literal in the connector source', () => {
  for (const f of ['spec.js', 'webhook.js', 'index.js']) assert.doesNotMatch(readFileSync(new URL(`../integrations/slack/${f}`, import.meta.url), 'utf8'), /xox[a-z]-|xapp-/, f);
  assert.ok(raw('slash-command-todo.form').length > 0);
});

test('privacy: every network line in the connector is tagged integrations-hub, and PRIVACY.md lists the file under that flow', () => {
  const privacy = readFileSync(new URL('../../../PRIVACY.md', import.meta.url), 'utf8');
  const files = /<!-- flow:integrations-hub files=([^\s>]+) -->/.exec(privacy)?.[1].split(',') ?? [];
  let tagged = 0;
  for (const f of ['spec.js', 'webhook.js', 'index.js']) {
    const lines = readFileSync(new URL(`../integrations/slack/${f}`, import.meta.url), 'utf8').split('\n');
    for (const l of lines.filter((x) => /\bfetch\(/.test(x) && !/^\s*\/\//.test(x))) {
      assert.match(l, /\/\/ privacy-flow: integrations-hub$/, `${f}: ${l.trim()}`);
      tagged += 1;
      assert.ok(files.includes(`board/hub/integrations/slack/${f}`), `${f} is not in the integrations-hub files list`);
    }
  }
  assert.ok(tagged >= 3);
});

test('shim pipeline (slice A final): url_verification is acked early with only the verified challenge; ssl_check gets an empty 200', async () => {
  const { shimPipeline, signed } = await import('./slack-shim.js');
  const secrets = { bot_token: botToken(), signing_secret: signingSecret() };
  const ctx = stubCtx({ secrets });
  const { deliver } = shimPipeline(spec, { secrets, ctxOf: () => ctx });
  const uv = await deliver(signed(secrets.signing_secret, raw('url-verification.json')));
  assert.deepEqual([uv.status, uv.early, uv.body], [200, true, fixture('url-verification.json').challenge]);
  const ssl = await deliver(signed(secrets.signing_secret, Buffer.from('ssl_check=1&token=x')));
  assert.deepEqual([ssl.status, ssl.early, ssl.body], [200, true, undefined]);
  const forged = await deliver(signed(signingSecret(), raw('url-verification.json')));
  assert.equal(forged.status, 401, 'an unverified challenge is never echoed');
  assert.equal(ctx.slack.calls.length, 0);
});

for (const channel of [null, '', [], ['C0CHAN1'], { value: 'C0CHAN1' }, 'C0OTHER']) test(`selected channel is explicit and primitive: ${JSON.stringify(channel)}`, async () => {
  const { ctx } = setup({ config: { channel_id: channel } });
  await run(ctx, cmd()); await run(ctx, ia(fixture('message-action.json')));
  assert.equal(ctx.cards.size + ctx.acts.length, 0);
  assert.equal(ctx.slack.api('views.open').length, 0);
});

test('selected modal refuses an authentic legacy form without the connection authority digest', async () => {
  const { ctx, secrets } = setup();
  const meta = rawSealMeta(secrets.signing_secret, { team: TEAM, channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0ALICE' });
  await run(ctx, submission(secrets, { meta }));
  assert.equal(ctx.cards.size + ctx.acts.length + ctx.slack.api('chat.getPermalink').length, 0);
  assert.equal(JSON.parse(ctx.slack.api('chat.postEphemeral')[0].body).text, TARGET_CHANGED);
});
