// Placeholder / status page for the content area: "coming next", "starting
// the board…", or a board error with a retry. Text only.
const q = new URLSearchParams(location.search);
const kind = q.get('kind') ?? 'soon';
document.getElementById('title').textContent = q.get('title') ?? '';
document.getElementById('blurb').textContent = q.get('blurb') ?? '';
document.body.dataset.kind = kind;
const badge = document.getElementById('badge');
badge.textContent = kind === 'soon' ? 'Coming next' : kind === 'loading' ? 'Starting…' : kind === 'error' ? 'Board unavailable' : '';
const retry = document.getElementById('retry');
if (kind === 'error') {
  retry.hidden = false;
  retry.addEventListener('click', () => { retry.disabled = true; window.buddyInfo?.retry(); });
}

if (kind === 'connect') {
  badge.textContent = '';
  const form = document.getElementById('connect');
  const err = document.getElementById('connect-error');
  const go = document.getElementById('connect-go');
  form.hidden = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    err.textContent = '';
    go.disabled = true;
    go.textContent = 'Checking…';
    try {
      const r = await window.buddyInfo.connect(fd.get('url'), fd.get('name'));
      if (!r?.ok) err.textContent = r?.error ?? 'Could not connect.';
    } catch {
      err.textContent = 'Could not connect.';
    }
    go.disabled = false;
    go.textContent = 'Connect';
  });
}
