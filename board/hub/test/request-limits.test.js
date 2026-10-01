// Request limits (CONTRACT D105): server header/request timeouts, the API body
// deadline, the 64 KiB cap off card routes, and authentication before any
// body is read. Short deadlines are injected through config.requestLimits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { startHub } from './helpers.js';
import { startAccounts } from './accounts-helpers.js';
import { REQUEST_LIMITS } from '../http.js';

const KIB = 1024;

// A raw HTTP/1.1 exchange: writes `head` (and `body`, if any), then collects
// until the server closes or `waitMs` passes. `trickle` writes one more header
// line every `everyMs` (slowloris).
function raw(base, head, { body = null, waitMs = 3000, trickle = null } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = connect(Number(port), hostname);
    let data = '';
    let firstAt = null;
    let timer = null;
    let tick = null;
    const done = (closed) => {
      clearTimeout(timer);
      clearInterval(tick);
      sock.destroy();
      const status = /^HTTP\/1\.1 (\d{3})/.exec(data)?.[1];
      resolve({ status: status ? Number(status) : null, text: data, closed, elapsed: Date.now() - t0, firstAt });
    };
    sock.on('data', (c) => { if (firstAt == null) firstAt = Date.now() - t0; data += c.toString('latin1'); });
    sock.on('close', () => done(true));
    sock.on('error', () => {});
    sock.on('connect', () => {
      sock.write(head);
      if (body != null) sock.write(body);
      if (trickle) tick = setInterval(() => { if (!sock.destroyed) sock.write(trickle.line); }, trickle.everyMs);
    });
    timer = setTimeout(() => done(false), waitMs);
  });
}

const reqHead = (base, method, path, headers = {}) => {
  const host = new URL(base).host;
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  return `${lines.join('\r\n')}\r\n\r\n`;
};

// Server-side bytes read on the socket of each request, when its answer finished.
function bytesAtAnswer(app) {
  const seen = [];
  app.server.on('request', (req, res) => res.once('finish', () => seen.push(req.socket.bytesRead)));
  return seen;
}

test('the server: request 30 s, headers 15 s, keep-alive 5 s by default', async () => {
  const h = await startHub();
  try {
    assert.equal(REQUEST_LIMITS.requestTimeoutMs, 30_000);
    assert.equal(REQUEST_LIMITS.headersTimeoutMs, 15_000);
    assert.equal(h.app.server.requestTimeout, 30_000);
    assert.equal(h.app.server.headersTimeout, 15_000);
    assert.equal(h.app.server.keepAliveTimeout, 5_000);
    assert.equal(REQUEST_LIMITS.smallBodyMax, 64 * KIB);
    assert.ok(REQUEST_LIMITS.bodyDeadlineMs > 0 && REQUEST_LIMITS.bodyDeadlineMs < REQUEST_LIMITS.requestTimeoutMs);
  } finally { await h.close(); }
});

test('slowloris: a header trickle is cut at the headers deadline', async () => {
  const h = await startHub({ config: { requestLimits: { headersTimeoutMs: 300, requestTimeoutMs: 600, checkIntervalMs: 50 } } });
  try {
    const host = new URL(h.base).host;
    const r = await raw(h.base, `GET /api/health HTTP/1.1\r\nHost: ${host}\r\n`, { trickle: { line: 'X-Slow: 1\r\n', everyMs: 100 }, waitMs: 4000 });
    assert.ok(r.closed, 'the server closed the connection');
    assert.ok(r.elapsed < 2000, `cut after ${r.elapsed} ms`);
    if (r.status != null) assert.equal(r.status, 408);
  } finally { await h.close(); }
});

test('slowloris: a body that never finishes is cut at the request deadline', async () => {
  const h = await startHub({ config: { requestLimits: { headersTimeoutMs: 300, requestTimeoutMs: 600, checkIntervalMs: 50, bodyDeadlineMs: 60_000 } } });
  try {
    const head = reqHead(h.base, 'POST', '/api/dev/login', { 'content-type': 'application/json', 'content-length': '100' });
    const r = await raw(h.base, head, { body: '{"github', trickle: { line: ' ', everyMs: 100 }, waitMs: 4000 });
    assert.ok(r.closed, 'the server closed the connection');
    assert.ok(r.elapsed < 2500, `cut after ${r.elapsed} ms`);
  } finally { await h.close(); }
});

test('slow body: an API body not received by the body deadline is 408 TIMEOUT and the socket closes', async () => {
  const h = await startHub({ config: { requestLimits: { bodyDeadlineMs: 300 } } });
  try {
    const head = reqHead(h.base, 'POST', '/api/dev/login', { 'content-type': 'application/json', 'content-length': '100' });
    const r = await raw(h.base, head, { body: '{"github_lo', waitMs: 4000 });
    assert.equal(r.status, 408, r.text);
    assert.match(r.text, /"code":"TIMEOUT"/);
    assert.ok(r.firstAt < 1500, `answered after ${r.firstAt} ms`);
    assert.ok(r.closed, 'and the connection is closed');
  } finally { await h.close(); }
});

test('off card routes the body cap is 64 KiB: a larger declared body is 413 before a byte of it is read; chunked is cut at 64 KiB', async () => {
  const h = await startHub();
  const seen = bytesAtAnswer(h.app);
  try {
    const head = reqHead(h.base, 'POST', '/api/dev/login', { 'content-type': 'application/json', 'content-length': String(64 * KIB + 1) });
    const r = await raw(h.base, head, { waitMs: 3000 });
    assert.equal(r.status, 413, r.text);
    assert.match(r.text, /PAYLOAD_TOO_LARGE/);
    assert.ok(seen.at(-1) < 4 * KIB, `read ${seen.at(-1)} bytes`);

    const big = JSON.stringify({ github_login: 'x'.repeat(70 * KIB) });
    const chunked = reqHead(h.base, 'POST', '/api/dev/login', { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
    const c = await raw(h.base, chunked, { body: `${big.length.toString(16)}\r\n${big}\r\n0\r\n\r\n`, waitMs: 3000 });
    assert.equal(c.status, 413, c.text);

    // At the cap is fine (the route then answers on its own terms).
    const fits = JSON.stringify({ github_login: 'nobody', pad: 'y'.repeat(64 * KIB - 40) });
    assert.ok(Buffer.byteLength(fits) <= 64 * KIB);
    const ok = await fetch(`${h.base}/api/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...h.devHeaders }, body: fits });
    assert.notEqual(ok.status, 413);
  } finally { await h.close(); }
});

test('unauthenticated: a big body to a member route is refused before it is read (dev auth and accounts user routes)', async () => {
  const h = await startHub();
  const seen = bytesAtAnswer(h.app);
  try {
    const head = reqHead(h.base, 'POST', `/api/boards/${h.ids.board}/cards`, { 'content-type': 'application/json', 'content-length': String(900 * KIB) });
    const r = await raw(h.base, head, { waitMs: 3000 });
    assert.equal(r.status, 401, r.text);
    assert.ok(r.firstAt < 1500);
    assert.ok(seen.at(-1) < 4 * KIB, `read ${seen.at(-1)} bytes`);
  } finally { await h.close(); }

  const a = await startAccounts();
  const seenA = bytesAtAnswer(a.app);
  try {
    for (const path of ['/api/teams', `/api/teams/${a.ids.org}/boards`, `/api/boards/${a.ids.board}/cards`]) {
      const head = reqHead(a.base, 'POST', path, { 'content-type': 'application/json', 'content-length': String(900 * KIB) });
      const r = await raw(a.base, head, { waitMs: 3000 });
      assert.equal(r.status, 401, `${path}: ${r.text}`);
      assert.ok(seenA.at(-1) < 4 * KIB, `${path}: read ${seenA.at(-1)} bytes`);
    }
  } finally { await a.close(); }
});

test('card routes keep the 1 MiB cap; other authenticated routes are capped at 64 KiB', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const pad = (n) => 'z'.repeat(n);
    const card = await h.api(alice, 'POST', `/api/boards/${h.ids.board}/cards`, { request_id: randomUUID(), title: 'Big', repo_id: h.ids.repo, pad: pad(900 * KIB) });
    assert.notEqual(card.status, 413, 'a card create under 1 MiB is read');
    const { id } = await h.createCard(alice);
    const c = await h.api(alice, 'POST', `/api/cards/${id}/comments`, { request_id: randomUUID(), body: 'hi', pad: pad(900 * KIB) });
    assert.notEqual(c.status, 413, 'a card comment under 1 MiB is read');
    const over = await h.api(alice, 'POST', `/api/cards/${id}/comments`, { request_id: randomUUID(), body: 'hi', pad: pad(1024 * KIB + 1) });
    assert.equal(over.status, 413);
    const label = await h.api(alice, 'POST', `/api/boards/${h.ids.board}/labels`, { request_id: randomUUID(), name: 'x', pad: pad(100 * KIB) });
    assert.equal(label.status, 413, 'a label is not a card route');
  } finally { await h.close(); }
});

// One raw keep-alive connection: write, wait for N answers (or the close), write again.
function conn(base) {
  const { hostname, port } = new URL(base);
  const sock = connect(Number(port), hostname);
  const st = { data: '', closed: false };
  sock.on('data', (c) => { st.data += c.toString('latin1'); });
  sock.on('close', () => { st.closed = true; });
  sock.on('error', () => {});
  const ready = new Promise((r) => sock.once('connect', r));
  const answers = () => (st.data.match(/^HTTP\/1\.1 \d{3}/gm) ?? []).length;
  const until = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return pred();
  };
  return { sock, st, ready, answers, until, write: (s) => { if (!sock.destroyed) sock.write(s); }, end: () => sock.destroy() };
}

test('an early answer to a request whose body is unread says Connection: close, and nothing else is served on that socket', async () => {
  const h = await startHub();
  try {
    const c = conn(h.base);
    await c.ready;
    // Half the declared body, then a 401 (auth comes before the body, D105).
    c.write(reqHead(h.base, 'POST', `/api/boards/${h.ids.board}/cards`, { 'content-type': 'application/json', 'content-length': '200000' }));
    c.write('{"title":"');
    assert.ok(await c.until(() => c.answers() === 1), c.st.data);
    assert.match(c.st.data, /^HTTP\/1\.1 401/);
    assert.match(c.st.data, /\r\nconnection: close\r\n/i);
    // A proxy that reused this socket anyway: its next request is never half-served.
    c.write(`${'x'.repeat(100)}${reqHead(h.base, 'GET', '/api/health')}`);
    assert.ok(await c.until(() => c.st.closed), 'the server closes the connection');
    assert.equal(c.answers(), 1, 'one answer only');
    c.end();
  } finally { await h.close(); }
});

test('a webhook early answer (body too large) says Connection: close too', async () => {
  const h = await startHub();
  try {
    const c = conn(h.base);
    await c.ready;
    c.write(reqHead(h.base, 'POST', `/integrations/${randomUUID()}/webhook`, { 'content-type': 'application/json', 'content-length': String(2 * 1024 * KIB) }));
    c.write('{"a":');
    assert.ok(await c.until(() => c.answers() === 1), c.st.data);
    assert.match(c.st.data, /^HTTP\/1\.1 413/);
    assert.match(c.st.data, /\r\nconnection: close\r\n/i);
    assert.ok(await c.until(() => c.st.closed), 'closed');
    c.end();
  } finally { await h.close(); }
});

test('a request whose body was read (or that has none) keeps its keep-alive connection past the 1 s cut', async () => {
  const h = await startHub();
  try {
    const c = conn(h.base);
    await c.ready;
    const body = '{"github_login":';
    c.write(`${reqHead(h.base, 'POST', '/api/dev/login', { 'content-type': 'application/json', 'content-length': String(body.length), ...h.devHeaders })}${body}`);
    assert.ok(await c.until(() => c.answers() === 1), c.st.data);
    assert.match(c.st.data, /^HTTP\/1\.1 400/, 'refused after the body was read');
    assert.doesNotMatch(c.st.data, /connection: close/i);
    // No body: an answer written before the parser saw the end is still a whole request.
    c.write(reqHead(h.base, 'GET', `/api/boards/${h.ids.board}`));
    assert.ok(await c.until(() => c.answers() === 2), c.st.data);
    assert.doesNotMatch(c.st.data, /connection: close/i);
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(c.st.closed, false, 'still open after the cut delay');
    c.write(reqHead(h.base, 'GET', '/api/health'));
    assert.ok(await c.until(() => c.answers() === 3), 'and serves the next request');
    assert.match(c.st.data.slice(c.st.data.lastIndexOf('HTTP/1.1')), /^HTTP\/1\.1 200/);
    c.end();
  } finally { await h.close(); }
});
