'use strict';
// The agent bus through the app's real pieces, minus Electron: the signal
// server's /bus relay → tasks-service → the real tasks engine (temp dirs,
// fake Codex CLI) → bus.db → dispatcher. mcp-server's bus_* tools call in.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createTasksService } = require('../../src/tasks-service.js');
const { testTempDir } = require('./tmp');

const board = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'board', f)).href;
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

async function startAppBus(scenario = { text: 'Done' }, { ensureSupervisor } = {}) {
  const { startBus } = await import(board('tasks-engine/test/bus-helpers.js'));
  const b = await startBus(scenario);
  const svc = createTasksService({ boardHome: b.h.dataDir, homeDir: '/Users/nobody', ensureSupervisor, copy: () => {}, confirmDialog: async () => { throw new Error('a dialog was shown'); } });
  const rootDir = testTempDir('ctl-bus-');
  const S = require('../../src/signal-server.js')({ rootDir, sessionsDir: rootDir, requestsDir: rootDir, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port: 0, app: { on: () => {} },
    agentBus: (op, args, caller) => svc.bus(op, args, caller) });
  const server = S.startSignalServer();
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  await until(() => fs.existsSync(path.join(rootDir, 'token')));
  const M = require('../../mcp-server.js');
  const tool = (name, args) => M.TOOLS.find((t) => t.name === name).run(args, { root: rootDir, port });
  return {
    b, svc, server, port, rootDir, tool, M,
    async cleanup() { svc.stop(); await new Promise((r) => server.close(r)); fs.rmSync(rootDir, { recursive: true, force: true }); await b.cleanup(); },
  };
}

module.exports = { startAppBus, until, board };
