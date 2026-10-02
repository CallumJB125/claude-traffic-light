#!/usr/bin/env node
// Subscription-free adapter fixture. Never invokes a real AI CLI or network.
import fs from 'node:fs';
import path from 'node:path';
const scenario = JSON.parse(fs.readFileSync(process.env.PLEXIFORM_FAKE_CODEX_SCENARIO, 'utf8'));
const log = (x) => fs.appendFileSync(process.env.PLEXIFORM_FAKE_CODEX_LOG, `${JSON.stringify(x)}\n`);
if (process.argv.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
if (process.argv[2] === 'login') process.exit(0);
const emit = (x) => process.stdout.write(`${JSON.stringify(x)}\n`);
if (scenario.ignoreTerm) process.on('SIGTERM', () => {});
const session = '00000000-0000-4000-8000-000000000159';
log({ kind: 'start', argv: process.argv.slice(2), cwd: process.cwd(), env: process.env });
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
log({ kind: 'prompt', prompt });
emit({ type: 'thread.started', thread_id: session });
emit({ type: 'turn.started' });
if (scenario.wait && !(scenario.waitFirstOnly && process.argv.includes('resume'))) {
 emit({ type: 'item.started', item: { id: 'cmd_1', type: 'command_execution', command: 'sleep 300' } });
 await new Promise((r) => setTimeout(r, 300000));
}
if (scenario.write || (scenario.writeOnResume && process.argv.includes('resume'))) {
 fs.writeFileSync(path.join(process.cwd(), 'codex-result.txt'), 'fixture edit\n');
 emit({ type: 'item.completed', item: { id: 'file_1', type: 'file_change', status: 'completed', changes: [{ path: path.join(process.cwd(), 'codex-result.txt'), kind: 'add' }] } });
}
if (scenario.error) emit({ type: 'turn.failed', error: { message: scenario.error } });
else {
 emit({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: scenario.text ?? 'Finished' } });
 emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
}
