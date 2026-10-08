const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
const text = (file) => read(file).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('release disclosure: local content, durable hub history and access boundaries are explicit', () => {
  const privacy = text('privacy.html');
  assert.match(privacy, /Local Tasks keeps the task text.*messages.*AI activity and replies/i);
  assert.match(privacy, /temporary requests can contain tool input, plan text or questions/i);
  assert.match(privacy, /messages, receipts and replies are stored durably on the team hub/i);
  assert.match(privacy, /readable by its operator and authorized team members/i);
  assert.match(privacy, /owner's provider quota and existing permissions/i);
  assert.match(privacy, /viewers can watch/i);
  assert.match(privacy, /revoking access stops future authorized access.*does not erase messages/i);
  for (const file of ['index.html', 'privacy.html', 'docs.html']) {
    const copy = text(file);
    assert.doesNotMatch(copy, /never stores (?:your )?(?:prompts|replies|text)|nothing in it is uploaded|team sharing is (?:a )?separate opt-in/i, file);
    assert.match(copy, /automatically shared|automatically shares/i, file);
    assert.match(copy, /personal sessions stay separate|personal sessions and unrelated provider chats stay separate/i, file);
    assert.match(copy, /candidate.*(?:not.*published|does not mean.*published)/i, file);
  }
});

test('release disclosure: provider permissions and task-inbox receipt are not overstated', () => {
  const docs = text('docs.html');
  assert.match(docs, /does not attach arbitrary terminals, bypass permissions or make Cursor, Gemini or every other observed provider interactive/i);
  assert.match(docs, /queued is not proof of receipt, agent acknowledgement or completion/i);
  assert.match(docs, /sending does not automatically resume an agent/i);
  assert.match(docs, /stop a private-session share.*disable automatic team sharing/i);
  const privacy = text('privacy.html');
  assert.match(privacy, /relay holds message text in memory rather than writing that relay text to its database/i);
  assert.match(privacy, /does not export a transcript from before sharing/i);
});

test('release disclosure: observed website analytics is separate from desktop diagnostics', () => {
  const privacy = text('privacy.html');
  assert.match(privacy, /served privacy and download pages found an injected Cloudflare Web Analytics beacon/i);
  assert.match(privacy, /runtime and cookie behavior still need verification/i);
  assert.match(privacy, /do not currently promise an analytics-free or cookie-free website/i);
  assert.match(privacy, /separate from the desktop app's local diagnostics/i);
});

// Execute the real download script with a deterministic GitHub API response and
// a tiny DOM. No browser, host request or installed app is used.
class Element {
  constructor(dataset = {}) { this.dataset = dataset; this.attrs = {}; this.children = []; this.classList = { add() {}, remove() {} }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  addEventListener() {}
  get lastElementChild() { return this.children.at(-1); }
  get textContent() { return this.children.map((c) => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(value) { this.children = [value]; }
}
async function download(os, releases, windows = false) {
  const html = read('download.html');
  const fallback = html.match(/data-fallback="([^"]+)"/)[1];
  const api = html.match(/data-api="([^"]+)"/)[1];
  const elements = { dl: new Element({ api, fallback, windows: String(windows) }), 'dl-status': new Element() };
  const rows = ['mac', 'win', 'linux'].map((kind) => { const row = new Element({ os: kind }); row.append(new Element(), new Element()); return row; });
  const calls = [];
  vm.runInNewContext(read('assets/download.js'), {
    window: { __os: os }, navigator: {}, AbortController, setTimeout, clearTimeout,
    document: { getElementById: (id) => elements[id] || null, createElement: () => new Element(), querySelectorAll: () => rows },
    fetch: async (url) => { calls.push(url); return { ok: !!releases, json: async () => releases }; },
  });
  await new Promise(setImmediate);
  return { elements, rows, calls };
}
const asset = (name) => ({ name, size: 5e7, browser_download_url: `https://github.com/x/releases/download/v9/${name}` });
const releases = [
  { draft: true, tag_name: 'v10', assets: [] },
  { draft: false, prerelease: true, tag_name: 'v9.7.3-beta.1', html_url: 'https://github.com/x/releases/tag/v9', assets: ['Plexiform-9.7.3-mac-arm64.dmg', 'Plexiform-9.7.3-mac-x64.zip', 'Plexiform-9.7.3-linux-x86_64.AppImage', 'plexiform_9.7.3_amd64.deb', 'SHA256SUMS.txt'].map(asset) },
];
const links = (row) => row.lastElementChild.children.filter((c) => typeof c !== 'string');

test('release downloads: a failed API read uses a version-neutral real Releases fallback', async () => {
  const { elements, rows } = await download('mac', null);
  assert.equal(elements['dl-status'].children[1].attrs.href, 'https://github.com/CallumJB125/claude-traffic-light/releases');
  assert.equal(rows[0].lastElementChild.children[0].attrs.href, 'https://github.com/CallumJB125/claude-traffic-light/releases');
  assert.equal(rows[1].lastElementChild.textContent, 'Unavailable pending runtime acceptance');
  assert.doesNotMatch(text('download.html'), /1\.0\.2-beta/);
});

test('release downloads: links come from the newest non-draft GitHub release; Windows stays gated', async () => {
  const r = await download('linux', releases);
  assert.deepEqual(r.calls, ['https://api.github.com/repos/CallumJB125/claude-traffic-light/releases?per_page=10']);
  assert.match(r.elements['dl-status'].textContent, /public preview: 9\.7\.3-beta\.1/);
  assert.deepEqual(links(r.rows[0]).map((l) => l.attrs.href), ['https://github.com/x/releases/download/v9/Plexiform-9.7.3-mac-arm64.dmg', 'https://github.com/x/releases/download/v9/Plexiform-9.7.3-mac-x64.zip']);
  assert.equal(links(r.rows[2]).length, 2);
  assert.ok('data-current' in r.rows[2].attrs && !('data-current' in r.rows[0].attrs));
  assert.equal(r.rows[1].lastElementChild.children.length, 0, 'the Windows row is left as the page wrote it');
});

test('release downloads: the page offers the one-line installer and honest Mac wording', () => {
  const html = read('download.html');
  assert.match(html, /id="install-cmd">curl -fsSL https:\/\/plexiform\.dev\/install\.sh \| sh</);
  assert.match(html, /id="copy-install"/);
  const copy = text('download.html');
  assert.match(copy, /checks its SHA-256/);
  assert.match(copy, /no Apple Developer ID/);
  assert.match(copy, /not Apple Developer ID signed or notarization|ad-hoc signing, not Apple Developer ID signing or notarization/);
  assert.doesNotMatch(html, /data-feed|feed\.js/);
});

test('release downloads: damaged-app instructions preserve verification and consent boundaries', () => {
  const copy = text('download.html');
  assert.doesNotMatch(copy, /xattr -dr|only happens the first time|Sign in with Google|Always Allow/i);
  assert.match(copy, /signature problem, stop, verify the checksum and re-download/i);
  assert.match(copy, /do not bypass that warning/i);
  assert.match(copy, /Ad-hoc signed updates may ask again; do not approve an unexpected request/i);
  assert.match(copy, /method offered by that team's hub/i);
});
