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

// One vocabulary everywhere: Checking… / Not installed / Not responding / Off.
const RETRY_BEFORE_REPAIR = 3;
function chipFor(d) {
  if (d.kind === 'checking') return { tone: 'grey', label: 'Checking…' };
  if (d.kind === 'untrusted') return { tone: 'red', label: 'Untrusted' };
  if (d.kind === 'broken') return { tone: 'red', label: 'Burst needs repair' };
  if (d.kind !== 'present') return d.kind === 'unreachable' ? { tone: 'amber', label: 'Not responding' } : null;
  const s = d.state;
  if (!s.active) return { tone: 'grey', label: 'Off' };
  if (s.route === 'SECONDARY') { const t = hhmm(s.until); return { tone: 'amber', label: t ? `Secondary until ${t}` : 'Secondary' }; }
  if (s.rejected.length || s.primaryFailures > 0) return { tone: 'amber', label: 'Limit near' };
  return { tone: 'green', label: 'Primary' };
}

const A = (kind, label, extra = {}) => ({ kind, label, ...extra });

// Below this a Burst is `too_old`: Plexiform's client reads nothing newer than
// /api/state from it and the dashboard embed refuses it. 0.19 still works with
// the 0.20 features hidden (capability flags false), so the floor stays at 0.19.
const MIN_VERSION = [0, 19, 0];
function atLeast(version, min) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return false;
  for (let i = 0; i < 3; i++) { const n = Number(m[i + 1]); if (n !== min[i]) return n > min[i]; }
  return true;
}

function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'a moment ago';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// The one next step for a state: the primary action, else the first; null when
// there is nothing to do (a healthy, current Burst).
const firstAction = (actions) => { const a = actions.find((x) => x.primary) || actions[0]; return a ? { kind: a.kind, label: a.label } : null; };

const COMPACTION_ON_CONFIRM = 'Burst will use your Claude subscription tokens to write summaries in the background, which counts against your plan limits and can raise cost slightly when a summary is made.';
const COMPACTION_OWN_OFF = 'While this is on, Plexiform\'s own Claude compactor is off, so the two never compete.';

// One headline per state, so the card and the Home row say what is wrong before the detail does.
const HEADLINES = Object.freeze({
  not_installed: 'Claude Burst is not installed',
  off: 'Burst is off',
  too_old: 'Update Burst',
  ca_untrusted: 'Burst\'s certificate is not trusted',
  hosts_missing: 'Burst\'s hosts entry is missing',
  console_down: 'Burst\'s console is not running',
  gateway_stale: 'Burst is not responding',
  unreachable: 'Burst is not responding',
  broken: 'Burst needs repair',
  untrusted: 'Something else is on Burst\'s port',
  on: 'Claude Burst',
});
const headlineFor = (kind) => HEADLINES[kind] || 'Claude Burst';

// Every result: { kind, headline, detail (never empty), action: {kind,label}|null, actions[], chip, active, dimmed, ... }.
function statusView(d, { platform = process.platform, now = Date.now } = {}) {
  const v = statusViewInner(d, { platform, now });
  if (v.kind !== 'unsupported' && v.kind !== 'checking') v.headline = headlineFor(d && d.kind === 'unreachable' && v.kind === 'off' ? 'unreachable' : v.kind);
  if (!('action' in v)) v.action = v.kind === 'on' ? (v.updateAvailable ? { kind: 'update', label: 'Update' } : null) : firstAction(v.actions);
  if (!v.detail) v.detail = 'Burst state is not known yet.';
  if (typeof v.active !== 'boolean') v.active = false;
  if (typeof v.dimmed !== 'boolean') v.dimmed = false;
  return v;
}

function statusViewInner(d, { platform, now }) {
  if (platform !== 'darwin' || d.kind === 'unsupported') {
    return { kind: 'unsupported', headline: 'Claude Burst', detail: MAC_ONLY, chip: null, actions: [], version: '', mode: '', route: '', updateAvailable: false, compaction: null };
  }
  const base = { kind: d.kind, compaction: null, chip: chipFor(d), version: '', mode: '', route: '', updateAvailable: false, actions: [], headline: 'Claude Burst', detail: '' };
  switch (d.kind) {
    case 'not_installed':
      return { ...base, kind: 'not_installed', detail: 'Not installed. Burst keeps Claude Code working through limits by sending overflow to a provider you pay for.', actions: [A('install', 'Turn on Burst…', { primary: true, modes: ['base-url', 'transparent'] })] };
    case 'checking':
      return { ...base, kind: 'checking', detail: 'Checking whether Claude Burst is running…' };
    case 'unreachable': {
      const lg = d.lastGood && d.lastGood.state && typeof d.lastGood.state === 'object' ? d.lastGood : null;
      if (lg) {
        // The gateway stopped answering after it had answered: show what it last said, dimmed, as Burst's own dashboard does.
        const ls = lg.state;
        const age = ageText(now() - (Number.isFinite(lg.at) ? lg.at : now()));
        return { ...base, kind: 'gateway_stale', dimmed: true, chip: { tone: 'amber', label: 'Not responding' }, version: ls.version || '', mode: ls.mode || '', route: ls.route || '', active: ls.active === true,
          detail: `Not responding: Burst's gateway stopped answering. Showing the last known state from ${age}: ${ls.active ? 'on' : 'off'}${ls.mode ? `, ${ls.mode} mode` : ''}${ls.version ? `, version ${ls.version}` : ''}. Repair restarts it in the mode it was in.`,
          actions: [A('retry', 'Check again'), A('repair', 'Repair', { primary: true }), A('off', 'Turn Burst off')] };
      }
      return (d.misses || 0) < RETRY_BEFORE_REPAIR
        ? { ...base, kind: 'off', detail: 'Not responding: Burst is installed but its gateway did not answer just now. A busy or restarting gateway usually answers on the next check.', actions: [A('retry', 'Check again', { primary: true })] }
        : { ...base, kind: 'off', detail: 'Not responding: Burst is installed but its gateway has not answered several checks in a row. If Claude Code is failing, take Burst out of its path.', actions: [A('retry', 'Check again'), A('enable', 'Turn on', { primary: true }), A('repair', 'Repair'), A('off', 'Turn Burst off'), A('uninstall', 'Uninstall…')] };
    }    case 'untrusted':
      return { ...base, detail: `${d.reason} Plexiform read nothing from it. This usually means Burst was installed somewhere other than ~/.local/bin/claude-burst, or another program is using Burst\'s port.`, actions: [A('off', 'Turn Burst off'), A('uninstall', 'Uninstall…')] };
    case 'broken':
      return { ...base, kind: 'broken', version: d.state.version, detail: 'Burst\'s configuration could not be read, so it is not working.', actions: [A('repair', 'Repair', { primary: true }), A('off', 'Turn Burst off'), A('uninstall', 'Uninstall…')] };
    case 'present': {
      const s = d.state;
      const updateAvailable = !!(d.upgrade && d.upgrade.canUpgrade && !d.upgrade.upToDate);
      const pl = s.compaction && s.compaction.pauseless;
      const out = { ...base, version: s.version, mode: s.mode, route: s.route, updateAvailable, canOpenDashboard: true, compaction: pl || null, active: s.active === true };
      if (pl && pl.enabled && out.chip) out.chip = { ...out.chip, tag: 'Compaction on' };
      const attention = { tone: 'amber', label: 'Needs attention' };
      if (!atLeast(s.version, MIN_VERSION)) {
        const can = !d.upgrade || d.upgrade.canUpgrade !== false;
        return { ...out, kind: 'too_old', chip: { tone: 'amber', label: 'Update needed' }, canOpenDashboard: false,
          detail: `Burst ${s.version} is older than ${MIN_VERSION.join('.')}, so Plexiform can only see whether it is running. ${can ? 'Update it and the rest appears.' : 'Burst can\'t update itself here (it found no copy of its source next to it), so update it the way you installed it.'}`,
          action: can ? { kind: 'update', label: 'Update Burst' } : { kind: 'off', label: 'Turn Burst off' },
          actions: [...(can ? [A('update', 'Update Burst', { primary: true })] : []), A('off', 'Turn Burst off'), A('uninstall', 'Uninstall…')] };
      }
      if (s.mode === 'transparent' && s.caTrusted === false) {
        return { ...out, kind: 'ca_untrusted', chip: attention, detail: 'Transparent mode is on, but this Mac does not trust Burst\'s certificate for api.anthropic.com, so Claude Code\'s requests fail the TLS check. Repair re-trusts it (macOS asks for your Mac password in Terminal).',
          actions: [A('repair', 'Repair', { primary: true }), A('off', 'Turn Burst off')] };
      }
      if (s.mode === 'transparent' && s.hostsEntry === false) {
        return { ...out, kind: 'hosts_missing', chip: attention, detail: 'Transparent mode is on, but the /etc/hosts entry that sends api.anthropic.com to Burst is missing, so Claude Code goes straight to Anthropic and Burst sees nothing. Repair puts it back (macOS asks for your Mac password in Terminal).',
          actions: [A('repair', 'Repair', { primary: true }), A('off', 'Turn Burst off')] };
      }
      if (d.console && d.console.kind === 'unreachable') {
        return { ...out, kind: 'console_down', chip: attention, detail: `Burst is ${s.active ? 'on' : 'installed'} and its gateway answers, but its support console (the part that repairs and restarts it) is not answering. Start the console so repairs and health checks work again.`,
          actions: [A('console-restart', 'Start console', { primary: true }), A('repair', 'Repair'), A('off', 'Turn Burst off')] };
      }
      if (s.active) {
        out.kind = 'on';
        out.detail = `On, ${s.mode} mode, version ${s.version}. Route: ${s.route === 'SECONDARY' ? 'secondary' : 'primary'}.`;
        out.actions = [A('off', 'Turn Burst off', { primary: true }), ...(updateAvailable ? [A('update', 'Update')] : []), A('open-dashboard', 'Open dashboard'), A('open-browser', 'Open dashboard in browser'), A('uninstall', 'Uninstall…')];
      } else {
        out.kind = 'off';
        out.detail = s.inactiveReason || 'Installed, and not in Claude Code\'s path.';
        out.actions = [A('enable', 'Turn on', { primary: true }), ...(updateAvailable ? [A('update', 'Update')] : []), A('open-dashboard', 'Open dashboard'), A('open-browser', 'Open dashboard in browser'), A('uninstall', 'Uninstall…')];
      }
      return out;
    }
    default:
      return { ...base, kind: 'untrusted', chip: chipFor({ kind: 'untrusted' }), detail: 'Unknown Burst state.' };
  }
}

// ── The Burst card's extra rows (B4): keep-awake, Remote Control, mods ──────
// Each is null when the running Burst lacks the capability or the read failed, so the
// card never shows an empty row. `mac` is the scrubbed /api/mac answer, `modStatus` the
// scrubbed /api/mod-status answer; the card only emits actions, burst-ipc runs them.
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

function keepAwakeView(mac) {
  const ka = obj(mac) && obj(mac.keep_awake);
  if (!ka) return null;
  const mode = typeof ka.mode === 'string' && ka.mode ? ka.mode : 'off';
  const live = obj(ka.live) || {};
  const on = mode !== 'off';
  const held = live.sleep_disabled === true;
  const label = on ? (mode === 'always' ? 'On: plugged in and on battery' : 'On: plugged in only') : 'Off';
  const text = on
    ? `Burst keeps this Mac awake while AI is working${mode === 'always' ? ', on battery too' : ' when it is plugged in'}. Right now the Mac ${held ? 'stays awake with the lid shut' : 'would sleep with the lid shut'}.`
    : `Burst is not keeping this Mac awake: a closed lid ${held ? 'is held open by another program right now' : 'puts it to sleep, which stops running sessions'}.`;
  return { mode, on, held, label, text };
}

function remoteControlView(state) {
  const s = obj(state);
  if (!s || typeof s.remoteControlExpected !== 'boolean') return null;
  const expected = s.remoteControlExpected;
  const transparent = s.mode === 'transparent';
  return {
    expected,
    label: expected ? 'Expected to work' : 'Off while Burst is on',
    text: expected
      ? `Claude Code's Remote Control keeps working${transparent ? ': Burst is in transparent mode' : ''}.`
      : 'Claude Code\'s Remote Control is off while Burst is in base-URL mode. Reinstall Burst in transparent mode to have both.',
  };
}

// One row per mod Burst knows: the session mod (burst-session, from /api/mod-status) and the
// usage panel (claude-code-cost-sidebar, from /api/mac.panel). action.kind is mod-install or
// mod-update with the mod's id in args; burst-ipc maps those to /api/mod-action and /api/panel-install.
function modsView({ modStatus, mac } = {}) {
  const rows = [];
  const ms = obj(modStatus);
  if (ms) {
    const installed = ms.installed === true, current = ms.current === true, supported = ms.supported !== false;
    const version = typeof ms.version === 'string' ? ms.version : '';
    rows.push({
      id: 'burst-session', name: 'Burst session mod', what: 'Shows Burst\'s route and limits inside Claude Code, and tells Burst when a session compacts.',
      installed, current, version, supported,
      status: !supported ? `Not supported by Claude Code ${typeof ms.claude === 'string' && ms.claude ? ms.claude : 'this version'}` : !installed ? 'Not installed' : current ? `Installed, version ${version || 'unknown'}, up to date` : `Installed, version ${version || 'unknown'}, update available`,
      action: !supported ? null : !installed ? { kind: 'mod-install', label: 'Install', args: { mod: 'burst-session' } } : !current ? { kind: 'mod-update', label: 'Update', args: { mod: 'burst-session' } } : null,
    });
  }
  const panel = obj(mac) && obj(mac.panel);
  if (panel) {
    const installed = panel.installed === true;
    rows.push({
      id: 'usage-panel', name: 'Usage panel (cost sidebar)', what: 'Andrew\'s cost sidebar: spend, tokens and alerts next to each Claude Code session.',
      installed, current: installed, version: '', supported: true,
      status: !installed ? 'Not installed' : panel.running === true ? 'Installed and running' : 'Installed, not running',
      action: installed ? null : { kind: 'mod-install', label: 'Install', args: { mod: 'usage-panel' } },
    });
  }
  return rows.length ? rows : null;
}

/**
 * cardView(d, {platform, now, mac, modStatus}) → statusView(d) plus keepAwake, remoteControl, mods
 * (each null when hidden). Reads are gated on d.capabilities so a 0.19 Burst shows the plain card.
 */
// `view` lets the caller pass a statusView it already built with extra inputs (burst-ipc's viewOf
// adds lastGood for gateway_stale and the console probe for console_down); the card then keeps those states.
function cardView(d, { platform = process.platform, now = Date.now, mac = null, modStatus = null, view = null } = {}) {
  const v = view && typeof view === 'object' ? { ...view } : statusView(d, { platform, now });
  const caps = (d && d.kind === 'present' && obj(d.capabilities)) || {};
  v.keepAwake = caps.keepAwake === true ? keepAwakeView(mac) : null;
  // Remote Control is only known on a 0.20 Burst that is on (0.19 and an off/unknown mode read nothing).
  v.remoteControl = caps.remoteControl === true && d.state && d.state.active === true && (d.state.mode === 'transparent' || d.state.mode === 'base-url') ? remoteControlView(d.state) : null;
  v.mods = caps.mods === true ? modsView({ modStatus, mac }) : null;
  return v;
}

module.exports = { HEADLINES, headlineFor, cardView, keepAwakeView, remoteControlView, modsView, MIN_VERSION, ageText, RETRY_BEFORE_REPAIR, COMPACTION_ON_CONFIRM, COMPACTION_OWN_OFF, statusView, consent, chipFor, MAC_ONLY, TERMS_URL, CHANGES_ALWAYS, CHANGES_TRANSPARENT, TERMS };
