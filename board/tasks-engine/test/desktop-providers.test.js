import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopProviders } from '../desktop-providers.js';
import { ClaudeBackend } from '../../runner/backends/claude.js';
test('desktop provider policy matches Claude sandbox support and keeps Codex default', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const policy = desktopProviders(platform);
    assert.equal(policy.defaultAi, 'codex');
    assert.equal(policy.enabledAis.includes('claude'), ClaudeBackend.describe(platform).startable);
    assert.ok(policy.enabledAis.includes('codex'));
  }
});
