// A window that must stay on its own page: only the exact file:// URL of that
// page in this app passes (query and fragment allowed; they never change the
// document). A loose filename match would also pass /tmp/x/updates.html or
// updates.html.evil.
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

function samePage(own, url) {
  try { const u = new URL(url); u.search = ''; u.hash = ''; return u.href === own; } catch { return false; }
}

// → a will-navigate / will-redirect handler.
function stayOnPage(dir, file) {
  const own = pathToFileURL(path.join(dir, file)).href;
  return (e, url) => { if (!samePage(own, url)) e.preventDefault(); };
}

module.exports = { stayOnPage, samePage };
