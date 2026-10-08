// Preferences → Privacy → Crash reports. A file of its own so the block can
// move with the Settings split; text goes in with textContent only.
(function () {
  const api = window.settingsApi;
  const $ = (id) => document.getElementById(id);
  if (!$('crash-reports') || !api || !api.crashReportsState) return;
  const toggle = $('crash-opt-in');
  const say = (text) => { $('crash-status').textContent = text; };

  async function refresh() {
    const s = await api.crashReportsState().catch(() => null);
    if (!s) return;
    toggle.checked = s.optedIn === true;
    $('crash-payload').textContent = s.latest || 'No crash has been recorded on this Mac.';
  }

  // Its own save: the page-wide change listener must not also save the config.
  toggle.addEventListener('change', async (e) => {
    e.stopPropagation();
    const r = await api.crashReportsSetOptIn(toggle.checked).catch(() => null);
    toggle.checked = !!(r && r.optedIn);
    say(toggle.checked ? 'Allowed. Reports are only saved on this Mac for now.' : 'Off. Reports are only saved on this Mac.');
  });
  $('crash-view').addEventListener('toggle', () => { if ($('crash-view').open) refresh(); });
  $('crash-export').addEventListener('click', async () => {
    const r = await api.crashReportsExport().catch((err) => ({ error: err.message }));
    say(!r ? '' : r.error ? `Could not export: ${r.error}` : r.path ? `Saved ${r.path}` : '');
  });
  refresh();
})();
