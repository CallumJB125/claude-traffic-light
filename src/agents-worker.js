// Worker thread for the agent scan (see src/agents-sync.js for why).
const { parentPort, workerData } = require('worker_threads');
const Agents = require('../agents.js');
const SessionState = require('../hooks/session-state.js');
const { syncAgentFiles, writeMergedSession } = require('./agents-sync.js');

parentPort.on('message', () => {
  let wrote = 0;
  let error = null;
  try {
    wrote = syncAgentFiles({ sessionsDir: workerData.sessionsDir, Agents, writeMerged: (file, obj, readAt) => writeMergedSession(SessionState, file, obj, readAt) });
  } catch (err) {
    error = err.message;
  }
  parentPort.postMessage({ type: 'scanned', wrote, error });
});
