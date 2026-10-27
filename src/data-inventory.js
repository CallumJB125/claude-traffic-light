// Every place Plexiform keeps data about you on this computer, as one list:
// Settings → Privacy → Your data reads it, the export (src/data-export.js)
// copies from it and Delete my data (src/data-delete.js) removes only what
// it names. Paths are worked out from four roots and never from input:
//   data      ~/.claude-traffic-light (or CLAUDE_TRAFFIC_LIGHT_HOME)
//   userData  the app's folder (~/Library/Application Support/Plexiform)
//   backups   Plexiform Backups, beside it
//   legacy    the app folder from before the rename, if it is still there
// Each store lists top-level names inside one root; 'rest' takes whatever
// else is in that root, so a file a future version adds is still shown and
// still deletable. Sizes and deletion use lstat and never follow a link.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STORES = Object.freeze([
  { id: 'settings', root: 'data', kind: 'settings', label: 'Settings, rules and presets', detail: 'Your preferences, light rules, presets, clients list and window positions.',
    names: ['config.json', 'rules', 'presets', 'window-bounds.json', 'manual-override.json', 'claude-deny-rules.json', 'router-baseline.json', 'automation-explained.json', 'ai-tools.json', 'tasks-seen.json', 'morning-seen.json', 'away.json', 'clients.json', 'checkpoints.json', '.help-shown', '.onboarded', '.auto-launch-configured', '.calendar-granted'] },
  { id: 'sessions', root: 'data', kind: 'sessions', label: 'Session state', detail: 'What each AI session is doing now: folder, state, tool and model names, approval requests.',
    names: ['sessions', 'requests', 'owned', 'senders', 'last-hook.json', 'hook-endpoint.json', 'burst-snapshot.json', 'burst-handover.json', 'burst-scripts', 'git-signals.json', 'busy-ics-cache.json', 'spend-snapshot.json', 'terminal-state.json'] },
  { id: 'handovers', root: 'data', kind: 'handovers', label: 'Session handovers', detail: 'Handover notes written from your sessions.', names: ['handovers'] },
  { id: 'activity', root: 'data', kind: 'activity', label: 'Activity log', detail: 'The app log, approvals you gave with one key, approval counts and the last 50 "What did my AI just do?" recaps (scrubbed).',
    names: ['app.log', 'app.log.old', 'one-key-approvals.jsonl', 'approval-counts.json', 'explain-recaps.json'] },
  { id: 'usage', root: 'data', kind: 'usage', label: 'Usage and spend history', detail: 'Token counts, costs, budgets and compaction totals. No conversation text.',
    names: ['stats.json', 'usage', 'compaction-stats.json', 'cost-guard.json', 'cost-guard-log.json', 'spend-gate.json'] },
  { id: 'memory', root: 'data', kind: 'index', label: 'Memory search index', detail: 'The local search index of your past sessions, including their text.', names: ['memory'] },
  { id: 'checkpoints', root: 'data', kind: 'checkpoints', label: 'Checkpoints', detail: 'What changed per turn: copies of files your AI edited and their reviews.', names: ['checkpoints'] },
  { id: 'characters', root: 'data', kind: 'media', label: 'Characters and cameo photos', detail: 'Characters you made and cameo photos you added.', names: ['characters', 'cameos'] },
  { id: 'crash-reports', root: 'data', kind: 'diagnostics', label: 'Crash reports', detail: 'Scrubbed crash reports kept on this Mac.', names: ['crash-reports'] },
  { id: 'feedback', root: 'data', kind: 'feedback', label: 'Feedback drafts', detail: 'Feedback you started writing.', names: ['feedback'] },
  { id: 'recipes', root: 'data', kind: 'settings', label: 'Your recipes', detail: 'Recipes you saved as your own.', names: ['recipes'] },
  { id: 'gallery', root: 'data', kind: 'cache', label: 'Community gallery list', detail: 'The last gallery list you fetched from plexiform.dev, kept so it opens without fetching again.', names: ['gallery'] },
  { id: 'team-today', root: 'data', kind: 'cache', label: 'Team today summary', detail: 'The last Team today summary fetched from your team, kept so Home opens fast.', names: ['team-today.json'] },
  { id: 'keys', root: 'data', kind: 'secret', export: false, label: 'Keys and local tokens', detail: 'The local signal token, paired-device keys, licence and sync keys, and deploy host tokens you pasted (sealed). Never exported.',
    names: ['token', 'port', 'hook.sock', 'approval-secret.json', 'entitlement.json', 'entitlement-clock.json', 'remote', 'remote.json', 'remote-state.json', 'sync', 'deploy-status.json'] },
  { id: 'data-other', root: 'data', kind: 'other', rest: true, label: 'Other files in the data folder', detail: 'Anything else Plexiform wrote to its data folder.' },

  { id: 'work', root: 'userData', kind: 'work', label: 'Captured work and cost records', detail: 'Cards, branches and pull requests matched to sessions, and their costs.',
    names: ['work-capture.json', 'work-records.json', 'session-links.json'] },
  { id: 'board', root: 'userData', kind: 'board', label: 'Local team board', detail: 'The board database on this Mac: cards, comments and handovers.', names: ['board', 'board-dev'] },
  { id: 'tasks', root: 'userData', kind: 'tasks', label: 'Tasks run on this Mac', detail: 'Task text, messages, replies and run folders.', names: ['tasks', 'plexiform-tasks', 'runner'] },
  { id: 'session-followups', root: 'userData', kind: 'messages', export: false, label: 'Queued session follow-ups', detail: 'OS-encrypted local messages and delivery receipts, scoped to their original account and board. Not included in the scrubbed export; view or discard them in Overview, or delete this store here.', names: ['session-followups'] },
  { id: 'accounts', root: 'userData', kind: 'secret', export: false, label: 'Team sign-in and setups', detail: 'Sealed team sign-ins, device tokens, workspaces and setups history. Never exported.',
    names: ['buddy-accounts', 'buddy-devices', 'buddy-workspaces.json', 'setups-runtime-v2', 'native-board', 'native-board-dev-home'] },
  { id: 'local-model-keys', root: 'userData', kind: 'secret', export: false, label: 'Local model API keys', detail: 'API keys you entered for your own model endpoints, encrypted with your system\'s secure storage. Never exported.',
    names: ['local-model-keys.json'] },
  { id: 'app-prefs', root: 'userData', kind: 'settings', label: 'App preferences', detail: 'Update channel and local model settings.', names: ['updater.json', 'local-models.json'] },
  { id: 'browser', root: 'userData', kind: 'cache', export: false, label: 'Window storage and caches', detail: 'Cookies, caches and page storage of Plexiform’s own windows. Not exported.',
    names: ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage', 'Cookies', 'Cookies-journal', 'Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'Service Worker', 'Partitions', 'Shared Dictionary', 'DIPS', 'DIPS-wal', 'DIPS-journal', 'Trust Tokens', 'Trust Tokens-journal', 'Network Persistent State', 'Preferences', 'Local State', 'TransportSecurity', 'declarative_performance_observer.db', 'declarative_performance_observer.db-journal', 'Crashpad'] },
  { id: 'app-other', root: 'userData', kind: 'other', rest: true, label: 'Other files in the app folder', detail: 'Anything else in Plexiform’s app folder.' },

  { id: 'backups', root: 'backups', kind: 'backups', all: true, label: 'Backups', detail: 'Copies of your settings, rules, faces and usage history.' },
  { id: 'legacy', root: 'legacy', kind: 'legacy', all: true, export: false, label: 'App folder from before the rename', detail: 'The app folder left by Plexiform’s earlier name.' },
]);

const RECEIPTS = 'deletion-receipts';
const PENDING = '.pending-deletion.json';
// Not personal, or needed to start: listed so nothing is silently skipped.
const KEEP = Object.freeze({
  data: { [RECEIPTS]: 'Deletion receipts (no personal content)', [PENDING]: 'A deletion waiting for the next start', bin: 'Hook launcher your AI tools run' },
  userData: { SingletonLock: 'App lock', SingletonCookie: 'App lock', SingletonSocket: 'App lock', updates: 'Update files', 'rename-migration.json': 'Rename record', run: 'Temporary key folders (chat-<pid>-*, voice-key-<pid>-*, codex-<pid>-*; 0700, deleted when the chat or question ends, swept at start)' },
});
// Other tools' folders that turn up inside a data folder are theirs, not ours.
const FOREIGN = new Set(['.omc', '.claude', '.codex', '.gemini', '.cursor', '.git', '.vscode', '.DS_Store']);
// Installed copies of the hooks (src/hook-paths.js): deleting them would break your AI tools' hook commands.
const HOOKS_COPY = /^hooks-[\w.+-]+$/;
const keptWhy = (root, n) => (KEEP[root] || {})[n] || (FOREIGN.has(n) ? 'Another tool’s folder' : root === 'data' && HOOKS_COPY.test(n) ? 'Hook programs your AI tools run' : null);

const byId = new Map(STORES.map((s) => [s.id, s]));
const named = { data: new Set(), userData: new Set() };
for (const s of STORES) if (s.names && named[s.root]) for (const n of s.names) named[s.root].add(n);

/** The AI tools' own folders and the places a data root must never be or contain. */
function protectedPaths(home) {
  const h = path.resolve(home);
  return {
    never: ['/', h, path.join(h, 'Library'), path.join(h, 'Library', 'Application Support'), path.join(h, 'Documents'), path.join(h, 'Desktop'), path.join(h, 'Downloads'), path.join(h, '.config'), os.tmpdir()].map((p) => path.resolve(p)),
    tools: ['.claude', '.codex', '.gemini', '.cursor', '.claude.json'].map((n) => path.join(h, n)),
  };
}

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** null when `root` is safe to read and delete under, else why not. */
function rootProblem(root, home = os.homedir()) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return 'not an absolute folder';
  const r = path.resolve(root);
  const { never, tools } = protectedPaths(home);
  if (never.includes(r)) return 'a top-level folder';
  if (never.some((p) => p !== '/' && inside(p, r) && p !== r) || r === '/') return 'contains your own folders';
  if (tools.some((t) => inside(r, t) || inside(t, r))) return "an AI tool's own folder";
  let st;
  try { st = fs.lstatSync(r); } catch { return null; }
  if (st.isSymbolicLink()) return 'a link to somewhere else';
  if (!st.isDirectory()) return 'not a folder';
  return null;
}

/** {data, userData, backups, legacy} with absent ones as null. */
function rootsOf({ dataDir, userDataDir = null, backupsDir = null, legacyDir = null }) {
  return { data: dataDir || null, userData: userDataDir || null, backups: backupsDir || null, legacy: legacyDir || null };
}

function list(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

/** Top-level names a store covers in its root right now. */
function namesOf(store, roots) {
  const root = roots[store.root];
  if (!root) return [];
  if (store.all) return list(root);
  if (store.rest) {
    return list(root).filter((n) => !named[store.root].has(n) && !keptWhy(store.root, n)).sort();
  }
  return store.names.filter((n) => { try { fs.lstatSync(path.join(root, n)); return true; } catch { return false; } });
}

/** Bytes and files under p, by lstat: a link counts as itself and is never entered. */
function measure(p, budget = { left: 200_000 }) {
  let st;
  try { st = fs.lstatSync(p); } catch { return { bytes: 0, files: 0 }; }
  if (!st.isDirectory() || st.isSymbolicLink()) return { bytes: st.size, files: 1 };
  let bytes = 0, files = 0;
  for (const n of list(p)) {
    if (--budget.left < 0) break;
    const m = measure(path.join(p, n), budget);
    bytes += m.bytes; files += m.files;
  }
  return { bytes, files };
}

/**
 * One row per store: {id, label, detail, path, paths, bytes, files, kind,
 * deletable, exportable, problem}. `problem` says why a root is refused.
 */
function inventory(opts) {
  const roots = rootsOf(opts);
  const home = opts.home || os.homedir();
  const problems = {};
  for (const [k, r] of Object.entries(roots)) problems[k] = r ? rootProblem(r, home) : 'not on this computer';
  return STORES.map((s) => {
    const root = roots[s.root];
    const problem = problems[s.root];
    const names = problem ? [] : namesOf(s, roots);
    const paths = names.map((n) => path.join(root, n));
    let bytes = 0, files = 0;
    for (const p of paths) { const m = measure(p); bytes += m.bytes; files += m.files; }
    return {
      id: s.id, label: s.label, detail: s.detail, kind: s.kind,
      path: root ? (s.all || s.rest || names.length !== 1 ? root : paths[0]) : null,
      paths, bytes, files,
      deletable: !problem && paths.length > 0,
      exportable: s.export !== false,
      problem: root ? problem : null,
    };
  });
}

/** Names kept on purpose in each root, with why. */
function kept(opts) {
  const roots = rootsOf(opts);
  const out = [];
  for (const root of Object.keys(KEEP)) {
    if (!roots[root]) continue;
    for (const n of list(roots[root]).sort()) { const why = keptWhy(root, n); if (why) out.push({ root, name: n, why }); }
  }
  return out;
}

module.exports = { STORES, KEEP, FOREIGN, RECEIPTS, PENDING, byId, inventory, kept, namesOf, measure, rootProblem, rootsOf, inside, protectedPaths };
