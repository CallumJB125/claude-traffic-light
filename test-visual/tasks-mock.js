// The Local Tasks API mock (board/tasks-api/mock-server.js) started in the
// spec's own process. The app is pointed at its folder with
// CLAUDE_TRAFFIC_LIGHT_TASKS_HOME (honoured only by an unpackaged dev run).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// Short base: AF_UNIX paths are capped at 104 bytes on macOS.
const shortTmp = () => fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'ptm-'));

async function startTasksMock({ dir = shortTmp(), speed = 40, demo = true } = {}) {
  const { startMockServer } = await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'mock-server.js')).href);
  const srv = await startMockServer({ dir, speed, demo, hbMs: 500 });
  return { dir, srv, close: async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

module.exports = { startTasksMock, shortTmp };
