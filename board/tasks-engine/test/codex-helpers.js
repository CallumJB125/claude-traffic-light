// Real engine/socket/Codex adapter. The CLI is a local subscription-free fixture.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBackend } from '../../runner/backends/codex.js';
import { tmpDir, rm, makeRepo, startEngine } from './helpers.js';

const fixture = fileURLToPath(new URL('../../runner/test/fixtures/fake-codex.js', import.meta.url));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
export async function startCodexFixture(scenario, extra = {}) {
  const dir = tmpDir('pxct-'), repo = makeRepo(dir);
  const scenarioFile = path.join(dir, 'scenario.json'), log = path.join(dir, 'codex.log'), bin = path.join(dir, 'codex');
  const setScenario = (s) => fs.writeFileSync(scenarioFile, JSON.stringify(s));
  setScenario(scenario);
  fs.writeFileSync(bin, `#!/bin/sh\nexport PLEXIFORM_FAKE_CODEX_SCENARIO=${quote(scenarioFile)}\nexport PLEXIFORM_FAKE_CODEX_LOG=${quote(log)}\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 });
  class FakeCodex extends CodexBackend { static async detect() { return { id: 'codex', installed: true, version: '0.159.2', signedIn: true, bin }; } }
  class ForbiddenClaude { static async detect() { throw new Error('Claude was invoked'); } }
  const engineOpts = { backends: { codex: FakeCodex, claude: ForbiddenClaude }, enabledAis: ['codex'], defaultAi: 'codex', ...extra };
  let h = await startEngine({ dir, engineOpts });
  return {
    dir, repo, setScenario,
    get eng() { return h.eng; }, get client() { return h.client; }, get dataDir() { return h.dataDir; },
    log: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } },
    task: (id) => h.eng.tasks.get(id),
    async restart({ beforeStart, ...opts } = {}) { await h.close(opts); await beforeStart?.(h); h = await startEngine({ dir, engineOpts }); },
    async cleanup() { await h.close(); rm(dir); },
  };
}
