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
