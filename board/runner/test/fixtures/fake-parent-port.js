// Preload for app-entry.test.js (as hub/test/fixtures): stands in for Electron's utilityProcess
// process.parentPort, relaying postMessage and inbound messages ({data}) over
// the test's IPC channel.
process.parentPort = {
  postMessage: (m) => process.send(m),
  on: (event, fn) => { if (event === 'message') process.on('message', (data) => fn({ data })); },
};
