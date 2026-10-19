const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
test('user-facing pages and messages say Plexiform, not the old Buddy name', () => {
  for (const f of ['help.html', 'help.js', 'settings.html', 'settings.js', 'lights.html', 'src/health.js', 'src/voice-helper.js', 'board/hub/integrations/registry.js']) {
    const bad = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l) && /\bBuddy\b/.test(l));
    assert.deepEqual(bad, [], `${f} still shows "Buddy" to users`);
  }
});
