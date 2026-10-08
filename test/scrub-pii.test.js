'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maskPii, redactSecretsPass, scrub } = require('../src/scrub.js');

// Cases mirror Claude Burst's automask test (docs/design/automask.md): valid values masked, lookalikes kept.
const IN = [
  'card 4111 1111 1111 1111 and amex 378282246310005',
  'not a card 1234567812345678',
  'SA ID 8001015009087, not 8013015009087',
  'SSN 123-45-6789, not 000-12-3456',
  'NI AB123456C, not GB123456A',
  'IBAN GB82WEST12345698765432, not GB00WEST12345698765432',
  'MRZ L898902C36UTO7408122F1204159',
  'mail a@b.com and phone +27821234567 stay',
].join('\n');

test('valid personal numbers are masked and lookalikes kept', () => {
  const out = maskPii(IN);
  for (const want of ['[card] and amex [card]', '1234567812345678', '[sa-id], not 8013015009087', '[ssn], not 000-12-3456', '[nino], not GB123456A', '[iban], not GB00WEST12345698765432', 'MRZ [passport]', 'a@b.com', '+27821234567']) assert.ok(out.includes(want), `${want} in:\n${out}`);
  for (const gone of ['4111 1111', '8001015009087', '123-45-6789', 'AB123456C', 'GB82WEST', 'L898902C36']) assert.ok(!out.includes(gone), gone);
});

test('check digits matter: a changed digit keeps the value', () => {
  assert.equal(maskPii('4111 1111 1111 1112'), '4111 1111 1111 1112');
  assert.equal(maskPii('GB82WEST12345698765433'), 'GB82WEST12345698765433');
  assert.equal(maskPii('L898902C37UTO7408122F1204159'), 'L898902C37UTO7408122F1204159');
  assert.equal(maskPii('8001015009088'), '8001015009088');
  assert.equal(maskPii('666-12-3456 and 900-12-3456'), '666-12-3456 and 900-12-3456');
  assert.equal(maskPii('NINO ZZ123456A'), 'NINO ZZ123456A');
});

test('a grouped IBAN is masked, and a UUID or hash is left alone', () => {
  assert.equal(maskPii('pay GB82 WEST 1234 5698 7654 32 today'), 'pay [iban] today');
  assert.equal(maskPii('id 123e4567-e89b-12d3-a456-426614174000'), 'id 123e4567-e89b-12d3-a456-426614174000');
});

test('the outbound scrubs apply it', () => {
  assert.equal(redactSecretsPass('card 4111111111111111'), 'card [card]');
  assert.match(scrub('card 4111111111111111'), /card \[card\]/);
});

test('a long run of digits is read in linear time', () => {
  const t = Date.now();
  maskPii('1 '.repeat(50000) + '-'.repeat(50000) + '4'.repeat(100000));
  assert.ok(Date.now() - t < 2000);
});
