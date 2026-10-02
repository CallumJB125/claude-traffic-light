#!/usr/bin/env node
'use strict';
// One real proof of the codex-daemon adapter (board/CODEX-DAEMON.md).
// A HUMAN runs this after starting a Codex CLI session in Terminal with
// `codex` (which attaches to the shared daemon). It never starts the daemon.
//
//   node scripts/codex-daemon-proof.js            list sessions on the daemon (titles/folders only)
//   node scripts/codex-daemon-proof.js --send N   send ONE tiny message to session N, print ack/echo/reply, detach
//
// Prints no thread ids and nothing from the session's conversation.
const { createInteractionHub } = require('../src/session-interaction');
const { createCodexDaemon } = require('../src/codex-daemon');
const { findCodexBin } = require('../src/codex-app-server');

const ACTOR = 'proof';
const TEXT = 'Plexiform daemon proof: reply with just the word OK.';

(async () => {
  const pick = process.argv.indexOf('--send') > 0 ? Number(process.argv[process.argv.indexOf('--send') + 1]) : null;
  // Running this script by hand is the opt-in for this one run.
  const adapter = createCodexDaemon({ bin: findCodexBin(), enabled: () => true });
  if (!adapter.available) { console.log(adapter.reason); process.exit(2); }
  const hub = createInteractionHub({ adapters: { 'codex-daemon': adapter }, boardCurrent: (b) => b === null });
  try {
    const found = await hub.discover({ provider: 'codex-daemon' }, ACTOR);
    if (!found.ok) throw new Error(found.error);
    found.threads.forEach((t, i) => console.log(`${i + 1}. ${t.title || 'Untitled session'} · ${t.project} · ${t.status}`));
    if (!found.threads.length) console.log('No Codex CLI sessions are loaded on the shared daemon. Start one with `codex` in Terminal.');
    if (pick === null) return;
    const t = found.threads[pick - 1];
    if (!t) throw new Error('No such session number.');
    const at = await hub.attach({ provider: 'codex-daemon', handle: t.handle, board: null }, ACTOR);
    if (!at.ok) throw new Error(`attach refused: ${at.status} ${at.error}`);
    console.log(`attached: ${at.state.label}`);
    const sent = await hub.send({ session: at.state.session, generation: at.state.generation, text: TEXT }, ACTOR);
    console.log(`send: ${sent.status}${sent.ok ? '' : ` ${sent.error}`}`);
    if (!sent.ok) return;
    const end = Date.now() + 120_000;
    let d;
    while (Date.now() < end) {
      d = hub.state({ session: at.state.session }, ACTOR).deliveries.find((x) => x.id === sent.delivery.id);
      if (['completed', 'failed', 'interrupted'].includes(d.state)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(JSON.stringify({ state: d.state, acknowledged: true, recorded: d.recorded, response: d.response, notices: d.notices }, null, 2));
    await hub.close({ session: at.state.session, generation: at.state.generation }, ACTOR);
    console.log('detached (the Codex session keeps running).');
  } catch (e) { console.log(`proof failed: ${e.message}`); process.exitCode = 1; } finally { hub.stopAll(); }
})();
