'use strict';
// The unified Discover catalogue: one list with three tabs (Starters, Skills,
// MCP servers) built from the verified gallery entries (src/gallery.js) and
// the person's own team's published build logs. Nothing new is fetched here.
// Each card says what it is, what it costs to run, what it may do on this
// computer, who made it and who has used it, and how to install it (always
// through the consent sheet in main) or report it.

const KIND_TAB = { setup: 'starters', pack: 'starters', recipe: 'skills' };
const MCP_FILE = /(^|\/)(\.mcp\.json|mcp[\w.-]*\.json|\.cursor\/mcp\.json|claude_desktop_config\.json)$/i;
const TABS = Object.freeze([['starters', 'Starters'], ['skills', 'Skills'], ['mcp', 'MCP servers']]);
const REPORT_REPO = 'https://github.com/CallumJB125/claude-traffic-light';

function isMcpSetup(item) {
  return item.kind === 'setup' && Array.isArray(item.preview?.files) && item.preview.files.some((f) => MCP_FILE.test(String(f.path || '')));
}

function permissionsOf(item) {
  if (item.kind === 'recipe') return ['Reads your project only: it runs in plan mode and changes no files.'];
  if (item.kind === 'setup') {
    const files = (item.preview?.files || []).map((f) => f.path);
    return [`Writes ${files.length} file${files.length === 1 ? '' : 's'} in your home folder, each shown in full with its own tick before Apply: ${files.map((f) => `~/${f}`).join(', ')}.`, ...(isMcpSetup(item) ? ['Adds MCP server settings: your AI may start the programs they name.'] : [])];
  }
  if (item.kind === 'pack') return ['Adds each item in the pack after one confirm; widget rules and setups still open one at a time with their own review.'];
  return [];
}

function costOf(item) {
  if (item.kind === 'recipe' && item.preview?.cost) return String(item.preview.cost);
  return 'Free to install. Running it uses your own AI plan or API spend.';
}

function reportUrl(item) {
  const title = `Report gallery item ${item.id}`;
  const body = `Gallery item: ${item.id}\nsha256: ${item.sha256}\n\nWhat is wrong with it (spam, malware, stolen, unsafe instructions, other):\n`;
  return `${REPORT_REPO}/issues/new?labels=gallery-report&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// view: gallery.cached()/fetchIndex() result; installed: gallery.installed(); logs: hub build-log summaries (own team).
function catalog({ view = null, installed = null, logs = [] } = {}) {
  const have = new Set([...(installed?.recipes || []), ...(installed?.characters || [])].map((x) => x.galleryId).filter(Boolean));
  const tabs = { starters: [], skills: [], mcp: [] };
  for (const item of view?.ok ? view.items || [] : []) {
    const tab = isMcpSetup(item) ? 'mcp' : KIND_TAB[item.kind];
    if (!tab) continue;
    tabs[tab].push({
      source: 'gallery', id: item.id, sha256: item.sha256, kind: item.kind, title: item.title, what: item.summary,
      cost: costOf(item), permissions: permissionsOf(item),
      author: `${item.author.name}${item.author.github ? ` (@${item.author.github})` : ''}, self-declared`,
      used: have.has(item.id) ? 'Installed here' : 'Not installed here',
      install: item.addable ? (item.kind === 'pack' ? 'pack' : 'add') : null,
      report: reportUrl(item),
    });
  }
  for (const l of Array.isArray(logs) ? logs : []) {
    if (!l || typeof l.id !== 'string') continue;
    tabs.starters.push({
      source: 'build-log', id: l.id, title: l.title, what: 'A build log your team published, with its starter kit if it has one.',
      cost: 'Free to install. Running it uses your own AI plan or API spend.',
      permissions: ['Shown in full on the consent sheet before anything is written; nothing is overwritten.'],
      author: 'Your team', used: `${l.remix_count} remix${l.remix_count === 1 ? '' : 'es'}${l.hidden ? ' · hidden after reports' : ''}`,
      install: 'remix', link: l.url || null, hidden: !!l.hidden,
    });
  }
  return { tabs: TABS.map(([id, label]) => ({ id, label, items: tabs[id] })) };
}

module.exports = { catalog, reportUrl, isMcpSetup, permissionsOf, TABS };
