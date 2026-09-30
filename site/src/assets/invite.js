// The invite page keeps its token in the URL fragment, so it never reaches a
// server. Here it only builds the "open the app" link, using the same deep-link
// format as the app (brand.js).
(function () {
  const link = document.getElementById('open-app');
  const B = window.Brand;
  if (!link || !B) return;
  const token = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  try {
    B.inviteUrl(token); // refuses anything a link can't carry
    link.href = B.deepLink('invite', { token });
    document.getElementById('invite-line').textContent = 'Three quick steps. Keep this page open, because you\'ll come back to this link.';
  } catch {
    link.setAttribute('aria-disabled', 'true');
    link.removeAttribute('href');
    document.getElementById('invite-line').textContent = 'This link is missing its invite code. Open the link you were sent again.';
  }
})();
