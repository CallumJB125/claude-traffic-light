'use strict';

// Pure decisions for the Usage optimiser page, which shows Claude Burst's own
// dashboard in a dedicated, locked-down view. No Electron, no I/O: main wires
// these to the view, and the tests feed them plain values.

const View = require('./burst-view.js');

// Pages the dashboard may hand to the system browser: Anthropic's docs and GitHub, https only.
const EXTERNAL_HOSTS = Object.freeze(['docs.anthropic.com', 'docs.claude.com', 'code.claude.com', 'support.claude.com', 'github.com']);
const DOCS_URL = 'https://github.com/CallumJB125/claude-traffic-light/blob/main/docs/burst.md';
const MIN_VERSION = [0, 19, 0];

function parse(url) { try { return new URL(url); } catch { return null; } }

/**
 * Where may the dashboard view go? 'allow' only for the exact Burst origin;
 * 'external' (system browser) for an https page on the allow-list; else 'deny'.
 */
function navDecision(url, origin) {
  const u = parse(url);
  if (!u || !origin) return 'deny';
  if (u.origin === origin) return 'allow';
  if (u.protocol === 'https:' && !u.username && !u.password && !u.port && EXTERNAL_HOSTS.includes(u.hostname)) return 'external';
  return 'deny';
}

/** A window.open or target=_blank from the dashboard never makes a window; at most the system browser. */
function openDecision(url, origin) {
  const d = navDecision(url, origin);
  return d === 'external' ? 'external' : 'deny';
}

/** Network requests the dashboard's own page may make: Burst's origin and inline data. */
function requestAllowed(url, origin) {
  const u = parse(url);
  if (!u || !origin) return false;
  return u.origin === origin || u.protocol === 'data:' || u.protocol === 'blob:';
}

const TARGET_RE = /^[A-Za-z][\w-]{0,63}$/;
const LABEL_RE = /^[\p{L}\p{N} &.,'()/+-]{1,40}$/u;
const MAX_ITEMS = 10;
const MAX_HTML = 200 * 1024;
// Burst's group headings, in Plexiform's words. Anything else is shown as Burst wrote it, if it passes LABEL_RE.
const GROUP_LABELS = { Observe: 'Overview', Context: 'Context & compaction', Sessions: 'Sessions & handover' };
const SPEND_TARGET = 'sec-models';
// Burst's own names that collide with Plexiform's pages (Overview, This Mac) and tabs (Requests).
const CLASHING = new Set(['Overview', 'This Mac', 'Requests']);

const decode = (s) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The dashboard's section menu, from the outerHTML of its `aside.side`: one
 * item per group heading (pointing at the group's first link), whitelisted and
 * capped. Tabbed-away groups (Codex) are skipped. With no headings the links
 * themselves are used. Anything that does not look like Burst's markup yields [].
 */
function extractSubnav(html) {
  if (typeof html !== 'string') return [];
  const src = html.slice(0, MAX_HTML);
  const re = /<div\b([^>]*)>([^<]*)<\/div>|<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  const attr = (a, n) => (new RegExp(`\\b${n}="([^"]*)"`).exec(a) || [])[1];
  const isGroup = (a) => /\bclass="[^"]*\bnavgroup\b/.test(a);
  const groups = [];
  const loose = [];
  let cur = null;
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) {
      if (!isGroup(m[1])) continue;
      cur = { name: decode(m[2]), skip: attr(m[1], 'data-tab') !== undefined, links: [] };
      groups.push(cur);
    } else if (/\bclass="[^"]*\bnavlink\b/.test(m[3])) {
      const target = attr(m[3], 'data-target');
      const label = decode((/<span\b[^>]*\bclass="[^"]*\blabel\b[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(m[4]) || [])[1] || '');
      if (!TARGET_RE.test(target || '') || !LABEL_RE.test(label)) continue;
      (cur ? cur.links : loose).push({ id: target, label });
    }
  }
  const out = [];
  const push = (id, label) => { if (TARGET_RE.test(id) && LABEL_RE.test(label) && !out.some((o) => o.id === id)) out.push({ id, label: CLASHING.has(label) ? `Burst: ${label}` : label }); };
  for (const g of groups) {
    if (g.skip || !g.links.length) continue;
    push(g.links[0].id, GROUP_LABELS[g.name] || g.name);
    if (g.name === 'Observe' && g.links.some((l) => l.id === SPEND_TARGET)) push(SPEND_TARGET, 'Spend');
  }
  if (!out.length) for (const l of loose) push(l.id, l.label);
  return out.slice(0, MAX_ITEMS);
}

/** The page script that reads the menu: a string and nothing else leaves the page. */
const NAV_SCRIPT = "(function(){var a=document.querySelector('aside.side');return a?String(a.outerHTML).slice(0," + MAX_HTML + "):''})()";

/** Activates a section by clicking Burst's own menu entry, else scrolls to the element, else does nothing. */
function sectionScript(id) {
  if (typeof id !== 'string' || !TARGET_RE.test(id)) return null;
  const j = JSON.stringify(id);
  return `(function(id){var l=document.querySelector('.navlink[data-target="'+id+'"]');if(l){l.click();return 'click'}var e=document.getElementById(id);if(e){e.scrollIntoView({block:'start'});return 'scroll'}return 'none'})(${j})`;
}

/**
 * What the Usage optimiser page shows for a Burst detection result.
 * → { mode: 'ready' | 'empty', reason, headline, detail, chip, actions[], version }
 * `ready` only for a trusted, current Burst; every other state is a native empty state.
 */
function pageState(d, { platform = process.platform } = {}) {
  const v = View.statusView(d, { platform });
  const base = { mode: 'empty', reason: d.kind, chip: v.chip, version: v.version || '', actions: [], docs: true };
  const act = (kind, label, primary = false) => ({ kind, label, ...(primary ? { primary: true } : {}) });
  if (platform !== 'darwin' || d.kind === 'unsupported') return { ...base, reason: 'unsupported', headline: 'Usage optimiser', detail: View.MAC_ONLY };
  switch (d.kind) {
    case 'not_installed':
      return { ...base, headline: 'Usage optimiser needs Claude Burst', detail: 'Claude Burst is a separate, open-source gateway that keeps Claude Code working through plan limits and shows where your usage goes. Turn it on and its dashboard appears here.', actions: [act('install', 'Turn on Burst…', true)] };
    case 'unreachable':
      return { ...base, reason: 'down', headline: 'Burst isn\'t answering', detail: 'Burst is installed but its gateway is not responding. Repair it, or turn it on again.', actions: [act('repair', 'Repair', true), act('enable', 'Turn on'), act('off', 'Turn Burst off')] };
    case 'broken':
      return { ...base, reason: 'down', headline: 'Burst needs repair', detail: 'Burst\'s configuration could not be read, so it is not working.', actions: [act('repair', 'Repair', true), act('off', 'Turn Burst off')] };
    case 'untrusted':
      return { ...base, headline: 'Plexiform will not open this', detail: `${d.reason} Plexiform read nothing from it and loaded nothing.`, actions: [act('off', 'Turn Burst off')], docs: true };
    case 'present': {
      if (!atLeast(d.state.version, MIN_VERSION)) {
        return { ...base, reason: 'old', headline: 'This Burst is too old for the dashboard here', detail: `Burst ${d.state.version} is older than ${MIN_VERSION.join('.')}. Update it and the dashboard appears in this page.`, actions: [act('update', 'Update Burst', true)] };
      }
      return { ...base, mode: 'ready', reason: 'present', headline: 'Usage optimiser', detail: '', docs: false };
    }
    default:
      return { ...base, reason: 'untrusted', headline: 'Plexiform will not open this', detail: 'Unknown Burst state.', actions: [act('off', 'Turn Burst off')] };
  }
}

function atLeast(version, min) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return false;
  for (let i = 0; i < 3; i++) { const n = Number(m[i + 1]); if (n !== min[i]) return n > min[i]; }
  return true;
}

// The one allow-list for what the page may ask main to run (consent dialogs are main's).
const PAGE_ACTIONS = Object.freeze(['install', 'enable', 'repair', 'off', 'update']);

module.exports = { navDecision, openDecision, requestAllowed, extractSubnav, sectionScript, pageState, NAV_SCRIPT, EXTERNAL_HOSTS, DOCS_URL, PAGE_ACTIONS, MAX_ITEMS };
