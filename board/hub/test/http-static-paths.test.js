// Adapt the held D107 acceptance to every current production page. Raw HTTP
// requests preserve escapes and dot segments that fetch would normalize.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHub } from './helpers.js';
import { startAccounts } from './accounts-helpers.js';
import * as http from '../http.js';
import { createLogger } from '../log.js';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const get = (base, path, headers = {}, method = 'GET') => new Promise((done, reject) => {
  const url = new URL(base);
  const req = request({ hostname: url.hostname, port: url.port, path, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

test('raw malformed path encoding is400 on HTTP and WS before authentication; hub remains healthy', async () => {
  const h = await startHub();
  try {
    for (const path of ['/web/%zz', '/web/js/%E0%A4%A', '/api/boards/%zz', '/api/%c0', '/shared/%', '/integrations/x/callback%zz']) {
      const out = await get(h.base, path);
      assert.equal(out.status, 400, path);
      assert.deepEqual(JSON.parse(out.text), { error: { code: 'VALIDATION', message: 'bad request path' } });
    }
    const upgrade = await get(h.base, '/ws/%zz', { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' });
    assert.equal(upgrade.status, 400);
    assert.equal((await get(h.base, '/api/health')).status, 200);
  } finally { await h.destroy(); }
});

test('development files, encoded aliases, case aliases and raw traversal never become static assets', async () => {
  const h = await startHub({ config: { webDir: WEB } });
  try {
    const excluded = [
      '/web/mock/server.js', '/web/mock/fixtures.js', '/web/test/fixtures.js', '/web/test/chips.test.js', '/web/scripts/shots.mjs',
      '/web/.env', '/web/js/.env', '/web/js/app.js.map', '/web/app.js', '/web/nope.html', '/web/APP.CSS', '/web/Index.html', '/web/JS/app.js', '/web/js/APP.js',
      '/web/js/../test/chips.test.js', '/web/test/../js/app.js', '/web/js/../app.css', '/web/js//app.js', '/web//app.css', '/web/js/app.js/',
      '/web/js%2fapp.js', '/web/js/app%2ejs', '/web/app%2Ecss', '/web/js/a%00.js', '/web/..%2fhub/http.js', '/web/%2e%2e/hub/http.js',
      '/shared/migrate.js', '/shared/schema.sql', '/shared/test/states.test.js', '/hub/http.js',
    ];
    for (const path of excluded) {
      const out = await get(h.base, path);
      assert.equal(out.status, 404, path);
      assert.deepEqual(JSON.parse(out.text), { error: { code: 'NOT_FOUND', message: 'not found' } }, path);
    }
  } finally { await h.destroy(); }
});

test('every current page and recursively imported production module loads with security headers', async () => {
  const h = await startAccounts({ config: { webDir: WEB, signinMethods: ['google'] } });
  try {
    const pages = [
      ['index.html', '/'], ['signin.html', '/signin'], ['invite.html', '/invite'], ['signin.html', '/auth/email'],
      ['clients.html', '/clients'], ['client-invite.html', '/client-invite'], ['remote-consent.html', '/remote-consent'], ['remote-grants.html', '/connections'],
    ];
    for (const [page, route] of pages) {
      assert.equal((await get(h.base, route)).status, 200, route);
      const seen = new Set(), pending = [];
      const visit = (path, from) => {
        const url = new URL(path, `http://hub${from}`);
        if (url.origin !== 'http://hub') return;
        if (!seen.has(url.pathname)) { seen.add(url.pathname); pending.push(url.pathname); }
      };
      for (const match of readFileSync(join(WEB, page), 'utf8').matchAll(/(?:src|href)="([^"#]+)"/g)) {
        if (/^\/(web|shared)\//.test(match[1])) visit(match[1], '/');
      }
      assert.ok(seen.size >= 3, page);
      while (pending.length) {
        const path = pending.pop(), out = await get(h.base, path);
        assert.equal(out.status, 200, `${page} requires ${path}`);
        assert.equal(out.headers['x-content-type-options'], 'nosniff');
        assert.match(out.headers['content-security-policy'], /script-src 'self'/);
        if (path.endsWith('.js')) {
          assert.match(out.headers['content-type'], /text\/javascript/);
          for (const match of out.text.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) visit(match[1], path);
        }
      }
    }
    for (const file of readdirSync(join(WEB, 'js'))) assert.equal((await get(h.base, `/web/js/${file}`)).status, 200, file);
    const head = await get(h.base, '/web/remote.css', {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    const first = await get(h.base, '/web/clients.css');
    const cached = await get(h.base, '/web/clients.css', { 'if-none-match': first.headers.etag });
    assert.equal(cached.status, 304);
  } finally { await h.close(); }
});

test('failed request log path removes control characters and limits caller text', async () => {
  assert.equal(http.logPath('/a\r\nINJECTED\u0000\u001b[31m\u007f/b'), '/aINJECTED[31m/b');
  assert.equal(http.logPath(undefined), '');
  assert.equal(http.logPath('/a' + 'b'.repeat(500)).length, 100);
  const lines = [];
  const h = await startHub({ log: createLogger({ level: 'debug', sink: (line) => lines.push(line) }) });
  try {
    const alice = await h.login('alice');
    h.hub.activeMember = () => { throw new Error('synthetic failure'); };
    assert.equal((await get(h.base, '/api/boards/' + 'x'.repeat(400) + '%0d%0aTAIL', { cookie: alice })).status, 500);
    const record = lines.map((line) => JSON.parse(line)).find((line) => line.msg === 'http handler failed');
    assert.ok(record);
    assert.ok(record.path.length <= 100);
    assert.ok(!/[\p{C}\u2028\u2029]/u.test(record.path));
    assert.ok(!lines.join('').includes('TAIL'));
  } finally { await h.destroy(); }
});
