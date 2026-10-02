// Sentry slice S-A, the pure half: the scrub every free-text Sentry string
// goes through, the rebuilt issue link and the fixed card template (CONTRACT
// D42 addendum "the Sentry connector", Card text). The payloads here are
// hand-made, modelled on Sentry's docs; they are NOT recorded deliveries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, issueLink, cardText, SUGGESTION } from '../integrations/sentry/text.js';

const BIDI = ['\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\ufeff'];
const FORBIDDEN = /[<>`*[\]~|#\\()\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

test('scrub: control, format, bidi and line-separator characters are gone, whitespace is one space', () => {
  const s = scrub(`a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg\n\r\th${BIDI.join('')}i\u2028j\u2029k   l`, 200);
  assert.equal(s, 'abcdefg hi j k l');
  for (const ch of BIDI) assert.ok(!scrub(`x${ch}y`, 10).includes(ch));
});

test('scrub: no markdown or HTML survives (<, >, backtick, *, _, [, ], (, ), #, |, ~, \\), lookalikes folded first', () => {
  const s = scrub('<script>alert(1)</script> **bold** _it_ [x](javascript:alert(1)) `code` # h | t ~ s \\ e', 300);
  assert.doesNotMatch(s.replaceAll('[redacted]', ''), FORBIDDEN);
  assert.ok(!s.includes('_'));
  assert.doesNotMatch(s, /javascript/i);
  // Fullwidth and other compatibility forms fold under NFKC; the angle lookalikes go too.
  const l = scrub('\uff1cb\uff1e \u2039i\u203a \u02c2u\u02c3 \uff40x\uff40', 100);
  assert.doesNotMatch(l, /[<>`\u2039\u203a\u02c2\u02c3\uff1c\uff1e\uff40]/);
});

test('scrub: chat mentions, emails, URLs of any scheme, IPs, token-like and long digit runs become [redacted]', () => {
  const cases = [
    '<@U123ABC>', '<!channel>', '<!everyone>', '<!here|here>', '@channel', '@here', '@everyone', '@mallory',
    'someone@example.com', 'https://evil.example/x?y=1', 'http://10.0.0.1/', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'www.evil.example',
    '203.0.113.9', '2001:db8::1', 'fe80:0:0:0:0:0:0:1', 'abcdefghijklmnopqrstuvwx1234', '9001011234088', '123456789',
  ];
  for (const c of cases) {
    const s = scrub(`before ${c} after`, 200);
    assert.match(s, /^before \[redacted\] after$/, `${c} → ${s}`);
  }
  assert.equal(scrub('order 12345678 ok', 50), 'order 12345678 ok', 'eight digits stay');
});

test('scrub: caps on code points with ..., never splits a surrogate pair; non-strings are empty', () => {
  assert.equal(scrub('ab '.repeat(40), 10), 'ab ab a...');
  assert.equal(scrub('x'.repeat(100), 10), '[redacted]', 'one long run is token-like');
  const emoji = scrub('😀'.repeat(50), 10);
  assert.equal([...emoji].length, 10);
  assert.equal(emoji, `${'😀'.repeat(7)}...`);
  for (const v of [null, undefined, 7, {}, [], true]) assert.equal(scrub(v, 10), '');
  assert.equal(scrub('ok', 10), 'ok');
});

const ISSUE = (over = {}) => ({
  id: '1234567890', shortId: 'PYTHON-Y', title: 'TypeError: x is undefined', culprit: 'app/views.py in handler', level: 'error',
  project: { id: '4509', name: 'python', slug: 'python' }, type: 'error', issueCategory: 'error',
  metadata: { type: 'TypeError', value: 'x is undefined', filename: 'app/views.py', function: 'handler' },
  count: '3', userCount: 2, firstSeen: '2026-09-30T09:59:00.000000+00:00', web_url: 'https://example-org.sentry.io/issues/1234567890/',
  ...over,
});

test('issueLink: only a web_url on a Sentry host with this issue id, rebuilt from its parts', () => {
  assert.equal(issueLink(ISSUE()), 'https://example-org.sentry.io/issues/1234567890/');
  assert.equal(issueLink(ISSUE({ web_url: 'https://sentry.io/organizations/acme-co/issues/1234567890' })), 'https://sentry.io/organizations/acme-co/issues/1234567890/');
  assert.equal(issueLink(ISSUE({ web_url: 'https://de.sentry.io/issues/1234567890/' })), 'https://de.sentry.io/issues/1234567890/');
  const bad = [
    'http://example-org.sentry.io/issues/1234567890/', 'https://sentry.io.evil.example/issues/1234567890/', 'https://evil.example/issues/1234567890/',
    'https://example-org.sentry.io:8443/issues/1234567890/', 'https://u:p@example-org.sentry.io/issues/1234567890/', 'https://example-org.sentry.io/issues/1234567890/?x=1',
    'https://example-org.sentry.io/issues/1234567890/#frag', 'https://example-org.sentry.io/issues/999/', 'https://example-org.sentry.io/issues/1234567890/../../x',
    'javascript:alert(1)//https://sentry.io/issues/1234567890/', 'https://a.b.sentry.io/issues/1234567890/', 'https://EXAMPLE.sentry.io/organizations/ACME/issues/1234567890/',
    'https://sentry.io/organizations/acme_co/issues/1234567890/', `https://${'a'.repeat(51)}.sentry.io/issues/1234567890/`, 'https://sentry.io@evil.example/issues/1234567890/',
    'https://example-org.sentry.io/issues/1234567890/%2e%2e/', 'https://xn--80ak6aa92e.sentry.io/issues/1234567890/x', 42, null, { href: 'https://sentry.io/issues/1234567890/' },
  ];
  for (const u of bad) assert.equal(issueLink(ISSUE({ web_url: u })), null, String(u));
});

test('cardText: the fixed template from validated parts only; the message is off by default', () => {
  const { title, body } = cardText(ISSUE(), {});
  assert.equal(title, 'Sentry: TypeError in app/views.py in handler');
  assert.equal(body, [
    'Level: error', 'Project: python', 'Issue: PYTHON-Y', 'Events: 3', 'Users: 2', 'First seen: 2026-09-30T09:59:00.000Z',
    'Sentry: https://example-org.sentry.io/issues/1234567890/', '', SUGGESTION,
  ].join('\n'));
  assert.equal(SUGGESTION, 'Suggested: review this issue, choose an AI and start a fix from the card.');
  assert.doesNotMatch(`${title}\n${body}`, /x is undefined/);
  const m = cardText(ISSUE(), { includeMessage: true });
  assert.equal(m.title, 'Sentry: TypeError in app/views.py in handler : x is undefined');
});

test('cardText: a bad type is Error, bad level/shortId/counts/link lines are left out, every cap holds', () => {
  const { title, body } = cardText(ISSUE({
    metadata: { type: 'Type<Error>', value: 'v'.repeat(5000) }, level: 'critical<b>', shortId: 'lower-case', count: '-1', userCount: 1.5,
    web_url: 'https://evil.example/', culprit: 'c'.repeat(5000),
  }), { includeMessage: true });
  assert.ok(title.startsWith('Sentry: Error'), title);
  assert.ok([...title].length <= 120, title);
  assert.doesNotMatch(body, /Level|Issue:|Events|Users|Sentry:/);
  assert.ok(body.length <= 1500);
  assert.equal(cardText(ISSUE({ metadata: { type: 'A'.repeat(62) } }), {}).title.startsWith('Sentry: Error'), true, 'type over 61 chars');
  assert.equal(cardText(ISSUE({ metadata: null, culprit: '' }), {}).title, 'Sentry: Error');
});
