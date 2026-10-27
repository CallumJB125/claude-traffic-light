// Settings → Git and CI → deploys (src/deploy-status-main.js). Its own saves:
// the toggle and tokens never pass through the page-wide config save, and a
// saved token is never read back, only whether one is saved.
(function () {
  const api = window.settingsApi;
  const box = document.getElementById('deploys');
  if (window.SettingsPanes && !window.SettingsPanes.inPane('projects')) return; // R8-1: another pane owns this block
  if (!box || !api || !api.deploySettings) return;
  const toggle = document.getElementById('deploySignals');
  const say = (text) => { document.getElementById('deploy-status').textContent = text; };
  const NAMES = { vercel: 'Vercel', netlify: 'Netlify', cloudflare: 'Cloudflare' };

  async function refresh() {
    const s = await api.deploySettings().catch(() => null);
    if (!s) return;
    toggle.checked = s.enabled !== false;
    for (const p of Object.keys(NAMES)) {
      const input = document.getElementById(`deploy-token-${p}`);
      input.value = '';
      input.placeholder = s.saved && s.saved[p] ? 'Saved in the keychain' : 'Not set: the CLI is used';
    }
  }
  toggle.addEventListener('change', async (e) => {
    e.stopPropagation();
    const r = await api.deploySetEnabled(toggle.checked).catch(() => null);
    toggle.checked = !!(r && r.enabled);
    say(toggle.checked ? 'On.' : 'Off. Plexiform will not ask any host about deploys.');
  });
  box.addEventListener('change', (e) => { if (e.target && e.target.dataset && e.target.dataset.provider) e.stopPropagation(); });
  box.addEventListener('click', async (e) => {
    const save = e.target.dataset && e.target.dataset.save;
    const remove = e.target.dataset && e.target.dataset.remove;
    if (save) {
      const input = document.getElementById(`deploy-token-${save}`);
      const r = await api.deployTokenSave(save, input.value).catch(() => null);
      say(r && r.ok ? `${NAMES[save]} token saved.` : (r && r.error) || 'Could not save that token.');
    } else if (remove) {
      const r = await api.deployTokenRemove(remove).catch(() => null);
      say(r && r.ok ? `${NAMES[remove]} token removed.` : 'Could not remove it.');
    } else return;
    refresh();
  });
  refresh();
})();
