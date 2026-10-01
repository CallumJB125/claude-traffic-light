// The in-app "Something's off / Idea" report. Pure and Electron-free: every
// path and clock comes from the caller, so tests run against temp dirs.
//
// A report is saved as <dataDir>/feedback/<ISO-timestamp>-<kind>/ with
// report.md, diagnostics.txt and screenshot.png (the last two only when the
// person ticked them). Nothing leaves the machine from here: the senders
// below are offered, and only run after an explicit click.
const nodeFs = require('fs');
const path = require('path');
const { redactSecretsPass } = require('./scrub');

const KINDS = ['off', 'idea'];
const KIND_LABEL = { off: "Something's off", idea: 'Idea' };
const MAX_TEXT = 4000;
const KEEP = 50;
// Browsers and the OS cap a URL near 2000 characters before the query is
// encoded, so the issue body is cut to fit rather than silently dropped.
const MAX_ISSUE_URL = 7000;

// Free text gets the secret scrub and the home folder as "~", but not the
// path-hashing the diagnostics get: prose such as "and/or" would be mangled.
function cleanText(text, home) {
  let s = redactSecretsPass(String(text ?? ''));
  if (home && home.length > 1) s = s.split(home).join('~');
  return s;
}

const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function buildReport({ kind, text, expected = '', version = '', os = '', at = new Date().toISOString(), home = '' }) {
  if (!KINDS.includes(kind)) throw new Error('bad kind');
  const what = cap(cleanText(text, home).trim(), MAX_TEXT);
  if (!what) throw new Error('empty');
  const exp = cap(cleanText(expected, home).trim(), MAX_TEXT);
  const lines = [
    `# ${KIND_LABEL[kind]}`,
    '',
    `- Kind: ${kind}`,
    `- App version: ${version || 'unknown'}`,
    `- OS: ${os || 'unknown'}`,
    `- Time: ${at}`,
    '',
    '## What happened',
    '',
    what,
  ];
  if (exp) lines.push('', '## What did you expect', '', exp);
  return { kind, title: cap(what.split('\n')[0], 80), what, expected: exp, markdown: `${lines.join('\n')}\n` };
}

function reportAsText(report, diagnostics) {
  return diagnostics ? `${report.markdown}\n## Diagnostics\n\n${diagnostics}` : report.markdown;
}

function folderName(at, kind) {
  return `${at.replace(/[:.]/g, '-')}-${kind}`;
}

function save({ dir, report, diagnostics = '', screenshot = null, at = new Date().toISOString(), fs = nodeFs }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  const folder = path.join(dir, folderName(at, report.kind));
  fs.mkdirSync(folder, { mode: 0o700 });
  const put = (name, data) => { fs.writeFileSync(path.join(folder, name), data, { mode: 0o600 }); try { fs.chmodSync(path.join(folder, name), 0o600); } catch { /* best effort */ } };
  put('report.md', report.markdown);
  if (diagnostics) put('diagnostics.txt', diagnostics);
  if (screenshot) put('screenshot.png', screenshot);
  prune(dir, fs);
  return folder;
}

// Names start with an ISO timestamp, so the sorted order is the age order.
function prune(dir, fs = nodeFs, keep = KEEP) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d{4}-/.test(e.name)).map((e) => e.name).sort(); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}

// The issue body: report plus scrubbed diagnostics, shortened so the whole URL
// stays under MAX_ISSUE_URL once percent-encoded.
function githubUrl(repo, report, diagnostics = '', { screenshot = false } = {}) {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const note = screenshot ? '\n\n(A screenshot was saved on this computer: drag it into the issue.)' : '';
  const head = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(`${KIND_LABEL[report.kind]}: ${report.title}`)}&body=`;
  const main = reportAsText(report, diagnostics);
  const room = MAX_ISSUE_URL - head.length;
  const fits = (t) => encodeURIComponent(t).length <= room;
  let body = main + note;
  if (!fits(body)) {
    const tail = `\n\n[cut to fit a link; the full report is in the saved folder]${note}`;
    let keep = main.slice(0, room);
    while (keep.length && !fits(keep.trimEnd() + tail)) keep = keep.slice(0, Math.floor(keep.length * 0.95));
    body = keep.trimEnd() + tail;
  }
  return head + encodeURIComponent(body);
}

// Sending to the team board: main only builds the text and hands the page a
// fragment; the signed-in board page shows it and posts it on a click, so main
// never touches the hub session.
const BOARD_KIND = { off: 'bug', idea: 'idea' };
const MAX_TITLE = 200;
const MAX_BODY = 20000;
const MAX_FRAGMENT = 32000;
const FRAGMENT_KEY = 'plexiform-feedback=';
const CUT_MARK = "\n\n…(truncated; full report saved on the reporter's computer)";
const SHOT_NOTE = "\n\nA screenshot was saved on the reporter's computer; ask for it if needed.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Stored beside the report so a retry (or a second click) reuses the id and the hub dedupes.
function requestIdFor(folder, { fs = nodeFs, randomUUID = () => require('crypto').randomUUID() } = {}) {
  const file = path.join(folder, 'request-id');
  try { const v = fs.readFileSync(file, 'utf8').trim(); if (UUID.test(v)) return v; } catch { /* first send */ }
  const id = randomUUID();
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return id;
}

const fragmentOf = (payload) => FRAGMENT_KEY + Buffer.from(JSON.stringify(payload)).toString('base64url');

// Never includes the screenshot, only a line saying one exists.
function buildBoardFragment({ report, diagnostics = '', screenshot = false, requestId }) {
  const text = reportAsText(report, diagnostics);
  const note = screenshot ? SHOT_NOTE : '';
  const make = (body) => ({ v: 1, kind: BOARD_KIND[report.kind], title: cap(`${KIND_LABEL[report.kind]}: ${report.title}`, MAX_TITLE), body, requestId });
  let body = text + note;
  let payload = make(body);
  let fragment = fragmentOf(payload);
  if (body.length > MAX_BODY || fragment.length > MAX_FRAGMENT) {
    let keep = text.slice(0, MAX_BODY - CUT_MARK.length - note.length);
    for (;;) {
      body = keep.trimEnd() + CUT_MARK + note;
      payload = make(body);
      fragment = fragmentOf(payload);
      if (fragment.length <= MAX_FRAGMENT || !keep) break;
      keep = keep.slice(0, Math.floor(keep.length * 0.9));
    }
  }
  return { payload, fragment };
}

const MSG = {
  noTeam: 'Join a team to send feedback to its board. Your report is saved on this computer.',
  invalid: "Couldn't prepare the report for sending. It's saved on this computer.",
  unavailable: "The team board isn't reachable right now. Your report is saved on this computer.",
  opened: "Opened your team's board. Check the text there, then click Send.",
};

// `buddyWin.openWithFragment` may not exist yet in every build, so it is feature-checked.
async function sendToBoard({ last, buddyWin, fs = nodeFs, randomUUID }) {
  if (!last || typeof buddyWin?.openWithFragment !== 'function') return { ok: false, message: MSG.noTeam };
  let fragment;
  try {
    fragment = buildBoardFragment({ report: last.report, diagnostics: last.diagnostics, screenshot: last.shot, requestId: requestIdFor(last.folder, { fs, randomUUID }) }).fragment;
  } catch { return { ok: false, message: MSG.invalid }; }
  let r;
  try { r = await buddyWin.openWithFragment('board', fragment); } catch { r = { ok: false, why: 'unavailable' }; }
  if (r?.ok) return { ok: true, message: MSG.opened };
  return { ok: false, message: r?.why === 'no-team' ? MSG.noTeam : r?.why === 'invalid' ? MSG.invalid : MSG.unavailable };
}

const senders = [
  { id: 'github', label: 'Open a GitHub issue', available: (config) => !!githubUrl(config?.feedbackRepo, { kind: 'off', title: '', markdown: '' }) },
];

module.exports = { KINDS, KIND_LABEL, MAX_TEXT, KEEP, MAX_ISSUE_URL, cleanText, buildReport, reportAsText, save, prune, githubUrl, senders, requestIdFor, buildBoardFragment, sendToBoard, MSG, MAX_FRAGMENT };
