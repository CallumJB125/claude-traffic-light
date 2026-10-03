const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Feed = require('../src/assets/feed.js');
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

// Execute the real download script with deterministic feed responses and a tiny
// DOM. No browser, provider, host request or installed app is used.
class Element {
  constructor(dataset = {}) { this.dataset = dataset; this.attrs = {}; this.children = []; this.classList = { add() {}, remove() {} }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  get lastElementChild() { return this.children.at(-1); }
  get textContent() { return this.children.map((c) => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(value) { this.children = [value]; }
}
async function download(os, feeds, windows = false) {
  const html = read('download.html');
  const fallback = html.match(/data-fallback="([^"]+)"/)[1];
  const elements = { dl: new Element({ feed: 'https://download.plexiform.dev', fallback, windows: String(windows) }), 'dl-status': new Element(), 'dl-primary': new Element(), 'dl-meta': new Element() };
  const rows = ['mac', 'win', 'linux'].map((kind) => { const row = new Element({ os: kind }); row.append(new Element(), new Element()); return row; });
  const calls = [];
  vm.runInNewContext(read('assets/download.js'), {
    window: { PlexiformFeed: Feed, __os: os }, navigator: {}, AbortController,
    setTimeout, clearTimeout,
    document: { getElementById: (id) => elements[id], createElement: () => new Element(), querySelectorAll: () => rows },
    fetch: async (url) => { calls.push(url); const body = feeds[url.split('/').at(-1)]; return { ok: typeof body === 'string', text: async () => body }; },
  });
  await new Promise(setImmediate);
  return { elements, rows, calls };
}
const linuxFeed = 'version: 9.7.3\nfiles:\n  - url: Plexiform-9.7.3.AppImage\n    sha512: ABCD\n  - url: plexiform_9.7.3_amd64.deb\n';

test('release downloads: failed feeds use a version-neutral real Releases fallback', async () => {
  const { elements, rows } = await download('mac', {});
  const link = elements['dl-primary'].children[0];
  assert.equal(link.attrs.href, 'https://github.com/CallumJB125/claude-traffic-light/releases');
  assert.equal(link.textContent, 'Browse published GitHub releases');
  assert.equal(elements['dl-status'].textContent, 'Could not verify the Mac download feed.');
  assert.equal(rows[2].lastElementChild.textContent, 'Could not verify the download feed');
  assert.doesNotMatch(text('download.html'), /Linux.*not published/i);
  assert.match(text('download.html'), /prepared release candidate is not yet a published download/i);
});

test('release downloads: Linux follows its published feed and Windows stays gated even with a feed', async () => {
  const feeds = { [Feed.FEEDS.linux]: linuxFeed, [Feed.FEEDS.win]: 'version: 9.7.3\nfiles:\n  - url: Setup.exe\n' };
  const linux = await download('linux', feeds);
  assert.equal(linux.elements['dl-status'].textContent, 'Version 9.7.3 for Linux');
  assert.equal(linux.elements['dl-primary'].children[0].attrs.href, 'https://download.plexiform.dev/Plexiform-9.7.3.AppImage');
  assert.equal(linux.rows[2].children[1].children.filter((c) => typeof c !== 'string').length, 2);
  const win = await download('win', feeds);
  assert.equal(win.elements['dl-status'].textContent, 'Windows is unavailable pending runtime acceptance.');
  assert.equal(win.rows[1].lastElementChild.textContent, 'Unavailable pending runtime acceptance');
  assert.ok(!win.calls.some((url) => url.endsWith(Feed.FEEDS.win)), 'an unexpected feed cannot enable an unaccepted platform');
  assert.equal(win.elements['dl-primary'].children[0].textContent, 'Browse published GitHub releases');
});

test('release downloads: damaged-app instructions preserve verification and consent boundaries', () => {
  const copy = text('download.html');
  assert.doesNotMatch(copy, /xattr -dr|only happens the first time|Sign in with Google|Always Allow/i);
  assert.match(copy, /signature problem, stop, verify the checksum and re-download/i);
  assert.match(copy, /do not bypass that warning/i);
  assert.match(copy, /Ad-hoc signed updates may ask again; do not approve an unexpected request/i);
  assert.match(copy, /method offered by that team's hub/i);
});

test('accepted Windows downloads follow the feed; missing or wrong-platform files never become a download', async () => {
  const feeds = { [Feed.FEEDS.win]: 'version: 9.7.3\nfiles:\n  - url: Plexiform-Setup-9.7.3.exe\n    sha512: ABCD\n' };
  const win = await download('win', feeds, true);
  assert.equal(win.elements['dl-status'].textContent, 'Version 9.7.3 for Windows');
  assert.equal(win.elements['dl-primary'].children[0].attrs.href, 'https://download.plexiform.dev/Plexiform-Setup-9.7.3.exe');
  assert.equal(win.rows[1].attrs['data-version'], '9.7.3');
  for (const feed of [undefined, linuxFeed]) {
    const missing = await download('win', { [Feed.FEEDS.win]: feed }, true);
    assert.equal(missing.elements['dl-status'].textContent, 'Could not verify the Windows download feed.');
    assert.equal(missing.elements['dl-primary'].children[0].textContent, 'Browse published GitHub releases');
  }
});
