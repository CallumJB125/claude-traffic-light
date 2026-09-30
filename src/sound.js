// Sound playback and speech, extracted verbatim from main.js. A factory so the
// widget flash (playSound) can reach the live widget window without this module
// importing the window core.
const { shell } = require('electron');
const fs = require('fs');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';

module.exports = ({ getWin }) => {
  function playSound(name) {
    if (!name) return;
    getWin()?.webContents.send('sound-flash');
    if (name === 'beep') { shell.beep(); return; }
    if (IS_WIN) {
      if (!name.startsWith('file:')) { shell.beep(); return; }
      execFile('powershell', ['-NoProfile', '-c', `(New-Object Media.SoundPlayer '${name.slice(5).replace(/'/g, "''")}').PlaySync()`], () => {});
      return;
    }
    const file = name.startsWith('file:') ? name.slice(5) : `/System/Library/Sounds/${name}.aiff`;
    if (!fs.existsSync(file)) { shell.beep(); return; }
    execFile('afplay', [file], () => {});
  }

  function speak(text) {
    if (IS_WIN) execFile('powershell', ['-NoProfile', '-c', `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${String(text).replace(/'/g, "''")}')`], () => {});
    else execFile('say', [text], () => {});
  }

  return { playSound, speak };
};
