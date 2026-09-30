// Preload for local-auth.test.js: stands in for Electron's utilityProcess
// process.parentPort, relaying postMessage and inbound messages ({data}) over
// the test's IPC channel.
process.parentPort = {
  postMessage: (m) => process.send(m),
  on: (event, fn) => { if (event === 'message') process.on('message', (data) => fn({ data })); },
};
