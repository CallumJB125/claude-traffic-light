// Preload for local-auth.test.js: stands in for Electron's utilityProcess
// process.parentPort, relaying postMessage over the test's IPC channel.
process.parentPort = { postMessage: (m) => process.send(m) };
