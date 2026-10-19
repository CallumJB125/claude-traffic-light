'use strict';
// JS provider fixtures are real child processes, but a .js shebang is not an
// executable on Windows. Use the test runner's Node without a shell and keep
// the adapter's exact arguments, environment and process options intact.
const { spawn } = require('node:child_process');

function spawnProviderFixture(fixture, args, options) {
  return spawn(process.execPath, [fixture, ...args], options);
}

module.exports = { spawnProviderFixture };
