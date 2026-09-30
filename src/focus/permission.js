// macOS asks for Automation permission the first time Claude Buddy scripts a
// terminal. That prompt names the app but not the reason, so the first time
// an adapter that needs it actually runs, a notification says why. Never up
// front: someone who only uses kitty is never asked about iTerm2.
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';

// `load()` → apps already explained; `save(list)`; `notify({ title, body, onClick })`.
function createExplainer({ load, save, notify, openSettings }) {
  let explained = null;
  const deniedShown = new Set();
  const known = () => {
    if (!explained) {
      let list = [];
      try { list = load() || []; } catch { list = []; }
      explained = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
    }
    return explained;
  };
  return {
    onNeeds(needs) {
      if (!needs || needs.permission !== 'automation' || known().has(needs.app)) return null;
      known().add(needs.app);
      try { save([...known()]); } catch { /* shown again next launch: harmless */ }
      notify({ title: `Claude Buddy will ask to control ${needs.app}`, body: `That's ${needs.reason}. macOS asks once; choose OK to allow it.` });
      return { patient: true };
    },
    // Once per app per run: a refused permission would otherwise nag on every click.
    onDenied(needs) {
      if (!needs || deniedShown.has(needs.app)) return;
      deniedShown.add(needs.app);
      notify({
        title: `Can't switch to the exact ${needs.app} tab`,
        body: 'Claude Buddy isn\'t allowed to control it. Click to open Privacy & Security › Automation and turn it on.',
        onClick: openSettings,
      });
    },
  };
}

module.exports = { createExplainer, SETTINGS_URL };
