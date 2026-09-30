// Sound playback and speech, extracted verbatim from main.js. A factory so the
// widget flash (playSound) can reach the live widget window without this module
// importing the window core.
const { shell } = require('electron');
const fs = require('fs');
const { execFile } = require('child_process');
const PowerShell = require('./powershell.js');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const LinuxAudio = require('./linux-audio.js');

module.exports = ({ getWin }) => {
  function playSound(name) {
    if (!name) return;
    getWin()?.webContents.send('sound-flash');
    if (name === 'beep') { shell.beep(); return; }
    if (IS_WIN) {
      if (!name.startsWith('file:')) { shell.beep(); return; }
      PowerShell.run(PowerShell.SCRIPTS.playSound, [name.slice(5)], {}, () => {}); // privacy-flow: local-sound
      return;
    }
    if (IS_LINUX) { LinuxAudio.play(name.startsWith('file:') ? name.slice(5) : null, { exists: fs.existsSync, onMissing: () => shell.beep() }); return; }
    const file = name.startsWith('file:') ? name.slice(5) : `/System/Library/Sounds/${name}.aiff`;
    if (!fs.existsSync(file)) { shell.beep(); return; }
    execFile('afplay', [file], () => {});
  }

  // done: called when the speech ends (the voice answers lip-sync to it).
  // Returns the child so a new question can cut an answer short.
  function speak(text, done = () => {}) {
    if (IS_WIN) return PowerShell.run(PowerShell.SCRIPTS.speak, [String(text)], {}, () => done()); // privacy-flow: local-sound
    if (IS_LINUX) return LinuxAudio.speak(text, done); // privacy-flow: local-sound
    // '--': a reply starting with '-' is words, never a `say` option.
    return execFile('say', ['--', String(text)], () => done());
  }

  return { playSound, speak };
};
