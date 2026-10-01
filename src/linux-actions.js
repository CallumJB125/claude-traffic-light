// Linux forms of the widget's click actions. The editor action stores a macOS
// app name ("Visual Studio Code", for `open -a`); Linux launches editors by
// their command, so known names map to it and anything else is taken as the
// command itself.
const EDITOR_COMMANDS = {
  'visual studio code': 'code',
  'visual studio code - insiders': 'code-insiders',
  vscodium: 'codium',
  cursor: 'cursor',
  windsurf: 'windsurf',
  zed: 'zed',
  'sublime text': 'subl',
  'intellij idea': 'idea',
  webstorm: 'webstorm',
  pycharm: 'pycharm',
};

function editorCommand(arg) {
  const name = String(arg || 'Visual Studio Code').trim();
  return EDITOR_COMMANDS[name.toLowerCase()] || name;
}

// The user's own shell for the 'shell' action (macOS keeps /bin/zsh).
const userShell = (env = process.env) => (env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/sh');

module.exports = { editorCommand, userShell, EDITOR_COMMANDS };
