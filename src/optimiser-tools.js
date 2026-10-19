'use strict';
// The Usage optimiser's tool list: what each cost tool does, whether it is on
// here, what it has saved (only figures the tool itself reported) and the one
// action that turns it on. Pure; loaded by Node (main, tests) and as a plain
// script by optimiser.html.
(function (root) {
  const MAC_ONLY = 'macOS only. Not available on Windows or Linux.';
  const BY_BURST = 'Andrew Baker';
  const BY_US = 'Built into Plexiform';
  const usd = (n) => (n >= 0.01 ? `$${n.toFixed(2)}` : '<$0.01');
  const tokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const st = (tone, label) => ({ tone, label });
  const act = (kind, label, primary = false) => ({ kind, label, ...(primary ? { primary: true } : {}) });

  // Burst's /api/mod-status, reduced to what the band row shows.
  // raw: /api/mac.panel (the usage panel, claude-code-cost-sidebar). → facts only.
  function panelStatus(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return { installed: raw.installed === true };
  }

  function bandStatus(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return { supported: raw.supported === true, installed: raw.installed === true, current: raw.current === true, toasts: raw.toasts === true };
  }

  // b: the burst:tools facts. → the Claude Burst row.
  function burstTool(b) {
    const base = { id: 'burst', name: 'Claude Burst', by: BY_BURST, what: 'A local gateway for Claude Code. When your plan hits its limit it tries other Claude models on your plan, then a provider you choose and pay for, so work keeps going.', saves: null, actions: [], link: 'burst' };
    switch (b.kind) {
      case 'unsupported': return { ...base, status: st('', MAC_ONLY), available: false };
      case 'checking': return { ...base, status: st('', 'Checking…') };
      case 'not_installed': return { ...base, status: st('', 'Not installed'), actions: [act('burst:install', 'Turn on Burst…', true)] };
      case 'on': return { ...base, status: st('green', b.version ? `On, version ${b.version}` : 'On'), actions: [act('tab:dashboard', 'Open dashboard', true), ...(b.updateAvailable ? [act('burst:update', 'Update')] : []), act('burst:off', 'Turn Burst off')] };
      case 'off': return b.detected === 'present'
        ? { ...base, status: st('amber', 'Off'), actions: [act('burst:enable', 'Turn on', true), ...(b.updateAvailable ? [act('burst:update', 'Update')] : [])] }
        : (b.misses || 0) < 3
          ? { ...base, status: st('amber', 'Not responding'), note: 'Its gateway did not answer just now. This page checks again on its own.' }
          : { ...base, status: st('red', 'Not responding'), actions: [act('burst:repair', 'Repair', true), act('burst:enable', 'Turn on'), act('burst:off', 'Turn Burst off')] };
      case 'broken': return { ...base, status: st('red', 'Needs repair'), actions: [act('burst:repair', 'Repair', true), act('burst:off', 'Turn Burst off')] };
      default: return { ...base, status: st('red', 'Untrusted, nothing read'), actions: [act('burst:off', 'Turn Burst off')] };
    }
  }

  function routingTool(b) {
    const base = { id: 'routing', name: 'Routing and failover', by: BY_BURST, what: 'Part of Burst. Watches each model\'s limit, falls back along a chain (for example Opus to Sonnet), and sends overflow to your backup provider only when your plan is out.', saves: null, actions: [] };
    if (b.kind === 'unsupported') return { ...base, status: st('', MAC_ONLY), available: false };
    if (b.kind !== 'on') return { ...base, status: st('', 'Needs Claude Burst'), note: 'Turn on Claude Burst above to use it.' };
    if (b.route === 'SECONDARY') return { ...base, status: st('amber', 'Using your backup now'), actions: [act('section:sec-config', 'See routing in dashboard', true)] };
    if (b.secondaryReady === false) return { ...base, status: st('amber', 'On, no backup ready'), note: 'No backup provider is ready (none is set up, or its key or sign-in is missing), so Burst only falls back between Claude models.', actions: [act('section:secondarySection', 'Add a backup provider in dashboard', true)] };
    return { ...base, status: st('green', 'On, using your plan'), actions: [act('section:sec-config', 'See routing in dashboard', true)] };
  }

  function compactionTool(b) {
    const base = { id: 'compaction', name: 'Pauseless compaction', by: BY_BURST, what: 'Part of Burst. Summarises the old part of a long session in the background and swaps it in, so the session never stops to compact and resends fewer tokens.', saves: null, actions: [] };
    if (b.kind === 'unsupported') return { ...base, status: st('', MAC_ONLY), available: false };
    const c = b.kind === 'on' ? b.compaction : null;
    if (!c) return { ...base, status: st('', b.kind === 'on' ? 'Not offered by this Burst' : 'Needs Claude Burst'), ...(b.kind === 'on' ? {} : { note: 'Turn on Claude Burst above to use it.' }) };
    const n = num(c.compactions);
    const losing = typeof c.netUsd === 'number' && c.netUsd < 0;
    const money = typeof c.moneyText === 'string' && c.moneyText ? c.moneyText : `About ${usd(num(c.savedUsd))} of tokens not resent, before the cost of writing the summaries.`;
    const saves = n > 0 ? { text: `${n} compaction${n === 1 ? '' : 's'}, ${tokens(num(c.tokensNotResent))} tokens not resent. ${money}`, source: 'Reported by Claude Burst, API-equivalent prices' } : null;
    const verdict = typeof b.compactionVerdict === 'string' && b.compactionVerdict ? `Burst's own verdict: ${b.compactionVerdict}.` : '';
    const smart = losing && c.mode !== 'intelligent' ? 'Smart mode learns per repository whether compaction pays and backs off where it does not.' : '';
    const note = [verdict, smart].filter(Boolean).join(' ') || undefined;
    const see = act('section:sec-compaction', 'See compaction in dashboard');
    return c.enabled
      ? { ...base, status: st(losing ? 'amber' : 'green', `On, ${c.thresholdLabel || 'Static'}`), saves, ...(note ? { note } : {}), actions: [act('compaction:off', 'Turn off'), see] }
      : { ...base, status: st('', 'Off'), saves, ...(note ? { note } : {}), actions: [act('compaction:on', 'Turn on', true), see] };
  }

  function bandTool(b) {
    const base = { id: 'band', name: 'burst-band', by: BY_BURST, what: 'A Claude Code mod that shows Burst\'s route, the context it really sends and its alerts inside the session, above the prompt.', saves: null, actions: [], link: 'burst' };
    if (b.kind === 'unsupported') return { ...base, status: st('', MAC_ONLY), available: false };
    if (b.kind !== 'on') return { ...base, status: st('', 'Comes with Claude Burst'), note: 'Burst\'s installer adds it.' };
    if (!b.band) return { ...base, status: st('', 'Unknown'), note: 'Burst did not say whether it is installed. Refresh to ask again.' };
    const m = b.band;
    if (!m.supported) return { ...base, status: st('', 'Needs a newer Claude Code') };
    if (!m.installed) return { ...base, status: st('', 'Not installed'), note: 'Repair Burst installs it: Terminal opens with the command, and nothing runs until you confirm.', actions: [act('burst:repair', 'Repair Burst…')] };
    if (!m.current) return { ...base, status: st('amber', 'Installed, out of date'), actions: [act('burst:update', 'Update Burst')] };
    return { ...base, status: st('green', m.toasts ? 'On, with alerts' : 'On') };
  }

  function panelTool(b) {
    const base = { id: 'panel', name: 'Usage panel', by: BY_BURST, what: 'A Claude Code mod that shows spend, context and Burst\'s state in a sidebar beside each session.', saves: null, actions: [], link: 'panel' };
    if (b.kind === 'unsupported') return { ...base, status: st('', MAC_ONLY), available: false };
    if (b.kind !== 'on') return { ...base, status: st('', 'Optional'), note: 'Burst\'s installer offers it at the end.' };
    // b.panel: panelStatus() from /api/mac.panel on a 0.20 Burst; null when Burst did not say.
    if (!b.panel) return { ...base, status: st('', 'Optional'), note: 'Burst did not say whether it is installed. Refresh to ask again.' };
    if (!b.panel.installed) return { ...base, status: st('', 'Not installed'), note: 'Burst installs and updates it; nothing runs until you confirm.', actions: [act('burst:panel-install', 'Install usage panel', true)] };
    return { ...base, status: st('green', 'Installed'), note: 'Opens as a sidebar in new Claude Code sessions. Burst updates it with its own updates.' };
  }

  function routerTool() {
    return { id: 'router', name: 'Session router', by: BY_US, what: 'Suggests the cheapest AI tool you have that should handle a request, from its length and wording, offline. When Burst says Claude is near its limit it suggests another AI. It never moves anything by itself.', status: st('green', 'On'), saves: null, actions: [act('open:overview', 'Open Overview')] };
  }

  // w: the cost-guard report's waste (null when the plan lacks it).
  function wasteTool(w) {
    const base = { id: 'waste', name: 'Waste finder', by: BY_US, what: 'Reads your Claude Code transcripts on this computer for the same file read again and again, the same failing call repeated, and Opus doing routine work Sonnet could do.', saves: null, actions: [act('open:usage', 'See findings')] };
    if (!w) return { ...base, status: st('', 'Not on your plan'), note: "The waste finder isn't part of your current plan.", actions: [] };
    const t = w.totals || {};
    const o = t.overkill || {};
    const days = num(w.days) || 7;
    const parts = [];
    if (num(o.high) > 0) parts.push(`${usd(num(o.low))} to ${usd(num(o.high))} of Opus turns could have run on Sonnet (${num(o.turns)} routine turns)`);
    if (num(t.reread)) parts.push(`${t.reread} repeated file read${t.reread === 1 ? '' : 's'}`);
    if (num(t.failloop)) parts.push(`${t.failloop} failing loop${t.failloop === 1 ? '' : 's'}`);
    const saves = parts.length ? { text: `Last ${days} days: ${parts.join('; ')}.`, source: `From ${num(w.files)} transcript${w.files === 1 ? '' : 's'} on this computer` } : null;
    return { ...base, status: st('green', parts.length ? 'On, found waste' : 'On, nothing found'), saves };
  }

  /** burst: the burst:tools facts ({kind:'unsupported'} off macOS); waste: report.waste or null. */
  function toolsView({ burst, waste = null } = {}) {
    const b = burst && typeof burst === 'object' ? burst : { kind: 'unsupported' };
    return {
      groups: [
        { id: 'burst', title: 'Claude Burst and its tools', by: BY_BURST, tools: [burstTool(b), routingTool(b), compactionTool(b), bandTool(b), panelTool(b)] },
        { id: 'plexiform', title: 'Built into Plexiform', by: BY_US, tools: [routerTool(), wasteTool(waste)] },
      ],
    };
  }

  // The only pages "Learn more" opens, by id; main never takes a URL from the page.
  const LINKS = Object.freeze({ burst: 'https://github.com/andrewbakercloudscale/claude-burst', panel: 'https://github.com/andrewbakercloudscale/claude-code-cost-sidebar' });
  const PAGES = Object.freeze(['overview', 'usage']);
  // Burst dashboard sections a card may jump to (claude-burst admin dashboard, v0.19 `.navlink` targets).
  const SECTIONS = Object.freeze(['sec-config', 'secondarySection', 'sec-compaction']);

  const api = { toolsView, bandStatus, panelStatus, MAC_ONLY, LINKS, PAGES, SECTIONS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformOptimiserTools = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
