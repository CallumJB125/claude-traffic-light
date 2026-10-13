#!/usr/bin/env node
// Gemini CLI stream-json fixture. Never invokes a real AI CLI, model or network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const logFile = process.env.PLEXIFORM_FAKE_GEMINI_LOG ?? (process.env.GEMINI_CLI_HOME && path.join(process.env.GEMINI_CLI_HOME, '..', 'fake-gemini.log'));
const log = (x) => fs.appendFileSync(logFile, `${JSON.stringify(x)}\n`);
if (process.argv.includes('--version')) { console.log('0.12.0'); process.exit(0); }
const dir = path.join(process.env.GEMINI_CLI_HOME, '.gemini');
const cred = path.join(dir, 'oauth_creds.json');
log({ kind: 'start', argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.GEMINI_CLI_HOME,
  settings: JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), systemMd: process.env.GEMINI_SYSTEM_MD ?? null,
  cred: fs.existsSync(cred) ? fs.lstatSync(cred).isSymbolicLink() : null });
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
log({ kind: 'prompt', prompt });
const lines = fs.readFileSync(process.env.PLEXIFORM_FAKE_GEMINI_STREAM ?? fileURLToPath(new URL('./gemini-stream.jsonl', import.meta.url)), 'utf8').trim().split('\n');
for (const l of lines) process.stdout.write(`${l}\n`);
if (process.env.PLEXIFORM_FAKE_GEMINI_HANG) await new Promise((r) => setTimeout(r, 300000));
process.exit(JSON.parse(lines.at(-1)).status === 'success' ? 0 : 1);
