// Windows and Linux spellcheck with Hunspell dictionaries that Chromium
// downloads from Google on first use: a network call the app never asks
// about. Spellcheck goes off on every session, the default one and each
// partition (the Buddy window's board, persist:board-*), and the download URL
// points at a closed local port so nothing is fetched even if a window turns
// it back on. macOS uses the OS spellchecker, downloads nothing, and is left
// alone.
const NOWHERE = 'http://127.0.0.1:9/';

function keepOffline({ app, getDefaultSession, platform = process.platform }) {
  if (platform === 'darwin') return false;
  const off = (ses) => {
    try {
      ses.setSpellCheckerEnabled(false);
      ses.setSpellCheckerDictionaryDownloadURL(NOWHERE);
    } catch (err) { console.warn('[spellcheck] could not turn off:', err.message); }
  };
  app.on('session-created', off);
  app.whenReady().then(() => off(getDefaultSession()));
  return true;
}

module.exports = { keepOffline, NOWHERE };
