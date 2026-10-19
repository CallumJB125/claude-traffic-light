// Real engine and Claude/Codex adapters, controlled offline CLI fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBackend } from '../../runner/backends/codex.js';
import { startEngine, makeRepo, tmpDir, rm, fakeBackends, waitFor } from './helpers.js';
const fixture = fileURLToPath(new URL('../../runner/test/fixtures/fake-codex.js', import.meta.url));
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
export async function providerFixture(extra = {}) {
  const dir = tmpDir('pxsw-'), repo = makeRepo(dir), scenarioFile = path.join(dir, 'codex.json'), log = path.join(dir, 'codex.log'), bin = path.join(dir, 'codex');
  fs.writeFileSync(scenarioFile, JSON.stringify({ write: true, text: 'Received reviewed provider handover' }));
  fs.writeFileSync(bin, `#!/bin/sh\nexport PLEXIFORM_FAKE_CODEX_SCENARIO=${quote(scenarioFile)}\nexport PLEXIFORM_FAKE_CODEX_LOG=${quote(log)}\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 });
  const backends = fakeBackends(dir, { steps: [{ assistant: 'Preserve original contribution' }, { tool: 'Write', input: { file_path: 'original.txt', content: 'original contribution\n' } }, { tool: 'Bash', input: { command: 'sleep 300' }, ms: 60000 }] });
  class FakeCodex extends CodexBackend { static async detect() { return { id: 'codex', installed: true, version: '0.159.2', signedIn: true, bin }; } }
  backends.codex = FakeCodex;
  const h = await startEngine({ dir, engineOpts: { backends, ...extra } });
  return { ...h, repo, backends, task: id => h.eng.tasks.get(id),
    log: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } },
    async parked(spec = {}) {
      const { id } = await h.client.createTask({ text: 'Preserve original work and continue', cwd: repo.checkout, ai: 'claude', ...spec });
      await waitFor(() => h.eng.tasks.get(id)?.touched.includes('original.txt') && fs.existsSync(path.join(h.eng.tasks.get(id).worktree, 'original.txt')));
      await h.client.act(id, 'pause'); await waitFor(() => h.eng.tasks.get(id)?.state === 'parked');
      return id;
    },
    async cleanup() { await h.close(); rm(dir); },
  };
}
