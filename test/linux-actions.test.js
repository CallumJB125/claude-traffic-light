const test = require('node:test');
const assert = require('node:assert/strict');
const LinuxActions = require('../src/linux-actions.js');

test('linux actions: macOS editor names become their Linux commands; anything else is the command', () => {
  assert.equal(LinuxActions.editorCommand(undefined), 'code');
  assert.equal(LinuxActions.editorCommand('Visual Studio Code'), 'code');
  assert.equal(LinuxActions.editorCommand('Cursor'), 'cursor');
  assert.equal(LinuxActions.editorCommand('Sublime Text'), 'subl');
  assert.equal(LinuxActions.editorCommand('nvim-qt'), 'nvim-qt');
});

test('linux actions: the shell action uses $SHELL when it is an absolute path, else /bin/sh', () => {
  assert.equal(LinuxActions.userShell({ SHELL: '/usr/bin/fish' }), '/usr/bin/fish');
  assert.equal(LinuxActions.userShell({ SHELL: 'bash' }), '/bin/sh');
  assert.equal(LinuxActions.userShell({}), '/bin/sh');
});
