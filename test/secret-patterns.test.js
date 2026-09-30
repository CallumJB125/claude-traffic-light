// board/shared/secret-patterns.mjs: per-kind positives and negatives, the
// span each hit reports, the class split scope.js relies on, and linear time.
// Loaded with require() on purpose: that is how the CommonJS app loads it.
//
// Fake tokens are assembled at run time (j(...)) so the repository never
// holds a string a secret scanner would flag.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SECRET_PATTERNS, CLASSES, findSecrets, hasCredential, redactSecrets, patternsOf } = require('../board/shared/secret-patterns.mjs');

const j = (...parts) => parts.join('');
const rep = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const A36 = rep('aB3dE5fG7h', 36);
const A40 = rep('aB3dE5fG7h', 40);
const HEX32 = rep('0a1b2c3d4e5f6789', 32);
const HEX64 = rep('0a1b2c3d4e5f6789', 64);

const secretOf = (text, opts) => findSecrets(text, opts).map((h) => text.slice(h.index, h.index + h.length));
const kindsOf = (text, opts) => findSecrets(text, opts).map((h) => h.kind);

// [kind, text, the secret span findSecrets must report]
const POSITIVES = [
  ['private_key', j('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----'), null],
  ['private_key', j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----')],
  ['private_key', j('"private_key": "-----BEGIN ', 'PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n"')],
  ['private_key', j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----')],
  ['private_key', j('-----BEGIN ENCRYPTED ', 'PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nMIIFHz\n-----END ENCRYPTED PRIVATE KEY-----')],
  ['private_key', j('truncated -----BEGIN EC ', 'PRIVATE KEY-----\nMHcCAQEEI no end')],
  ['pem_base64', j('client-key-data: LS0tLS1CRUdJTi', 'BSU0EgUFJJVkFURSBLRVktLS0tLQpNSUlFcEFJQkFBS0NBUUVB')],
  ['putty_key', j('PuTTY-User-', 'Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\nAAAAIGx\nPrivate-MAC: 0a1b2c')],
  ['age_key', j('AGE-SECRET-', 'KEY-1', rep('QZ9', 58))],
  ['anthropic_key', j('ANTHROPIC_API_KEY=sk-', 'ant-api03-', A40)],
  ['anthropic_key', j('key sk-', 'ant-admin01-', A40)],
  ['openai_key', j('OPENAI_API_KEY="sk-', 'proj-', A40, '"')],
  ['openai_key', j('sk-', 'or-v1-', HEX64)],
  ['openai_key', j('env = type=sk-', 'svcacct-', 'cmIgs-eiPKxSvPLc-diHAP-FMfEjreBFtTPSQoaDAkxICIFP'), j('sk-', 'svcacct-', 'cmIgs-eiPKxSvPLc-diHAP-FMfEjreBFtTPSQoaDAkxICIFP')],
  ['stripe_key', j('sk_', 'live_', A36)],
  ['stripe_key', j('rk_', 'test_', A36)],
  ['stripe_webhook', j('whsec_', A36)],
  ['aws_access_key', j('aws_access_key_id = AKIA', 'QQQQQQQQQQQQQQQQ')],
  ['aws_access_key', j('ASIA', 'ZZZZZZZZZZZZZZZZ')],
  ['github_token', j('ghp_', A36)],
  ['github_token', j('gho_', A36)],
  ['github_pat', j('github_', 'pat_', A36, '_', A36)],
  ['gitlab_token', j('gl', 'pat-', 'abcdefghij1234567890')],
  ['slack_token', j('xo', 'xb-', '1234567890-abcdefghij')],
  ['slack_token', j('xoxe.', 'xo', 'xp-1-abcdefghijklmn')],
  ['slack_app_token', j('xapp-', '1-A01-abcdefghijklmn')],
  ['slack_webhook', j('url = "https://hooks.slack.com/services/', 'T0000/B0000/', A36, '"')],
  ['discord_webhook', j('https://discord.com/api/webhooks/', '123456789012/', A40, A40)],
  ['discord_bot_token', j('Authorization: Bot ', 'MTEyMzQ1Njc4OTAxMjM0NTY3OA', '.GhIjKl.', 'Zx81nQ4pLr7TtY2wAbCdEfGhIjK')],
  ['google_access_token', j('ya29', '.a0AfB_byC', A40)],
  ['google_refresh_token', j('1//0', A40)],
  ['docker_pat', j('dckr_', 'pat_', A36)],
  ['pinecone_key', j('pcsk_', A36)],
  ['planetscale_token', j('pscale_', 'pw_', A36)],
  ['langsmith_key', j('lsv2_', 'pt_', HEX32, '_', rep('0a1b2c3d4e', 10))],
  ['mapbox_secret', j('sk.', 'eyJ1IjoiYWNtZSIsImEiOiJ', 'abc.', A36)],
  ['basic_auth_header', j(j('Authorization: Basic dXNlcj', 'podW50'), 'ZXIyc2VjcmV0'), 'dXNlcjpodW50ZXIyc2VjcmV0'],
  ['google_api_key', j('AIza', 'SyA-', rep('abcdefghij', 31))],
  ['google_oauth_secret', j('GOCSPX-', A36)],
  ['npm_token', j('//registry.npmjs.org/:_authToken=npm_', A36)],
  ['pypi_token', j('password = pypi-', 'AgEIcHlwaS5vcmc', A40)],
  ['huggingface_token', j('HF_TOKEN=hf_', A36)],
  ['huggingface_token', j('"hint": "hf_', 'GOvgzODdDjEEGasjlfBbqokuGahUecJAxU"'), j('hf_', 'GOvgzODdDjEEGasjlfBbqokuGahUecJAxU')],
  ['anthropic_key', j('export K="${K:-sk-', 'ant-api03-', A40, '}"'), j('sk-', 'ant-api03-', A40)],
  ['jwt_like', j('x="${p:-eyJ', 'wKYf51U2u60DK77S.tCEBRNlITR_hEnNUuDnNxoiS.aKhZPgn6euT9Uez}"'), j('eyJ', 'wKYf51U2u60DK77S.tCEBRNlITR_hEnNUuDnNxoiS.aKhZPgn6euT9Uez')],
  ['twilio_key', j('SK', HEX32)],
  ['sendgrid_key', j('SG.', rep('abcDEF123', 22), '.', rep('abcDEF123', 43))],
  ['digitalocean_token', j('dop_', 'v1_', HEX64)],
  ['doppler_token', j('dp.', 'st.', A40)],
  ['vault_token', j('VAULT_TOKEN hvs.', A36)],
  ['shopify_token', j('shpat_', HEX32)],
  ['linear_key', j('lin_', 'api_', A40)],
  ['atlassian_token', j('ATATT3', A40, A40)],
  ['databricks_token', j('dapi', HEX32)],
  ['telegram_bot_token', j('123456789:', 'AA', rep('Hq3-_x', 33))],
  ['figma_token', j('figd_', A40)],
  ['supabase_key', j('sbp_', rep('0a1b2c3d4e', 40))],
  ['postman_key', j('PMAK-', rep('0a1b2c', 24), '-', rep('0a1b2c', 34))],
  ['grafana_token', j('glsa_', A36)],
  ['sentry_token', j('sntrys_', A40)],
  ['tailscale_key', j('tskey-', 'auth-', 'kABC123CNTRL-', A36)],
  ['groq_key', j('gsk_', A40, 'ab')],
  ['xai_key', j('xai-', A40, A40)],
  ['replicate_token', j('r8_', A36)],
  ['perplexity_key', j('pplx-', A40, 'ab')],
  ['notion_token', j('ntn_', A40, 'abc')],
  ['airtable_token', j('pat', rep('aB3dE5', 14), '.', HEX64)],
  ['heroku_token', j('HRKU-', A36)],
  ['fly_token', j('FlyV1 fm2_', A40, A40)],
  ['netlify_token', j('nfp_', A36)],
  ['onepassword_service_token', j('ops_', 'eyJ', A40)],
  ['jwt_like', j('eyJhbGciOiJIUzI1NiJ9.', 'eyAic3ViIjogIjEyMyJ9.dozjgNryP4J3jVmN')],
  ['jwt', j('token eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N')],
  ['url_credentials', j('https://jane:hunt', 'er22@example.com/x'), 'hunter22'],
  ['url_credentials', j('redis://:hunt', 'er2pw@cache.local:6379'), 'hunter2pw'],
  ['url_credentials', j('export U="${U:-https://ci-bot:Ll5zfkHPw', 'td0MPa~5l@git.example.com/o/r.git}"'), 'Ll5zfkHPwtd0MPa~5l'],
  ['url_credentials', j('postgres://app:s3cr', '3t%21@db.internal:5432/prod'), 's3cr3t%21'],
  ['bearer', j('Authorization: Bearer ', A36), A36],
  ['bearer', j('export H="${H:-Bearer ', 'IcK-s1OH9CPSAcBt6NMxkcv0ZnKTvikZV0gRn12P}"'), 'IcK-s1OH9CPSAcBt6NMxkcv0ZnKTvikZV0gRn12P'],
  ['bearer', j(j('curl -H "X-Custom: Bearer toYvKEJBKZ', 'QfosYpyAEp'), 'JkgfvtoBAWIgdhvKqqmf"'), 'toYvKEJBKZQfosYpyAEpJkgfvtoBAWIgdhvKqqmf'],
  ['cf_access_secret', j(j('CF-Access-Client-Secret: abcde', 'f01234'), '56789abcdef'), 'abcdef0123456789abcdef'],
  ['env_secret', j('export MY_SERVICE_TOKEN=hunter', '2secret'), 'hunter2secret'],
  ['env_secret', j('GITHUB_TOKEN=hunter', '2secret'), 'hunter2secret'],

  ['dash_key', j('pk-', A36)],
  ['hex_secret', `x-buddy-token ${'3f'.repeat(32)}`, '3f'.repeat(32)],
  ['aws_secret', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['basic_auth', j('Authorization: Basic dXNlcjpwYX', 'Nzd29yZA=='), 'dXNlcjpwYXNzd29yZA=='],
  ['auth_header', 'authorization=Token abc123secretvalue', 'abc123secretvalue'],
  ['auth_header', 'Authorization: Splunk 3fa85f64-5717-4562-b3fc-2c963f66afa6', '3fa85f64-5717-4562-b3fc-2c963f66afa6'],
  ['auth_header', '"Authorization": "shortTok1"', 'shortTok1'],
  ['auth_header', 'curl -H "Authorization: Authorization: Token CQdGcKomcB0QyLizBoHVidTd"', 'CQdGcKomcB0QyLizBoHVidTd'],
  ['bearer_short', 'curl -H "authorization: bearer abc123xyz"', 'abc123xyz'],
  ['url_userinfo', 'https://jane:hunter2@example.com/x', 'hunter2'],
  ['url_token_user', j('https://', 'Zx81nQ4pLr7TtY2wAbCd', '@dev.azure.com/org/repo'), 'Zx81nQ4pLr7TtY2wAbCd'],
  ['cli_secret_arg', '"args": ["-y", "--api-key", "Zx81nQ4pLr7"]', 'Zx81nQ4pLr7'],
  ['netrc', 'machine github.com login callum password Zx81nQ4pLr7TtY2w', 'Zx81nQ4pLr7TtY2w'],
  ['netrc_line', 'machine api.heroku.com\n  login me@x.com\n  password 9f8e7d6c-1234-4abc', '9f8e7d6c-1234-4abc'],
  ['keyed_exact', '{"auths":{"https://index.docker.io/v1/":{"auth":"dXNlcjpodW50ZXIy"}}}', 'dXNlcjpodW50ZXIy'],
  ['keyed_exact', 'pass = kGZ3xyzObscured', 'kGZ3xyzObscured'],
  ['keyed_exact', 'x="${x:-pass = 7GGLJ38qUnzk1P9xSDLE/yTOi+U5k/}"', '7GGLJ38qUnzk1P9xSDLE/yTOi+U5k/'],
  ['huggingface_token', j('"endpoint": "hf_', 'yJbndAtknryhPg6yxqbNMDq6vg6iPkzbfi"'), j('hf_', 'yJbndAtknryhPg6yxqbNMDq6vg6iPkzbfi')],
  ['url_query_secret', 'https://api.example.com/v1?user=1&access_token=abcdef123456&x=2', 'abcdef123456'],
  ['url_query_secret', 'https://acct.blob.core.windows.net/c?sv=2024&sig=Zm9vYmFyYmF6cXV4', 'Zm9vYmFyYmF6cXV4'],
  ['cli_secret_flag', 'mysql --password=hunter2 -h db', 'hunter2'],
  ['cli_secret_flag', 'deploy --token s3cretvalue --prod', 's3cretvalue'],
  ['said_password', 'the password is hunter2 ok', 'hunter2'],
  ['keyed', 'db_pwd=s3cr3tpass', 's3cr3tpass'],
  ['keyed', '{"client_secret": "correct horse battery staple"}', 'correct horse battery staple'],
  ['keyed', 'password: my secret phrase', 'my secret phrase'],
  ['keyed', "api_key = 'k-123-456'", 'k-123-456'],
  ['keyed', 'Cookie: sessionid=abcdef0123456789', 'sessionid=abcdef0123456789'],
  ['keyed', '"apiKey": "abc"', 'abc'],
  ['keyed', 'SENTRY_DSN: https://abc@o1.ingest.sentry.io/2', 'https://abc@o1.ingest.sentry.io/2'],
  ['keyed', '"webhook_url": "https://example.com/hook/xyz"', 'https://example.com/hook/xyz'],
  ['keyed', 'password: "$uperS3cretPass"', '$uperS3cretPass'],
  ['keyed', 'password = <Tr0ub4dor&3>', '<Tr0ub4dor&3>'],
  ['keyed', 'api_key_file = Zx81nQ4pLr7TtY2wAbCdEf', 'Zx81nQ4pLr7TtY2wAbCdEf'],
  ['keyed', 'export MISTRAL_KEY=abc123def', 'abc123def'],
  ['keyed', '  smtppass = Zx81nQ4p', 'Zx81nQ4p'],
  ['keyed', 'password = "hunter2', 'hunter2'],
  ['keyed', "secret = 'it\\'s-a-secret'", "it\\'s-a-secret"],
  ['keyed', j('secret: "', 'Zx81'.repeat(600), '"'), 'Zx81'.repeat(600)],
  ['keyed', j('ACME_CORP_INTERNAL_KNOWLEDGE_BASE_SERVICE_PRODUCTION_ENVIRONMENT_API_KEY=', 'Zx81nQ4p'), 'Zx81nQ4p'],
  ['keyed_set', 'set -gx OPENAI_TOKEN hunter2secret', 'hunter2secret'],
  ['keyed_set', 'setenv DB_PASSWORD hunter2', 'hunter2'],
  ['keyed_set', 'typeset -x GITHUB_TOKEN hunter2secret', 'hunter2secret'],
  ['xml_secret', '<password>hunter2</password>', 'hunter2'],
];

test('every kind has at least one positive case', () => {
  const covered = new Set(POSITIVES.map(([k]) => k));
  const missing = SECRET_PATTERNS.map((p) => p.kind).filter((k) => !covered.has(k));
  assert.deepEqual(missing, []);
});

for (const [kind, text, span] of POSITIVES) {
  test(`${kind}: ${JSON.stringify(text.slice(0, 50))}`, () => {
    const p = SECRET_PATTERNS.find((x) => x.kind === kind);
    assert.ok(p, `no pattern ${kind}`);
    // The named pattern on its own must find it.
    const own = secretOf(text, { classes: [p.class], kinds: [kind] });
    assert.ok(own.length > 0, `${kind} found nothing`);
    const needle = span || own[0];
    const at = text.indexOf(needle);
    const covers = (hits) => hits.some((h) => h.index <= at && h.index + h.length >= at + needle.length);
    assert.ok(covers(findSecrets(text, { classes: [p.class], kinds: [kind] })), `${kind} reported ${JSON.stringify(own)}, expected to cover ${JSON.stringify(needle)}`);
    assert.ok(covers(findSecrets(text)), `${kind}: merged hits do not cover the secret`);
  });
}

// Must NOT be reported at all (any class).
const CLEAN = [
  ['VS Code keybinding', '{ "key": "ctrl+shift+p", "command": "workbench.action.showCommands" }'],
  ['max tokens is a count', '"MAX_THINKING_TOKENS": "31999"'],
  ['token limit key', 'token_limit = 4096'],
  ['credential helper', '[credential]\n\thelper = osxkeychain'],
  ['password file path', 'password_file = ~/.config/x/pw'],
  ['passwordCommand', 'passwordCommand = "pass show mail"'],
  ['value is a variable', 'api_key = ${OPENAI_API_KEY}'],
  ['value is a placeholder', 'token: <your-token-here>'],
  ['1Password reference', 'api_key = op://Private/OpenAI/credential'],
  ['already templated', 'api_key = {{SECRET:api_key}}'],
  ['boolean', 'use_token: true'],
  ['UUID', 'session 3fa85f64-5717-4562-b3fc-2c963f66afa6 ended'],
  ['prose', 'Basic setup: install the token-based auth plugin, then restart.'],
  ['sk- in a word', 'scikit-sk-learn is a package'],
  ['short bearer word', 'the bearer of bad news'],
  ['url without creds', 'https://github.com/acme/app.git and git@github.com:acme/app.git'],
  ['email', 'jane.doe@example.com'],
  ['empty quoted', 'password = ""'],
  ['placeholder word', 'token: <YOUR_TOKEN>'],
  ['your-api-key', 'api_key: your-api-key'],
  ['token type is a word', 'token_type: bearer'],
  ['bearer and a camelCase name', 'uses Bearer TokenAuthenticationHandler here'],
  ['sk- then a lowercase name', 'see sk-some-long-identifier-name'],
];

for (const [name, text] of CLEAN) {
  if (!text) continue;
  test(`clean: ${name}`, () => assert.deepEqual(secretOf(text), []));
}

test('bearer and sk- tokens without digits count only in random case', () => {
  for (const s of ['Authorization: Bearer YOUR_ACCESS_TOKEN_HERE', 'Bearer AuthenticationProviderFactory', j('sk-p', 'roj-ABCDEFGHIJKLMNOPQRSTUV'), 'sk-TokenizerConfigurationValue']) assert.equal(hasCredential(s), false, s);
});

test('class credential never matches a 40-hex SHA, UUID, email or 64-hex digest', () => {
  for (const s of [
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'uuid 3fa85f64-5717-4562-b3fc-2c963f66afa6',
    'jane.doe+x@example.co.uk',
    `sha256 ${HEX64}`,
    '"lazy.nvim": { "branch": "main", "commit": "9fceb02d0ae598e95dc970b74767f19372d61af8" }',
  ]) assert.equal(hasCredential(s), false, s);
  assert.deepEqual(kindsOf('commit 9fceb02d0ae598e95dc970b74767f19372d61af8'), ['hex_secret']);
});

test('realistic board frames carry no credential', () => {
  const frames = [
    { type: 'run_started', repo_id: 'r_01J9Z6', card_id: 'c_01J9Z7K2', session_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', head: '9fceb02d0ae598e95dc970b74767f19372d61af8', branch: 'feat/board-accounts' },
    { type: 'claim', repo_id: 'r_01J9Z6', paths: ['board/hub/api.js', 'board/shared/scope.js'], member: 'alice@dev.local', at: '2026-09-30T20:15:00.000Z' },
    { type: 'handover', repo_id: 'r_01J9Z6', text: 'Tokens are refreshed by the hub; see board/CONTRACT.md §4. Ask alice@dev.local. Basic flow: claim, run, complete.', diffstat: '+120 -14' },
    { type: 'fact', repo_id: 'r_01J9Z6', kind: 'test_result', text: 'node --test: 312 pass, 0 fail (sha 1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d)' },
    { type: 'run_ended', repo_id: 'r_01J9Z6', exit: 0, cost_usd: 0.42, tokens: { input: 120000, output: 8000 }, request_id: 'req_3fa85f6457174562b3fc2c963f66afa6' },
  ];
  for (const f of frames) {
    const walk = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.entries(v).flat().flatMap(walk) : []);
    for (const s of walk(f)) assert.equal(hasCredential(s), false, s);
    for (const [, re] of patternsOf('credential')) for (const s of walk(f)) assert.equal(re.test(s), false, `${re} on ${s}`);
  }
});

test('spans keep the key name, the scheme word and the quotes', () => {
  const r = (t) => redactSecrets(t, { replace: () => 'X' });
  assert.equal(r(j('Authorization: Bearer ', A36)), 'Authorization: Bearer X');
  assert.equal(r(j('Authorization: Basic dXNlcjpwYX', 'Nzd29yZA==')), 'Authorization: Basic X');
  assert.equal(r(j('export API_KEY="hunter', '2secret"')), 'export API_KEY="X"');
  assert.equal(r('{"client_secret": "a b c"}'), '{"client_secret": "X"}');
  assert.equal(r('password: hunter2,'), 'password: X,');
  assert.equal(r('https://jane:hunter2@example.com'), 'https://jane:X@example.com');
  assert.equal(r('mysql --password=hunter2 -h db'), 'mysql --password=X -h db');
  assert.equal(r('https://h/x?user=1&sig=Zm9vYmFyYmF6&x=2'), 'https://h/x?user=1&sig=X&x=2');
  assert.equal(r('{password: hunter2}'), '{password: X}');
  assert.equal(r('password: abc def=='), 'password: X');
  assert.equal(r('X-Key: Basic RnF3aG9ocDI6aXg2UHpKdmdSNXV3ZmpudlpFTVA='), 'X-Key: X');
  assert.equal(r('token_type: bearer access_token: Zx81nQ4pLr7TtY2wAbCd'), 'token_type: bearer access_token: X');
  assert.equal(r('token = {{SECRET:token}}'), 'token = {{SECRET:token}}');
  assert.equal(r('export SENDGRID_API_KEY="{{SECRET:SENDGRID_API_KEY}}"'), 'export SENDGRID_API_KEY="{{SECRET:SENDGRID_API_KEY}}"');
  assert.equal(r('a <redacted:keyed> b [redacted]'), 'a <redacted:keyed> b [redacted]');
});

test('ordinary board text is not a credential (the guard must not refuse it)', () => {
  for (const s of [
    'Bumped MAX_TOKENS=200000', 'TOKEN_LIMIT=100000', 'PASSWORD_MIN_LENGTH=123456', 'CSRF_TOKEN_HEADER=X-CSRF-Token', 'SECRET_KEY_FILE=run/secrets/django',
    'ANTHROPIC_API_KEY=<your-key>', 'NPM_TOKEN=$NPM_TOKEN', 'NEXT_TOKEN=previous', 'The API uses Bearer authentication_middleware_v2',
    'Bearer token-based-authentication-flow', 'postgres://postgres:postgres@localhost:5432/app', 'redis://:${REDIS_PASSWORD}@redis:6379/0',
    'see https://user:pass@example.com in the docs', j('hf', '_transformersautomodelforcausallmloader'), 'secret_manageradapterfactoryfortheboardrunnerxyz',
    'feat/sk-refactor-login-flow-cleanup-2026', 'sk-learn-compat-shim-for-python-312', 'CF-Access-Client-Secret: ${CF_SECRET}',
  ]) assert.equal(hasCredential(s), false, s);
});

test('a skipped match does not hide the secrets after it on the line', () => {
  const t = 'cfg: {token_type: bearer, access_token: Zx81nQ4pLr7TtY2wAbCdEf}';
  assert.ok(!redactSecrets(t).includes('Zx81nQ4p'));
  const u = 'api_key_file = ~/.k; api_secret = Zx81nQ4pLr7TtY2wAbCdEf';
  assert.ok(!redactSecrets(u).includes('Zx81nQ4p'), redactSecrets(u));
});

test('overlapping hits merge; the credential kind wins even when a likely hit starts earlier', () => {
  const t = j('password: ghp_', A36, ' and more');
  const hits = findSecrets(t);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'github_token');
  assert.equal(hits[0].class, 'credential');
  assert.equal(t.slice(hits[0].index, hits[0].index + hits[0].length), j('ghp_', A36, ' and more'));
  // Two credential kinds on one span: the specific token beats the wrapper.
  const b = findSecrets(j('Authorization: Bearer sk-', 'ant-api03-', A40));
  assert.equal(b[0].kind, 'anthropic_key');
});

test('redactSecrets default stand-in and non-string input', () => {
  assert.equal(redactSecrets(j('ghp_', A36)), '<redacted:github_token>');
  assert.equal(redactSecrets(null), '');
  assert.deepEqual(findSecrets(undefined), []);
});

test('unknown or malformed class names throw instead of finding nothing', () => {
  assert.throws(() => findSecrets('x', { classes: ['credentials'] }), TypeError);
  assert.throws(() => findSecrets('x', { classes: 'credential' }), TypeError);
  assert.throws(() => findSecrets('x', { classes: [] }), TypeError);
  assert.throws(() => patternsOf('secret'), TypeError);
});

test('patternsOf("credential") matches scope.js CREDENTIAL_PATTERNS shape', () => {
  const list = patternsOf('credential');
  assert.ok(list.length > 40);
  for (const [kind, re] of list) {
    assert.equal(typeof kind, 'string');
    assert.ok(!re.global && !re.sticky, `${kind} must be usable with .test() repeatedly`);
  }
  const gh = list.find(([k]) => k === 'github_token')[1];
  assert.ok(gh.test(j('ghp_', A36)) && gh.test(j('ghp_', A36)));
  assert.deepEqual(CLASSES, ['credential', 'likely']);
});

test('the cached scanners carry no state between calls', () => {
  const long = rep(j('x ghp_', A36, ' '), 5000);
  const short = j('ghp_', A36);
  const a = findSecrets(short);
  findSecrets(long);
  assert.deepEqual(findSecrets(short), a);
  const b = findSecrets(long).length;
  findSecrets(short);
  assert.equal(findSecrets(long).length, b);
});

// Shapes that blew up other scrubbers: long runs of one token class, with no newline.
function seeds(N) {
  const crypto = require('node:crypto');
  const r = (s) => rep(s, N);
  return {
    b64url: crypto.randomBytes(N).toString('base64url').slice(0, N), b64: crypto.randomBytes(N).toString('base64').slice(0, N),
    ...Object.fromEntries([
      'a', '0', 'A', 'f', '-', '_', ' ', '=', '/', '.', ':', '"', "'", '\\', ')', ']', '}', 'aB3', 'a0-_', 'ab-', 'a.', 'x@', 'a:a@', 'AKIA', 'sk-', 'sk-a', 'sk-ant-', 'eyJ', 'eyJa.',
      'eyJxxxxxxxxxxx.', 'ghp_', 'TOKEN', 'TOKENTOKEN_', 'A_KEY=', 'token=', 'token', 'tokenx', 'token.', 'token-', 'secret_', 'password', 'password is ', 'aws ', 'aws=', 'aws/', 'A1/+',
      'https://', 'a:b', 'a:', '@', '://a:', j('-----BEGIN PRIVATE', ' KEY-----'), j('-----BEGIN PRIVATE', ' KEY-----\n-'), j('PuTTY-User-', 'Key-File-2:'), 'LS0tLS1CRUdJTi', 'Bearer ', 'Bearer x',
      'Basic ', 'authorization: ', 'authorization: a', '?key=', '&sig=', '--token ', '--token=', '"--token", "', 'set -x TOKEN ', 'setenv ', 'typeset -x ', '<password>', j('xo', 'xb-'),
      'xox', '1//0', 'SG.', 'dp.st.', 'hvs.', '123456789:AA', 'pat', '"token": "', '"token":"', "api_key: '", 'SECRET', 'A_SECRET=', 'A_SECRET=abcdef', 'machine x ', 'login a ',
      'token=)', 'auth: ', 'pass=', '{{AB}} ', 'token={{SECRET:x}} ', '{{SECRET:a}}=b ', '<redacted:x>=', 'some-long-kebab-identifier-', 'com.example.long.dotted.', 'abcdef0123-', 'MNO', 'ya29.', 'M'.padEnd(24, 'a') + '.',
    ].map((s) => [s, r(s)])),
  };
}

test('every pattern, post-processing included, is linear on 100 KB adversarial lines', () => {
  const slow = [];
  for (const [name, line] of Object.entries(seeds(100_000))) {
    for (const p of SECRET_PATTERNS) {
      const time = () => { const t0 = performance.now(); findSecrets(line, { classes: [p.class], kinds: [p.kind] }); return performance.now() - t0; };
      // A busy machine can stall one run; quadratic work is slow every time.
      let ms = time();
      if (ms > 200) ms = Math.min(ms, time());
      if (ms > 200) slow.push(`${p.kind} on ${JSON.stringify(name)}: ${ms.toFixed(0)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});

test('closing punctuation after long values does not make trimming quadratic', () => {
  for (const t of [rep(j('token=', rep(')', 2047), '\n'), 1_000_000), j('authorization: a', rep(')', 40000)), j('A_SECRET=abcdef', rep(']', 40000))]) {
    const t0 = performance.now();
    findSecrets(t);
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  }
});

test('the whole list on a 1 MB mixed dotfile stays fast', () => {
  const line = j('export API_KEY=', A36, ' # aws ', HEX32, ' ghp_', A36, ' https://u:p@h/x?token=abcdef123 ', '\n');
  const text = rep(line, 1_000_000);
  const t0 = performance.now();
  const hits = findSecrets(text);
  const ms = performance.now() - t0;
  assert.ok(hits.length > 1000);
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});

// ── review round: stand-ins, notion case band, documentation examples ──────
test('M2: a {{AB:...}} wrapper does not hide a credential from the guard (reviewer inputs)', () => {
  const hex32 = '9f86d081884c7d659a2feaa0c55ad015';
  for (const s of [
    j('here: {{GH:ghp_', '16C7e42F292c6912E7710c838347Ae178B4a}}'),
    j('echo {{GH:ghp_', '16C7e42F292c6912E7710c838347Ae178B4a}}\n'),
    j("alias db='databricks --host x {{DB:dapi", hex32, "}}'\n"),
    j('# {{LINEAR:lin_', 'api_abcdefghijklmnopqrstuvwxyz0123456789}}\n'),
    j('# {{S:xo', 'xb-', '2048-4096-abcdefghijklmnopqrstuvwx}}\n'),
    j('PASSWORD={{X:hunte', 'r2pass1}}'),
  ]) {
    assert.equal(hasCredential(s), true, s);
    // Even a scrubber that honours its own stand-ins honours none whose name is a secret.
    if (!s.startsWith('PASSWORD')) assert.equal(findSecrets(s, { classes: ['credential'], standIns: true }).length > 0, true, s);
  }
});

test('M2: stand-ins are honoured only on request, and only with a harmless name', () => {
  const t = 'token = {{SECRET:token}}\nnote <redacted:keyed> and [redacted]\n';
  assert.deepEqual(findSecrets(t), []);
  assert.deepEqual(findSecrets(t, { standIns: true }), []);
  assert.deepEqual(findSecrets('{{SECRET:api_key}}: {{HOME}}/x', { standIns: true }), []);
  assert.equal(hasCredential('API_KEY={{SECRET:api_key}}'), false);
});

test('F1: a random notion token whose case falls outside the band still counts when it mixes digits and both cases', () => {
  const v = j('ntn_', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn', 'Q7r2');
  assert.deepEqual(kindsOf(v), ['notion_token']);
  assert.equal(hasCredential('secret_manageradapterfactoryfortheboardrunnerxyz'), false);
});

test('L7: documentation examples do not trip the guard; the real shapes still do', () => {
  for (const s of [
    j('docs: export ANTHROPIC_API_KEY=sk-', 'ant-xxxxxxxxxxxxxxxxxxxxxxxx'),
    j('docs: GITHUB_TOKEN=ghp_', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
    j('AWS docs example AKIA', 'IOSFODNN7EXAMPLE'),
    j('slack: xo', 'xb-', 'your-bot-token-here'),
    j('grep for -----BEGIN OPENSSH ', 'PRIVATE KEY----- headers in the repo'),
  ]) assert.equal(hasCredential(s), false, s);
  for (const s of [
    j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n'),
    j('AKIA', 'QQQQQQQQQQQQQQQQ'),
    j('ghp_', A36),
  ]) assert.equal(hasCredential(s), true, s);
});

test('L7: a bodiless key block rescans past itself, so repeats stay linear', () => {
  const t = j('-----BEGIN ', 'PRIVATE KEY----- x ').repeat(8000);
  const t0 = performance.now();
  assert.deepEqual(findSecrets(t, { kinds: ['private_key'] }), []);
  assert.ok(performance.now() - t0 < 1000);
});

test('a real token pasted into a doc template is still a credential; bare examples are not', () => {
  const real = j('ghp_', 'lSh9pg14E9ML9DXBEp5ytDmeM3ExJBst1yzu');
  for (const text of [
    `Use ${real}${'x'.repeat(36)} for the bot.`,
    j('export K=sk-', 'ant-api03-', A40, 'sk-ant-your-key-here'),
    j('gl', 'pat-', 'Zx81nQ4pLr7TtY2wAbCd', '-your-token-here'),
    j('npm_', A36, 'xxxxxxxx'),
    `${real}'\\''`,
  ]) assert.equal(hasCredential(text), true, text);
  for (const text of [j('ghp_', 'x'.repeat(36)), j('AKIA', 'IOSFODNN7EXAMPLE'), j('xo', 'xb-', 'your-bot-token-here'), j('sk-', 'ant-your-key-here-please-fill')]) {
    assert.equal(hasCredential(text), false, text);
  }
  // A scrubber can turn the example skip off.
  assert.equal(findSecrets(j('ghp_', 'x'.repeat(36)), { docExamples: false }).length, 1);
});

test('redactSecrets passes every findSecrets option through', () => {
  const ex = j('ghp_', 'x'.repeat(36));
  assert.equal(redactSecrets(ex), ex, 'doc example kept by default');
  assert.equal(redactSecrets(ex, { docExamples: false }), '<redacted:github_token>');
  const two = j('ghp_', A36, ' ', 'AKIA', 'QQQQQQQQQQQQQQQQ');
  assert.equal(redactSecrets(two, { kinds: ['github_token'] }), j('<redacted:github_token> AK', 'IA', 'Q'.repeat(16)));
  assert.equal(redactSecrets(j('{{GH:ghp_', A36, '}}'), { standIns: true }), j('{{GH:ghp_', A36, '}}').replace(j('ghp_', A36), '<redacted:github_token>'));
  assert.throws(() => redactSecrets('x', { classes: ['nope'] }), TypeError);
});
