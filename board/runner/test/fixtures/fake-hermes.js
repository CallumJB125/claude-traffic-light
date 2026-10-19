#!/usr/bin/env node
// Hermes stream-json fixture. Never invokes a real AI CLI, model or network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The runner hands Hermes a minimal environment: without the test variables the
// log lands beside the per-run Hermes home and the default stream replays.
const logFile = process.env.PLEXIFORM_FAKE_HERMES_LOG ?? (process.env.HERMES_HOME && path.join(process.env.HERMES_HOME, '..', 'fake-hermes.log'));
const log = (x) => fs.appendFileSync(logFile, `${JSON.stringify(x)}\n`);
if (process.argv.includes('--version')) {
  // Real v0.21.3 makes a blocking GitHub update check here unless the home opts out.
  const cfg = process.env.HERMES_HOME ? path.join(process.env.HERMES_HOME, 'config.yaml') : null;
  if (!(cfg && fs.existsSync(cfg) && /check: false/.test(fs.readFileSync(cfg, 'utf8')))) await new Promise((r) => setTimeout(r, 5000));
  console.log('Hermes Agent v0.21.3 (fake)'); process.exit(0);
}
const home = process.env.HERMES_HOME;
log({ kind: 'start', argv: process.argv.slice(2), cwd: process.cwd(), home, config: JSON.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')), env: process.env.ENV_PROBE ?? null,
  dotenv: fs.existsSync(path.join(home, '.env')) ? fs.lstatSync(path.join(home, '.env')).isSymbolicLink() : null });
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
log({ kind: 'prompt', prompt });
const lines = fs.readFileSync(process.env.PLEXIFORM_FAKE_HERMES_STREAM ?? fileURLToPath(new URL('./hermes-stream.jsonl', import.meta.url)), 'utf8').trim().split('\n');
for (const l of lines) process.stdout.write(`${l}\n`);
if (process.env.PLEXIFORM_FAKE_HERMES_HANG) await new Promise((r) => setTimeout(r, 300000));
process.exit(JSON.parse(lines.at(-1)).exit_code ?? 0);
