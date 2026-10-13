const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Agents = require('../agents');

test('Codex and other providers retain their hook roster without reading foreign state', () => {
  const original = fs.readFileSync;
  const reads = [];
  fs.readFileSync = file => { reads.push(file); throw new Error('foreign metadata read'); };
  try {
    for (const source of ['codex', 'cursor', 'gemini', 'custom']) {
      const agents = [{ id: 'child', name: 'worker', kind: 'subagent', status: 'working', source: 'hook' }];
      const found = Agents.scanAgents({ source, sessionId: 'parent', cwd: '/synthetic/project', agents });
      assert.deepEqual(found, { mode: null, iteration: 0, agents: [] });
      assert.deepEqual(Agents.mergeAgents(agents, found.agents), agents);
    }
    assert.deepEqual(reads, []);
  } finally { fs.readFileSync = original; }
});
