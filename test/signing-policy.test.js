'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { policy } = require('../build/signing-policy');
test('unsigned local builds stay possible; explicitly signed builds fail closed', () => {
  assert.equal(policy({}, 'darwin').notarize, false);
  assert.throws(() => policy({ PLEXIFORM_REQUIRE_SIGNING: '1' }, 'darwin'), /Developer ID/);
  assert.throws(() => policy({ PLEXIFORM_REQUIRE_SIGNING: '1', CSC_NAME: '-' }, 'darwin'), /Developer ID/);
  assert.throws(() => policy({ PLEXIFORM_REQUIRE_SIGNING: '1' }, 'win32'), /certificate/);
  const signed = { PLEXIFORM_REQUIRE_SIGNING: '1', CSC_NAME: 'Developer ID Application: test', APPLE_API_KEY: 'test.p8', APPLE_API_KEY_ID: 'test', APPLE_API_ISSUER: 'test' };
  assert.equal(policy(signed, 'darwin').notarize, true);
  delete signed.APPLE_API_ISSUER;
  assert.throws(() => policy(signed, 'darwin'), /notarization credentials/);
});
