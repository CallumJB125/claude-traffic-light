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
  function bandStatus(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return { supported: raw.supported === true, installed: raw.installed === true, current: raw.current === true, toasts: raw.toasts === true };
  }

  // b: the burst:tools facts. → the Claude Burst row.
  function burstTool(b) {
    const base = { id: 'burst', name: 'Claude Burst', by: BY_BURST, what: 'A local gateway for Claude Code. When your plan hits its limit it tries other Claude models on your plan, then a provider you choose and pay for, so work keeps going.', saves: null, actions: [], link: 'burst' };
    switch (b.kind) {
      case 'unsupported': return { ...base, status: st('', MAC_ONLY), available: false };
      case 'not_installed': return { ...base, status: st('', 'Not installed'), actions: [act('burst:install', 'Turn on Burst…', true)] };
      case 'on': return { ...base, status: st('green', b.version ? `On, version ${b.version}` : 'On'), actions: [act('tab:dashboard', 'Open dashboard', true), ...(b.updateAvailable ? [act('burst:update', 'Update')] : []), act('burst:off', 'Turn Burst off')] };
      case 'off': return b.detected === 'present'
        ? { ...base, status: st('amber', 'Installed, off'), actions: [act('burst:enable', 'Turn on', true), ...(b.updateAvailable ? [act('burst:update', 'Update')] : [])] }
        : { ...base, status: st('red', 'Installed, not answering'), actions: [act('burst:repair', 'Repair', true), act('burst:enable', 'Turn on'), act('burst:off', 'Turn Burst off')] };
      case 'broken': return { ...base, status: st('red', 'Needs repair'), actions: [act('burst:repair', 'Repair', true), act('burst:off', 'Turn Burst off')] };
      default: return { ...base, status: st('red', 'Untrusted, nothing read'), actions: [act('burst:off', 'Turn Burst off')] };
    }
  }

  function routingTool(b) {
    const base = { id: 'routing', name: 'Routing and failover', by: BY_BURST, what: 'Part of Burst. Watches each model\'s limit, falls back along a chain (for example Opus to Sonnet), and sends overflow to your backup provider only when your plan is out.', saves: null, actions: [] };
    if (b.kind === 'unsupported') return { ...base, status: st('', MAC_ONLY), available: false };
    if (b.kind !== 'on') return { ...base, status: st('', 'Needs Claude Burst'), note: 'Turn on Claude Burst above to use it.' };
    if (b.route === 'SECONDARY') return { ...base, status: st('amber', 'Using your backup now'), actions: [act('tab:route', 'See route', true)] };
    if (b.secondaryReady === false) return { ...base, status: st('amber', 'On, no backup provider'), note: 'Without a backup provider Burst only falls back between Claude models. Add one in the Burst dashboard.', actions: [act('tab:route', 'See route', true), act('tab:dashboard', 'Set up in dashboard')] };
    return { ...base, status: st('green', 'On, using your plan'), actions: [act('tab:route', 'See route', true)] };
  }

  function compactionTool(b) {
    const base = { id: 'compaction', name: 'Pauseless compaction', by: BY_BURST, what: 'Part of Burst. Summarises the old part of a long session in the background and swaps it in, so the session never stops to compact and resends fewer tokens.', saves: null, actions: [] };
    if (b.kind === 'unsupported') return { ...base, status: st('', MAC_ONLY), available: false };
    const c = b.kind === 'on' ? b.compaction : null;
    if (!c) return { ...base, status: st('', b.kind === 'on' ? 'Not offered by this Burst' : 'Needs Claude Burst'), ...(b.kind === 'on' ? {} : { note: 'Turn on Claude Burst above to use it.' }) };
    const n = num(c.compactions);
    const saves = n > 0 ? { text: `Saved about ${usd(num(c.savedUsd))} over ${n} compaction${n === 1 ? '' : 's'}, ${tokens(num(c.tokensNotResent))} tokens not resent.`, source: 'Reported by Claude Burst' } : null;
    return c.enabled
      ? { ...base, status: st('green', `On, ${c.thresholdLabel || 'Static'}`), saves, actions: [act('compaction:off', 'Turn off')] }
      : { ...base, status: st('', 'Off'), saves, actions: [act('compaction:on', 'Turn on', true)] };
  }

  function bandTool(b) {
    const base = { id: 'band', name: 'burst-band', by: BY_BURST, what: 'A Claude Code mod that shows Burst\'s route, the context it really sends and its alerts inside the session, above the prompt.', saves: null, actions: [], link: 'burst' };
    if (b.kind === 'unsupported') return { ...base, status: st('', MAC_ONLY), available: false };
    if (b.kind !== 'on' || !b.band) return { ...base, status: st('', 'Comes with Claude Burst'), note: 'Burst\'s installer adds it.' };
    const m = b.band;
    if (!m.supported) return { ...base, status: st('', 'Needs a newer Claude Code') };
    if (!m.installed) return { ...base, status: st('', 'Not installed'), note: 'Repair Burst to install it again.', actions: [act('burst:repair', 'Repair Burst')] };
    if (!m.current) return { ...base, status: st('amber', 'Installed, out of date'), actions: [act('burst:update', 'Update Burst')] };
    return { ...base, status: st('green', m.toasts ? 'On, with alerts' : 'On') };
  }

  function panelTool(b) {
    const base = { id: 'panel', name: 'Usage panel', by: BY_BURST, what: 'A Claude Code mod that shows spend, context and Burst\'s state in a sidebar beside each session.', saves: null, actions: [], link: 'panel' };
    if (b.kind === 'unsupported') return { ...base, status: st('', MAC_ONLY), available: false };
    return { ...base, status: st('', 'Optional'), note: 'Burst\'s installer offers it at the end. Plexiform cannot see whether it is installed.' };
  }

  function routerTool() {
    return { id: 'router', name: 'Session router', by: BY_US, what: 'Suggests the cheapest AI tool you have that should handle a request, from its length and wording, offline. When Burst says Claude is near its limit it suggests another AI. It never moves anything by itself.', status: st('green', 'On'), saves: null, actions: [act('open:overview', 'Open Overview')] };
  }

  // w: the cost-guard report's waste (null without Plexiform Plus).
  function wasteTool(w) {
    const base = { id: 'waste', name: 'Waste finder', by: BY_US, what: 'Reads your Claude Code transcripts on this computer for the same file read again and again, the same failing call repeated, and Opus doing routine work Sonnet could do.', saves: null, actions: [act('open:usage', 'See findings')] };
    if (!w) return { ...base, status: st('', 'Plexiform Plus'), note: 'Usage & cost shows the full list with Plus.' };
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

  const api = { toolsView, bandStatus, MAC_ONLY, LINKS, PAGES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformOptimiserTools = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
