// Brings the user's hatched characters into a renderer's registry. The main
// process validated them before they touched disk and again when it read them
// back; this only registers what it is handed, under the u- prefix the contract
// insists on. Runs in any window that draws the rig or lists characters.
(function () {
  const C = window.BuddyCharacters;
  const api = window.userCharacters;
  if (!C || !api || typeof api.list !== 'function') return;
  const ID = /^u-[a-z][a-z0-9-]{1,31}$/;
  let known = new Set();
  let latest = 0;
  function load() {
    const mine = (latest += 1);
    return Promise.resolve(api.list()).then((list) => {
      // two lists can be in flight (a change right after another); only the newest answer counts
      if (mine !== latest) return;
      const now = new Set();
      for (const ch of Array.isArray(list) ? list : []) {
        if (!ch || typeof ch.id !== 'string' || !ID.test(ch.id)) continue;
        try { C.register(ch); now.add(ch.id); } catch (e) { console.warn('character not registered:', ch.id, e && e.message); }
      }
      for (const id of known) if (!now.has(id)) { try { C.unregister(id); } catch { /* already gone */ } }
      known = now;
      window.dispatchEvent(new Event('user-characters'));
    }).catch(() => {});
  }
  load();
  if (typeof api.onChange === 'function') api.onChange(load);
})();
