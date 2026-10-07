'use strict';

// Pure view models for the Burst card, chip and consent text. Takes the client's
// whitelisted snapshot; the renderer only ever sees what this returns.

const MAC_ONLY = 'Burst runs on macOS only. Not available on Windows or Linux.';
const TERMS_URL = 'https://www.anthropic.com/legal/consumer-terms';

// Copied from Claude Burst's README, "What it changes on your Mac" and "Terms and design notes".
const CHANGES_ALWAYS = [
  'Entries in ~/.claude/settings.json: hooks for the features you switch on, and ANTHROPIC_BASE_URL in base-url mode.',
  'A LaunchAgent that runs the gateway, one for the support console, plus the binary in ~/.local/bin.',
];
const CHANGES_TRANSPARENT = [
  'An /etc/hosts entry, a pf redirect and a trusted root CA (name-constrained to api.anthropic.com, in the System keychain).',
  'Root LaunchDaemons. macOS asks for your Mac password in Terminal; Plexiform never sees it.',
];
const TERMS = 'Anthropic\'s current Consumer Terms prohibit account sharing and prohibit bypassing protective measures. Burst is designed around one subscription account per user and treats Anthropic\'s quota rejection as final for that subscription window. When a limit is reached it first tries other Claude models on the same plan, then makes a separate, paid request through a provider you have chosen and pay for yourself, under that provider\'s terms. Transparent mode intercepts TLS for api.anthropic.com on your own Mac, with a CA generated there. The gateway also originates requests of its own (compaction summaries and handover notes) on your subscription, and they count against your limits.';

const TITLES = {
  install: 'Turn on Claude Burst',
  enable: 'Turn on Claude Burst',
  off: 'Turn Claude Burst off',
  repair: 'Repair Claude Burst',
  update: 'Update Claude Burst',
  uninstall: 'Uninstall Claude Burst',
};

const WHAT_HAPPENS = {
  install: (mode) => [
    'Plexiform opens Terminal and runs install.sh from the Burst checkout. The first install clones Burst from GitHub into ~/claude-burst.',
    ...(mode === 'transparent' ? ['Transparent mode makes the changes below for the whole Mac, including every Claude Code session.'] : []),
  ],
  enable: () => ['Plexiform opens Terminal and runs claude-burst enable, which points Claude Code back at the Burst gateway.'],
  off: () => ['Plexiform opens Terminal and runs burst-off, which takes Burst out of Claude Code\'s path. It does not need the gateway to be running.'],
  repair: () => ['Plexiform opens Terminal and runs Burst\'s repair.sh from the checkout. It syncs with GitHub, frees Burst\'s ports and reinstalls in the mode Burst was in.'],
  update: () => ['Burst updates itself in Terminal (git fast-forward, then reinstall in the current mode).'],
  uninstall: () => ['Plexiform opens Terminal and runs ./install.sh uninstall, which removes every part Burst installed and checks that it is gone.'],
};

function consent(kind, { mode = 'base-url', command = '' } = {}) {
  if (!TITLES[kind]) return null;
  const changes = kind === 'off' || kind === 'uninstall' ? [] : [...CHANGES_ALWAYS, ...(mode === 'transparent' ? CHANGES_TRANSPARENT : [])];
  return {
    kind,
    title: TITLES[kind],
    what: WHAT_HAPPENS[kind](mode),
    changesHeading: changes.length ? 'What changes on your Mac' : '',
    changes,
    terms: kind === 'off' || kind === 'uninstall' ? '' : TERMS,
    termsUrl: TERMS_URL,
    undo: 'Undo: Turn Burst off (runs burst-off), or Uninstall (runs ./install.sh uninstall, which checks it is all gone).',
    command,
  };
}

const pad = (n) => String(n).padStart(2, '0');
function hhmm(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function chipFor(d) {
  if (d.kind === 'untrusted') return { tone: 'red', label: 'Untrusted' };
  if (d.kind === 'broken') return { tone: 'red', label: 'Burst needs repair' };
  if (d.kind !== 'present') return d.kind === 'unreachable' ? { tone: 'grey', label: 'Burst off' } : null;
  const s = d.state;
  if (!s.active) return { tone: 'grey', label: 'Burst off' };
  if (s.route === 'SECONDARY') { const t = hhmm(s.until); return { tone: 'amber', label: t ? `Secondary until ${t}` : 'Secondary' }; }
  if (s.rejected.length || s.primaryFailures > 0) return { tone: 'amber', label: 'Limit near' };
  return { tone: 'green', label: 'Primary' };
}

const A = (kind, label, extra = {}) => ({ kind, label, ...extra });

const COMPACTION_ON_CONFIRM = 'Burst will use your Claude subscription tokens to write summaries in the background, which counts against your plan limits and can raise cost slightly when a summary is made.';
const COMPACTION_OWN_OFF = 'While this is on, Plexiform\'s own Claude compactor is off, so the two never compete.';

function statusView(d, { platform = process.platform } = {}) {
  if (platform !== 'darwin' || d.kind === 'unsupported') {
    return { kind: 'unsupported', headline: 'Claude Burst', detail: MAC_ONLY, chip: null, actions: [], version: '', mode: '', route: '', updateAvailable: false, compaction: null };
  }
  const base = { kind: d.kind, compaction: null, chip: chipFor(d), version: '', mode: '', route: '', updateAvailable: false, actions: [], headline: 'Claude Burst', detail: '' };
  switch (d.kind) {
    case 'not_installed':
      return { ...base, kind: 'not_installed', detail: 'Not installed. Burst keeps Claude Code working through limits by sending overflow to a provider you pay for.', actions: [A('install', 'Turn on Burst…', { primary: true, modes: ['base-url', 'transparent'] })] };
    case 'unreachable':
      return { ...base, kind: 'off', detail: 'Installed, but its gateway is not answering. If Claude Code is failing, take Burst out of its path.', actions: [A('enable', 'Turn on', { primary: true }), A('repair', 'Repair'), A('off', 'Turn Burst off'), A('uninstall', 'Uninstall…')] };
    case 'untrusted':
      return { ...base, detail: `${d.reason} Plexiform read nothing from it.`, actions: [A('off', 'Turn Burst off'), A('uninstall', 'Uninstall…')] };
    case 'broken':
      return { ...base, kind: 'broken', version: d.state.version, detail: 'Burst\'s configuration could not be read, so it is not working.', actions: [A('repair', 'Repair', { primary: true }), A('off', 'Turn Burst off'), A('uninstall', 'Uninstall…')] };
    case 'present': {
      const s = d.state;
      const updateAvailable = !!(d.upgrade && d.upgrade.canUpgrade && !d.upgrade.upToDate);
      const pl = s.compaction && s.compaction.pauseless;
      const out = { ...base, version: s.version, mode: s.mode, route: s.route, updateAvailable, canOpenDashboard: true, compaction: pl || null };
      if (pl && pl.enabled && out.chip) out.chip = { ...out.chip, tag: 'Compaction on' };
      if (s.active) {
        out.kind = 'on';
        out.detail = `On, ${s.mode} mode, version ${s.version}. Route: ${s.route === 'SECONDARY' ? 'secondary' : 'primary'}.`;
        out.actions = [A('off', 'Turn Burst off', { primary: true }), ...(updateAvailable ? [A('update', 'Update')] : []), A('open-dashboard', 'Open dashboard'), A('open-browser', 'Open in browser'), A('uninstall', 'Uninstall…')];
      } else {
        out.kind = 'off';
        out.detail = s.inactiveReason || 'Installed, and not in Claude Code\'s path.';
        out.actions = [A('enable', 'Turn on', { primary: true }), ...(updateAvailable ? [A('update', 'Update')] : []), A('open-dashboard', 'Open dashboard'), A('open-browser', 'Open in browser'), A('uninstall', 'Uninstall…')];
      }
      return out;
    }
    default:
      return { ...base, kind: 'untrusted', chip: chipFor({ kind: 'untrusted' }), detail: 'Unknown Burst state.' };
  }
}

module.exports = { COMPACTION_ON_CONFIRM, COMPACTION_OWN_OFF, statusView, consent, chipFor, MAC_ONLY, TERMS_URL, CHANGES_ALWAYS, CHANGES_TRANSPARENT, TERMS };
