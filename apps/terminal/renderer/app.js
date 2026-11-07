'use strict';

(() => {
  const api = window.terminal;
  const $ = id => document.getElementById(id);
  // Telemetry is untrusted text: it only ever reaches the DOM through textContent.
  const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, 2000);
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = clean(value);
    return node;
  };
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs) => { const node = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); return node; };
  const DASH = '—';
  const leaf = value => clean(value).replace(/\/+$/, '').split('/').pop() || clean(value) || 'Session';
  const KIND = { shell: 'Shell', claude: 'Claude', codex: 'Codex' };
  const PROVIDER = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', hermes: 'Hermes', any: 'any AI' };
  const running = session => session && session.state === 'running';
  const finite = value => Number.isFinite(value) && value >= 0;
  const money = usd => Number.isFinite(usd) ? `$${usd.toFixed(2)}` : DASH;
  function dur(ms) {
    if (!finite(ms)) return DASH;
    const m = Math.floor(ms / 60000);
    if (m < 1) return ms < 60000 && ms >= 1000 ? `${Math.floor(ms / 1000)}s` : 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }
  const ago = ms => { const d = dur(ms); return d === DASH ? DASH : d === 'now' ? 'just now' : `${d} ago`; };

  // Status: colour and shape are both distinct, and every indicator has a text label.
  const STATUS = {
    needs: { label: 'Needs you', group: 'needs' },
    stuck: { label: 'Failed', group: 'needs' },
    working: { label: 'Working', group: 'working' },
    live: { label: 'Process running', group: 'working' },
    check: { label: 'Finished its turn', group: 'idle' },
    exited: { label: 'Exited', group: 'idle' },
    idle: { label: 'Idle', group: 'idle' },
    shell: { label: 'Shell', group: 'idle' },
  };
  const GROUPS = [['needs', 'Needs you'], ['working', 'Working'], ['idle', 'Idle']];
  // Finished, idle and exited sessions fold into "Earlier today" once nothing has
  // happened for this long, so the list stays about what is live.
  const EARLIER_MS = 30 * 60000;
  const indicator = (status, extraClass = '') => {
    const node = el('span', `ind${extraClass ? ` ${extraClass}` : ''}`);
    node.dataset.s = STATUS[status] ? status : 'idle';
    node.setAttribute('role', 'img'); node.setAttribute('aria-label', STATUS[status]?.label || 'Idle');
    return node;
  };

  let snapshot = { sessions: [], rows: [], totals: null, bus: null, handoffs: [], notes: [], connected: null, at: Date.now() };
  let view = { name: 'overview' }, activeId = null, term = null, fitAddon = null, range = 30, boardFilter = null;
  const OPENED_AT = Date.now();
  let selecting = 0, spawning = false, fitFrame = 0, knownIds = null, items = [], earlierOpen = false;
  const detached = new Set();
  const since = ms => finite(ms) ? ms + (Date.now() - snapshot.at) : null;

  function notice(message) {
    $('notice-text').textContent = clean(typeof message === 'string' ? message : message?.message || message?.error || 'The operation could not be completed.');
    $('notice').hidden = false;
  }
  function checked(result) {
    if (result?.ok === false || result?.error) throw new Error(clean(result.message || result.error?.message || result.error || result.code || 'Operation failed'));
    return result;
  }
  const sessionById = id => snapshot.sessions.find(session => session.sessionId === id);

  // One list for the sidebar, palette, shortcuts, rail and overview: keeper tabs
  // (with their observed agent status when Plexiform links them) then external
  // sessions, which are read-only.
  function buildItems() {
    const linked = new Map();
    for (const row of snapshot.rows) if (typeof row.tabId === 'string') linked.set(row.tabId, row);
    const list = [];
    for (const session of snapshot.sessions) {
      const row = linked.get(session.sessionId) || null;
      const started = Date.parse(session.startedAt);
      const startedMs = Number.isFinite(started) ? Math.max(0, snapshot.at - started) : null;
      let status, doing;
      if (session.state === 'unknown') { status = 'idle'; doing = 'Session Keeper offline'; }
      else if (!running(session)) {
        status = 'exited';
        doing = Number.isSafeInteger(session.exit?.code) ? `Exited with code ${session.exit.code}` : 'Exited · output retained';
      } else if (row) { status = row.bucket || 'idle'; doing = row.doing; }
      else if (session.kind === 'shell') { status = 'shell'; doing = 'Interactive shell'; }
      else { status = 'live'; doing = 'Running · no agent status reported yet'; }
      list.push({
        key: `k:${session.sessionId}`, type: 'tab', session, row, status,
        tool: row?.tool || KIND[session.kind] || clean(session.kind) || 'Session', provider: row?.provider || session.kind,
        project: leaf(session.cwd), branch: row?.branch || session.branch || null,
        doing, waitingOn: row?.waitingOn || null,
        elapsed: row ? (row.bucket === 'working' ? row.working_ms ?? row.since_ms : row.since_ms) : startedMs,
        quietFor: row ? row.since_ms : running(session) ? 0 : startedMs,
        started: row?.started_ms ?? startedMs, cost: row?.cost?.usd, detached: detached.has(session.sessionId),
        failed: !running(session) && Number.isSafeInteger(session.exit?.code) && session.exit.code !== 0,
      });
    }
    for (const row of snapshot.rows) {
      if (typeof row.tabId === 'string' && sessionById(row.tabId)) continue;
      list.push({
        key: `o:${row.id}`, type: 'external', session: null, row, status: STATUS[row.bucket] ? row.bucket : 'idle',
        tool: row.tool || 'AI', provider: row.provider, project: row.project || 'Unknown folder', branch: row.branch || null,
        doing: row.doing, waitingOn: row.waitingOn || null,
        elapsed: row.bucket === 'working' ? row.working_ms ?? row.since_ms : row.since_ms, quietFor: row.since_ms,
        started: row.started_ms, cost: row.cost?.usd, detached: false, failed: false,
      });
    }
    for (const item of list) {
      const group = STATUS[item.status].group;
      // A running shell tab is yours and stays put; an exited tab or an agent
      // that went quiet folds away.
      item.group = group === 'idle' && item.status !== 'shell' && (item.status === 'exited' || (since(item.quietFor) ?? 0) > EARLIER_MS) ? 'earlier' : group;
    }
    const order = { needs: 0, working: 1, idle: 2, earlier: 3 };
    // Needs-you is a queue (longest wait first); Working keeps start order so
    // ⌘-number shortcuts move only when a session changes group; Idle and
    // Earlier show the most recent activity first.
    list.sort((a, b) => {
      if (a.group !== b.group) return order[a.group] - order[b.group];
      if (a.group === 'needs') return (b.elapsed ?? -1) - (a.elapsed ?? -1);
      if (a.group === 'working') return (b.started ?? -1) - (a.started ?? -1) || a.key.localeCompare(b.key);
      return (a.quietFor ?? Infinity) - (b.quietFor ?? Infinity) || a.key.localeCompare(b.key);
    });
    return list;
  }
  const itemByKey = key => items.find(item => item.key === key);
  const shortcutItems = () => items.filter(item => item.group !== 'earlier' || earlierOpen);
  const handoffsFor = item => item?.row?.handle ? (snapshot.handoffs || []).filter(h => h.from === item.row.handle || h.to === item.row.handle) : [];
  // A hand-off to "any" names the AI that actually ran it once the trace says so.
  const peerName = (handle, h, short = false) => {
    const row = handle ? snapshot.rows.find(r => r.handle === handle) : null;
    if (row) return short ? row.project : `${row.project} · ${row.tool}`;
    if (handle === 'any' && h?.provider) return `${PROVIDER[h.provider] || h.provider} (any AI)`;
    return PROVIDER[handle] || handle || 'another session';
  };

  // ---- Boards ------------------------------------------------------------
  // Team mode: any session routes to, or is held back from, a team board. A solo
  // person never sees board names or team reasons, only a session whose work
  // makes no card at all (excluded folder, cards off).
  const teamMode = () => snapshot.rows.some(row => row.board?.team || row.board?.pending);
  function boardOf(item) {
    const b = item?.row?.board;
    if (!b || typeof b !== 'object' || typeof b.name !== 'string') return null;
    if (!teamMode() && b.kind === 'personal') return null;
    return b;
  }
  function boardTag(item, cls) {
    const b = boardOf(item); if (!b) return null;
    const tag = el('span', `${cls} board-${b.kind}${b.pending ? ' pending' : ''}`);
    tag.append(el('span', 'board-name', b.name));
    if (b.short) tag.append(el('span', 'board-why', b.short));
    tag.title = [b.label, b.why].filter(Boolean).join(' · ');
    return tag;
  }
  const boardKey = item => { const b = item?.row?.board; return b?.kind === 'team' ? `team:${b.name}` : b?.kind === 'personal' ? 'mine' : 'none'; };

  // ---- Terminal ----------------------------------------------------------
  const theme = () => {
    const css = getComputedStyle(document.documentElement), v = name => css.getPropertyValue(name).trim();
    const light = matchMedia('(prefers-color-scheme: light)').matches;
    const ansi = light
      ? { black: '#1f2328', red: '#c4362c', green: '#1a7f4b', yellow: '#9a6700', blue: '#2259c9', magenta: '#8a3fb8', cyan: '#127a87', white: '#6e7781', brightBlack: '#57606a', brightRed: '#d9473d', brightGreen: '#1f9358', brightYellow: '#b07a00', brightBlue: '#3570e0', brightMagenta: '#9d50cf', brightCyan: '#1690a0', brightWhite: '#8c959f' }
      : { black: '#1c1e23', red: '#ec7b72', green: '#6cc596', yellow: '#e2b45f', blue: '#7fa8eb', magenta: '#c19be6', cyan: '#6cc4cf', white: '#cfd3da', brightBlack: '#5f6673', brightRed: '#ff978e', brightGreen: '#8ad9ad', brightYellow: '#f0cb85', brightBlue: '#9dbff5', brightMagenta: '#d4b6f2', brightCyan: '#8fd8e0', brightWhite: '#f4f5f7' };
    return { background: v('--terminal'), foreground: v('--term-fg'), cursor: v('--term-fg'), cursorAccent: v('--terminal'), selectionBackground: light ? '#b6cdf580' : '#3d5a8a99', ...ansi };
  };
  const terminalShown = () => view.name === 'session' && activeId && view.key === `k:${activeId}`;
  function scheduleFit() {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      if (!term || !fitAddon || $('terminal').hidden || $('terminal-view').hidden || $('session-view').hidden || document.hidden) return;
      try { fitAddon.fit(); } catch { return; }
      renderStatusline();
      if (activeId) void api.resize({ sessionId: activeId, cols: term.cols, rows: term.rows }).catch(error => notice(error.message));
    });
  }
  function disposeTerminal() {
    term?.dispose(); term = null; fitAddon = null;
    $('terminal').replaceChildren();
  }
  function createTerminal() {
    disposeTerminal();
    term = new Terminal({ fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.3, letterSpacing: 0, scrollback: 5000, cursorBlink: false, cursorStyle: 'bar', cursorWidth: 2, allowProposedApi: false, allowTransparency: false, convertEol: false, theme: theme(), windowOptions: {} });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    // Keeper owns terminal query replies. Replay must never generate session input.
    for (const identifier of [{ final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' }, { final: 'n' }, { prefix: '?', final: 'n' }, { final: 't' }, { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }]) term.parser.registerCsiHandler(identifier, () => true);
    for (const identifier of [{ intermediates: '$', final: 'q' }, { intermediates: '+', final: 'q' }]) term.parser.registerDcsHandler(identifier, () => true);
    // Title, colour-query, hyperlink and clipboard escapes are swallowed.
    for (const command of [0, 1, 2, 4, 8, 10, 11, 12, 52]) term.parser.registerOscHandler(command, () => true);
    term.options.linkHandler = { activate() {}, hover() {}, leave() {} };
    term.open($('terminal'));
    term.onData(data => {
      // Focus-report mode may be present in a replay. It never grants input.
      if (data === '\u001b[I' || data === '\u001b[O' || !activeId || !terminalShown() || !document.hasFocus() || !running(sessionById(activeId))) return;
      void api.write({ sessionId: activeId, data }).then(checked).catch(error => notice(error.message));
    });
    scheduleFit();
  }
  let connection = '';
  async function openTab(sessionId, { focus = true } = {}) {
    const session = sessionById(sessionId);
    if (!session) return;
    detached.delete(sessionId);
    if (activeId === sessionId && term) { show({ name: 'session', key: `k:${sessionId}` }); scheduleFit(); if (focus) term.focus(); return; }
    const selection = ++selecting;
    activeId = sessionId; show({ name: 'session', key: `k:${sessionId}` });
    $('terminal').hidden = false;
    createTerminal(); render();
    connection = 'Attaching…'; renderStatusline();
    try {
      checked(await api.select(sessionId));
      if (selection !== selecting || activeId !== sessionId) return;
      connectionText();
      scheduleFit();
      if (focus) term?.focus();
    } catch (error) {
      if (selection !== selecting) return;
      connection = 'Session unavailable'; renderStatusline(); notice(error.message);
    }
  }
  function closeTerminal() {
    ++selecting; activeId = null; disposeTerminal(); $('terminal').hidden = true;
  }
  function connectionText() {
    const session = sessionById(activeId);
    if (!session) return;
    connection = snapshot.connected === false ? 'Keeper offline · output may be stale' : running(session) ? 'Attached' : 'Exited · output retained';
    renderStatusline();
  }

  // ---- Navigation --------------------------------------------------------
  function show(next) {
    view = next;
    $('overview-view').hidden = view.name !== 'overview';
    $('session-view').hidden = view.name !== 'session';
    if (view.name === 'overview') $('nav-overview').setAttribute('aria-current', 'page'); else $('nav-overview').removeAttribute('aria-current');
    render();
    if (terminalShown()) scheduleFit();
  }
  function open(item, options) {
    if (!item) return;
    if (item.group === 'earlier' && !earlierOpen) earlierOpen = true;
    if (item.type === 'tab') void openTab(item.session.sessionId, options);
    else { show({ name: 'session', key: item.key }); $('detail-view').scrollTop = 0; }
  }
  const currentKey = () => view.name === 'session' ? view.key : null;
  function nextNeeds() {
    const queue = items.filter(item => item.group === 'needs');
    if (!queue.length) return;
    const at = queue.findIndex(item => item.key === currentKey());
    open(queue[(at + 1) % queue.length]);
  }

  // ---- Sidebar -----------------------------------------------------------
  function sessionRow(item, number) {
    const row = el('button', `srow${item.detached ? ' detached' : ''}`);
    row.dataset.key = item.key;
    if (item.type === 'tab') row.dataset.tabId = item.session.sessionId;
    if (item.key === currentKey()) row.setAttribute('aria-current', 'true');
    row.title = item.type === 'external' ? `${item.tool} in ${item.project}${item.row?.hostApp ? ` (${item.row.hostApp})` : ''} · observed, read-only` : `${item.tool} in ${clean(item.session.cwd)}`;
    const main = el('span', 'srow-main');
    const top = el('span', 'srow-top');
    top.append(el('span', 'srow-title', item.project), el('span', 'srow-time', dur(since(item.elapsed))));
    if (number && number <= 9) top.append(el('kbd', 'srow-kbd', `⌘${number}`));
    const doing = el('span', 'srow-doing');
    doing.append(el('span', 'tool', item.tool), el('span', 'tool', '·'), el('span', 'what', item.detached ? `Detached · ${item.doing}` : item.waitingOn || item.doing));
    const subs = item.row?.subagents;
    if (subs?.running) doing.append(el('span', 'srow-agents', `+${subs.running}`));
    main.append(top, doing);
    const board = boardTag(item, 'srow-board');
    if (board) main.append(board);
    row.append(indicator(item.status), main);
    if (item.type === 'external') row.append(el('span', 'srow-ext', '↗'));
    row.addEventListener('click', () => open(item));
    return row;
  }
  function renderSidebar() {
    const list = $('session-list'), focusedKey = document.activeElement?.closest?.('#session-list [data-key]')?.dataset.key;
    const fragment = document.createDocumentFragment();
    let number = 0;
    for (const [group, title] of GROUPS) {
      const members = items.filter(item => item.group === group);
      if (!members.length) continue;
      const section = el('section', `group group-${group}`);
      const head = el('h3', 'group-head');
      head.append(el('span', '', title), el('span', 'group-count', members.length));
      section.append(head);
      for (const item of members) section.append(sessionRow(item, ++number));
      fragment.append(section);
    }
    const earlier = items.filter(item => item.group === 'earlier');
    if (earlier.length) {
      const details = el('details', 'earlier');
      details.open = earlierOpen;
      const summary = el('summary', '');
      const counts = new Map();
      for (const item of earlier) counts.set(item.tool, (counts.get(item.tool) || 0) + 1);
      const [topTool, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0];
      const failed = earlier.filter(item => item.failed).length;
      summary.append(el('span', '', 'Earlier today'), el('span', 'earlier-meta', `${earlier.length} · ${counts.size === 1 ? topTool : `${topCount} ${topTool}`}`));
      if (failed) summary.append(el('span', 'earlier-failed', `· ${failed} failed`));
      details.append(summary);
      for (const item of earlier) details.append(sessionRow(item, earlierOpen ? ++number : 0));
      details.addEventListener('toggle', () => { if (earlierOpen !== details.open) { earlierOpen = details.open; render(); } });
      fragment.append(details);
    }
    if (!items.length) {
      const empty = el('div', 'side-empty');
      empty.append(el('p', 'side-empty-title', 'No sessions yet'), el('p', '', 'Start a shell, Claude or Codex below. Agents running in other apps appear here when Plexiform reports them.'));
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    if (focusedKey) list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
    const needs = items.filter(item => item.group === 'needs');
    $('next-needs').hidden = !needs.length;
    $('next-needs-label').textContent = needs.length === 1 ? '1 needs you' : `${needs.length} need you`;
    $('overview-count').textContent = items.filter(item => item.group !== 'earlier').length || '';
    const connected = snapshot.connected;
    $('keeper-dot').dataset.state = connected === true ? 'on' : connected === false ? 'off' : 'wait';
    $('keeper-state').textContent = connected === true ? 'Session Keeper connected' : connected === false ? 'Session Keeper offline' : 'Connecting to Session Keeper…';
    $('reconnect').hidden = connected !== false;
    const bus = snapshot.bus;
    $('bus-state').hidden = !bus;
    if (bus) {
      $('bus-dot').dataset.state = bus.enabled && bus.halted !== true ? 'on' : 'off';
      $('bus-text').textContent = !bus.enabled ? 'Agent bus off' : bus.halted === true ? 'Agent bus paused' : `Agent bus · ${bus.peers} ${bus.peers === 1 ? 'peer' : 'peers'}`;
    }
  }

  // ---- Hand-off card -----------------------------------------------------
  const HANDOFF_STATE = { sent: ['Sent', ''], claimed: ['Claimed', ''], running: ['Running', 'ok'], blocked: ['Blocked', 'warn'], succeeded: ['Succeeded', 'ok'], failed: ['Failed', 'bad'], ended: ['Ended', ''] };
  const IN_FLIGHT = new Set(['sent', 'claimed', 'running', 'blocked']);
  function handoffCard(h, perspective) {
    const card = el('article', 'hcard');
    const head = el('div', 'hcard-head');
    const outgoing = perspective ? h.from === perspective : true;
    const [label, tone] = HANDOFF_STATE[h.state] || ['Sent', ''];
    if (perspective) head.append(el('span', 'hcard-arrow', outgoing ? '→' : '←'), el('span', 'hcard-peer', outgoing ? peerName(h.to, h) : peerName(h.from, h)));
    else head.append(el('span', 'hcard-peer', peerName(h.from, h, true)), el('span', 'hcard-arrow', '→'), el('span', 'hcard-peer', peerName(h.to, h, true)));
    head.append(el('span', `chip hcard-state${tone ? ` ${tone}` : ''}`, label));
    card.append(head);
    const steps = el('div', 'steps');
    for (const s of h.steps) { const step = el('div', `step ${s.state}`); step.append(el('span', '', s.label)); steps.append(step); }
    card.append(steps);
    if (h.fallback) card.append(el('div', 'hcard-chain', 'Fallback · the AI before it could not run this'));
    else if (h.after) card.append(el('div', 'hcard-chain', 'Follow-on in the same piece of work'));
    if (h.reason) card.append(el('div', 'hcard-reason', h.reason));
    card.append(el('div', 'hcard-foot', `Brief not shown · ${ago(since(h.ago_ms))}`));
    return card;
  }

  // ---- Overview: swimlanes -----------------------------------------------
  const SEG_TEXT = { working: 'Working', needs: 'Needs you', stuck: 'Failed', check: 'Finished', idle: 'Idle' };
  function laneSegments(item) {
    const max = range * 60000;
    if (item.row?.lane?.length) return item.row.lane.filter(s => s.end_ms < max);
    // A tab with no hook report: time before this window opened is unseen, the rest says what is known.
    if (item.type === 'tab' && running(item.session) && finite(item.started)) {
      const opened = Math.max(0, Date.now() - OPENED_AT), split = Math.min(item.started, opened);
      return [
        ...(item.started > opened ? [{ start_ms: item.started, end_ms: split, bucket: 'unseen' }] : []),
        { start_ms: split, end_ms: 0, bucket: 'idle', text: item.status === 'shell' ? 'Shell' : 'No agent status reported' },
      ];
    }
    return [];
  }
  const pct = ms => `${Math.max(0, Math.min(100, (1 - ms / (range * 60000)) * 100))}%`;
  function segment(state, start, end, label, short) {
    const seg = el('span', 'seg');
    seg.dataset.s = state;
    seg.style.left = pct(start); seg.style.right = `${100 - parseFloat(pct(end))}%`;
    seg.title = label || '';
    // The label is fitted after layout (fitLabels): full text, else the state's
    // short name, else none; a clipped word is never shown.
    if (label && state !== 'unseen' && (start - end) / (range * 60000) >= 0.03) {
      const text = el('span', 'seg-label', label);
      if (short && short !== label) text.dataset.short = short;
      seg.append(text);
    }
    return seg;
  }
  function fitLabels() {
    const labels = [...$('lanes').querySelectorAll('.seg-label')];
    // Reads first, then writes, so thirty lanes cost one layout.
    const reset = labels.map(node => { const full = node.dataset.full ?? node.textContent; node.dataset.full = full; return [node, full]; });
    for (const [node, full] of reset) { node.textContent = full; node.hidden = false; }
    const fits = node => node.scrollWidth <= node.clientWidth + 0.5;
    const first = reset.map(([node]) => fits(node));
    reset.forEach(([node], i) => { if (!first[i]) { if (node.dataset.short) node.textContent = node.dataset.short; else node.hidden = true; } });
    const second = reset.map(([node], i) => first[i] || node.hidden || fits(node));
    reset.forEach(([node], i) => { if (!second[i]) node.hidden = true; });
  }
  function renderOverview() {
    const max = range * 60000;
    const live = items.filter(item => item.group !== 'earlier');
    const queue = items.filter(item => item.group === 'needs');
    const working = items.filter(item => item.group === 'working').length;
    const flight = (snapshot.handoffs || []).filter(h => IN_FLIGHT.has(h.state)).length;
    const totals = snapshot.totals;
    $('overview-summary').textContent = `${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · what every session did in the last ${range} minutes`;
    const stat = (value, label, tone) => { const s = el('div', `stat${tone ? ` tone-${tone}` : ''}`); s.append(el('span', 'stat-value', value), el('span', 'stat-label', label)); return s; };
    const stats = [stat(String(queue.length), 'need you', queue.length ? 'needs' : ''), stat(String(working), 'working'), stat(String(live.length), live.length === 1 ? 'session' : 'sessions')];
    if (totals && Number.isFinite(totals.spendToday)) stats.push(stat(money(totals.spendToday), 'Claude spend today'));
    if (snapshot.bus) stats.push(stat(String(flight), flight === 1 ? 'hand-off in flight' : 'hand-offs in flight'));
    $('stats').replaceChildren(...stats);
    document.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === range)));

    const lanes = $('lanes'), frag = document.createDocumentFragment();
    // Lanes and filter buttons are rebuilt on every push; keep keyboard focus where it was.
    const focusLane = document.activeElement?.closest?.('#lanes button.lane-head')?.dataset.key;
    const focusFilter = document.activeElement?.closest?.('#board-filter .bf')?.dataset.key;
    const axis = el('div', 'axis'); axis.setAttribute('role', 'row');
    const axisTrack = el('div', 'axis-track');
    const step = range <= 30 ? 5 : 10;
    for (let m = range; m > 0; m -= step) { const t = el('span', 'axis-tick', `−${m}m`); t.style.left = pct(m * 60000); axisTrack.append(t); }
    const nowTick = el('span', 'axis-tick axis-now', 'now'); nowTick.style.left = '100%'; axisTrack.append(nowTick);
    axis.append(el('div', 'axis-label label', 'Session / agent'), axisTrack, el('div', 'axis-tail'));
    frag.append(axis);
    const laned = live.filter(item => item.row || (item.type === 'tab' && running(item.session)));
    renderBoardFilter(laned);
    const shown = boardFilter ? laned.filter(item => boardKey(item) === boardFilter) : laned;
    for (const item of shown) {
      const lane = el('div', `lane lane-${item.group}`); lane.setAttribute('role', 'row');
      if (item.row?.handle) lane.dataset.handle = item.row.handle;
      const head = el('button', 'lane-head'); head.dataset.key = item.key;
      const text = el('span', 'lane-text');
      text.append(el('span', 'lane-title', item.project), el('span', 'lane-sub', `${item.tool} · ${item.waitingOn || item.doing}`));
      const board = boardTag(item, 'lane-board');
      if (board) text.append(board);
      head.append(indicator(item.status), text);
      head.setAttribute('aria-label', [item.project, item.tool, STATUS[item.status].label, item.waitingOn || item.doing, boardOf(item)?.label].filter(Boolean).join(', '));
      head.addEventListener('click', () => open(item));
      const track = el('div', 'lane-track');
      for (const s of laneSegments(item)) track.append(segment(s.bucket, Math.min(s.start_ms, max), s.end_ms, s.bucket === 'unseen' ? 'Before this window opened' : s.text || SEG_TEXT[s.bucket], s.bucket === 'unseen' ? '' : SEG_TEXT[s.bucket]));
      lane.append(head, track, el('div', 'lane-tail', dur(since(item.elapsed))));
      frag.append(lane);
      for (const a of item.row?.subagents?.list || []) {
        const live = LIVE_SUB(a.status), end = live ? 0 : a.end_ms;
        if (!finite(end) || end >= max) continue;
        const sub = el('div', 'lane sub'); sub.setAttribute('role', 'row');
        const sh = el('div', 'lane-head');
        sh.append(indicator(SUB_STATE(a.status), 'small'), el('span', 'lane-title', a.name), el('span', 'lane-kind', a.kind));
        const strack = el('div', 'lane-track');
        // A finished agent whose start this window never saw is a mark at its end, not a guessed bar.
        const start = finite(a.start_ms) ? Math.min(a.start_ms, max) : end + max / 200;
        strack.append(segment(a.status === 'waiting' ? 'sub-waiting' : live ? 'sub-working' : a.status === 'failed' ? 'sub-failed' : 'sub-done', start, end, ''));
        // A waiting agent's wait is drawn over its run when known.
        if (a.status === 'waiting' && finite(a.wait_ms)) strack.append(segment('needs', Math.min(since(a.wait_ms), max), 0, ''));
        sub.append(sh, strack, el('div', 'lane-tail', a.status === 'waiting' ? (finite(a.wait_ms) ? dur(since(a.wait_ms)) : 'waiting') : live ? dur(since(a.start_ms)) : finite(a.start_ms) ? dur(a.start_ms - a.end_ms) : 'done'));
        frag.append(sub);
      }
    }
    if (!shown.length && boardFilter) frag.append(el('p', 'lanes-empty', 'No live sessions send work to this board.'));
    else if (!shown.length) {
      const empty = el('div', 'lanes-empty');
      empty.append(el('p', 'lanes-empty-title', 'Nothing running right now'), el('p', '', 'Start a shell, Claude or Codex from the sidebar (⌘T for a shell). Agents in other apps appear here when Plexiform’s hooks report them.'));
      frag.append(empty);
    }
    const folded = items.filter(item => item.group === 'earlier').length;
    if (folded) frag.append(el('p', 'lanes-note', `${folded} earlier ${folded === 1 ? 'session is' : 'sessions are'} folded in the sidebar.`));
    frag.append(el('p', 'lanes-note', 'Lanes show states Plexiform reported while this window was open; dotted time is before that. Subagents report start and finish only.'));
    lanes.replaceChildren(frag);
    if (focusLane) lanes.querySelector(`button.lane-head[data-key="${CSS.escape(focusLane)}"]`)?.focus();
    if (focusFilter) $('board-filter').querySelector(`.bf[data-key="${CSS.escape(focusFilter)}"]`)?.focus();
    const legend = [['working', 'Working'], ['needs', 'Needs you'], ['check', 'Finished'], ['idle', 'Idle'], ['stuck', 'Failed'], ['unseen', 'Not observed']].map(([s, label]) => {
      const span = el('span', ''), i = el('i', 'seg'); i.dataset.s = s; i.style.position = 'static'; span.append(i, document.createTextNode(label)); return span;
    });
    if (snapshot.bus || snapshot.handoffs?.length) {
      for (const [cls, label] of [['hand', 'Hand-off'], ['fallback', 'Fallback'], ['note', 'Note']]) { const span = el('span', ''), i = el('i', `lg-${cls}`); span.append(i, document.createTextNode(label)); legend.push(span); }
    }
    $('lanes-legend').replaceChildren(...legend);
    requestAnimationFrame(() => { fitLabels(); drawArrows(); });

    $('queue-count').textContent = queue.length || '';
    const q = document.createDocumentFragment();
    for (const item of queue) {
      const card = el('button', 'qrow');
      const head = el('div', 'qrow-head');
      head.append(indicator(item.status, 'small'), el('span', 'qrow-title', item.project), el('span', 'qrow-time', dur(since(item.elapsed))));
      card.append(head, el('div', 'qrow-wait', item.status === 'stuck' ? item.doing : item.waitingOn || item.doing),
        el('div', 'qrow-meta', item.type === 'external' ? `${item.tool} · answer in ${item.row?.hostApp || 'its own app'}` : `${item.tool} · in this terminal`));
      card.addEventListener('click', () => open(item));
      q.append(card);
    }
    if (!queue.length) q.append(el('p', 'empty-line', 'Nothing is waiting on you.'));
    $('queue').replaceChildren(q);
    const hs = [...(snapshot.handoffs || [])].reverse().slice(0, 8);
    $('handoff-count').textContent = hs.length || '';
    $('handoffs').replaceChildren(...(hs.length ? hs.map(h => handoffCard(h, null)) : [el('p', 'empty-line', snapshot.bus ? 'No hand-offs in the last two hours. When one AI hands work to another, it shows here and as an arrow between lanes.' : 'The agent bus is not reporting on this Mac.')]));
    const ns = snapshot.notes || [];
    $('notes-block').hidden = !ns.length;
    $('note-count').textContent = ns.length || '';
    $('notes').replaceChildren(...[...ns].reverse().slice(0, 6).map(n => {
      const row = el('div', 'nrow');
      row.append(el('span', 'nrow-peer', peerName(n.from, null, true)), el('span', 'hcard-arrow', '→'), el('span', 'nrow-peer', peerName(n.to, null, true)), el('span', 'nrow-time', ago(since(n.ago_ms))));
      return row;
    }));
  }
  // Teams: filter lanes by the board their work goes to. Solo: no control at all.
  function renderBoardFilter(laned) {
    const wrap = $('board-filter');
    if (!teamMode()) { wrap.hidden = true; boardFilter = null; return; }
    const counts = new Map();
    for (const item of laned) { const k = boardKey(item); counts.set(k, (counts.get(k) || 0) + 1); }
    if (boardFilter && !counts.has(boardFilter)) boardFilter = null;
    const name = k => k === 'mine' ? 'My board' : k === 'none' ? 'No board' : k.slice(5);
    const keys = [...counts.keys()].sort((a, b) => (a.startsWith('team:') ? 0 : a === 'mine' ? 1 : 2) - (b.startsWith('team:') ? 0 : b === 'mine' ? 1 : 2) || a.localeCompare(b));
    const button = (key, label, n) => {
      const b = el('button', 'bf'); b.dataset.key = key ?? 'all'; b.setAttribute('aria-pressed', String(boardFilter === key));
      b.append(el('span', 'bf-name', label)); if (n !== null) b.append(el('span', 'bf-count', n));
      b.addEventListener('click', () => { boardFilter = key; render(); });
      return b;
    };
    wrap.hidden = false;
    wrap.replaceChildren(button(null, 'All boards', null), ...keys.map(k => button(k, name(k), counts.get(k))));
  }
  // Hand-off arrows: from the sender's lane to the receiver's lane at the moment
  // it was sent; a run with no lane of its own (a fresh headless run) gets a
  // label that turns inward at the track's edges. A fallback (the bus re-posting
  // a failed run to the next AI) is a dashed link from the failed run's mark; a
  // note is a dotted line ending in a small square.
  function drawArrows() {
    const lanes = $('lanes');
    lanes.querySelector('svg.arrows')?.remove();
    if (view.name !== 'overview' || (!snapshot.handoffs?.length && !snapshot.notes?.length)) return;
    const box = lanes.getBoundingClientRect();
    const track = lanes.querySelector('.lane:not(.sub) .lane-track');
    if (!track) return;
    const t = track.getBoundingClientRect(), max = range * 60000;
    const left = t.left - box.left, right = left + t.width;
    const laneOf = handle => handle ? lanes.querySelector(`.lane[data-handle="${CSS.escape(handle)}"]`) : null;
    const mid = node => { const r = node.getBoundingClientRect(); return r.top - box.top + r.height / 2; };
    const xAt = ms => left + t.width * (1 - ms / max);
    const art = svg('svg', { class: 'arrows', width: box.width, height: lanes.scrollHeight, 'aria-hidden': 'true' });
    lanes.append(art);
    const marks = new Map(); // hand-off id → where its arrow ends, for fallback links
    // Labels never run past the track: near the right edge the label and its leader sit left of the mark.
    const place = m => {
      const w = m.label.getComputedTextLength?.() || m.label.textContent.length * 6;
      const dir = m.x0 + 19 + w > right && m.x0 - 19 - w >= left ? -1 : 1;
      m.label.setAttribute('x', m.x0 + dir * 19); m.label.setAttribute('text-anchor', dir < 0 ? 'end' : 'start');
      m.leader.setAttribute('d', `M${m.x0} ${m.y0} l${dir * 10} -12 h${dir * 6}`);
      m.x = m.x0 + dir * 16;
    };
    for (const h of snapshot.handoffs || []) {
      const at = since(h.ago_ms);
      if (!finite(at) || at > max) continue;
      const fromLane = laneOf(h.from);
      const x = xAt(at), to = laneOf(h.to);
      const cls = h.state === 'failed' ? 'refused' : h.fallback ? 'fallback' : '';
      const prev = h.after ? marks.get(h.after) : null;
      // A fallback to an AI with no lane continues its failed run's label: "→ Codex ✕ ↻ Gemini".
      if (prev?.label && !to && (!fromLane || fromLane === prev.lane)) {
        const more = svg('tspan', { class: h.state === 'failed' ? 'refused' : 'fallback' });
        more.textContent = `  ↻ ${PROVIDER[h.provider] || PROVIDER[h.to] || clean(h.to) || 'run'}${h.state === 'failed' ? ' ✕' : ''}`;
        prev.label.append(more);
        place(prev);
        marks.set(h.id, prev);
        continue;
      }
      let y1;
      if (fromLane) y1 = mid(fromLane);
      else if (prev) y1 = prev.y; // a fallback has no sender line of its own: it starts where the failed run ended
      else continue;
      if (prev) art.append(svg('path', { d: `M${prev.x} ${prev.y} L${x} ${y1}`, class: 'link' }));
      if (to) {
        const y2 = mid(to), bend = Math.max(14, Math.abs(y2 - y1) / 3), dir = x + bend + 6 > right ? -1 : 1;
        art.append(svg('path', { d: `M${x} ${y1} C${x + dir * bend} ${y1}, ${x + dir * bend} ${y2}, ${x + dir * 6} ${y2}`, class: cls }), svg('circle', { cx: x, cy: y1, r: 3, class: cls }));
        art.append(svg('path', { d: `M${x + dir} ${y2 - 3.5} L${x + dir * 6} ${y2} L${x + dir} ${y2 + 3.5}`, class: cls }));
        marks.set(h.id, { x: x + dir * 6, y: y2 });
      } else {
        const name = `${h.fallback ? '↻ ' : '→ '}${PROVIDER[h.provider] || PROVIDER[h.to] || clean(h.to) || 'run'}${h.state === 'failed' ? ' ✕' : ''}`;
        const label = svg('text', { y: y1 - 8.5, class: cls }); label.textContent = name;
        const leader = svg('path', { class: cls });
        art.append(label, leader, svg('circle', { cx: x, cy: y1, r: 3, class: cls }));
        const mark = { y: y1 - 12, y0: y1, label, leader, x0: x, lane: fromLane };
        place(mark);
        marks.set(h.id, mark);
      }
    }
    for (const n of snapshot.notes || []) {
      const at = since(n.ago_ms), from = laneOf(n.from), to = laneOf(n.to);
      if (!finite(at) || at > max || !from || !to || from === to) continue;
      const x = xAt(at), y1 = mid(from), y2 = mid(to);
      art.append(svg('path', { d: `M${x} ${y1} L${x} ${y2 + (y2 > y1 ? -4 : 4)}`, class: 'note' }), svg('rect', { x: x - 3, y: y2 - 3, width: 6, height: 6, rx: 1, class: 'note' }));
    }
  }

  // ---- Session: header, rail, status line, read-only detail --------------
  const ciText = ci => ci ? [ci.pr ? `#${ci.pr}` : null, ci.label].filter(Boolean).join(' · ') : null;
  const LIVE_SUB = s => s === 'working' || s === 'running' || s === 'waiting';
  const SUB_STATE = s => s === 'working' || s === 'running' ? 'working' : s === 'waiting' ? 'needs' : s === 'failed' ? 'stuck' : s === 'done' ? 'check' : 'idle';
  function renderSessionHead(item) {
    const row = item.row || {};
    const ind = $('session-ind'); ind.dataset.s = item.status; ind.setAttribute('aria-label', STATUS[item.status].label); ind.setAttribute('role', 'img');
    $('session-project').textContent = item.project;
    $('session-ext').hidden = item.type !== 'external';
    $('session-sub').textContent = clean([item.tool, row.model, item.type === 'tab' ? clean(item.session.cwd) : row.hostApp ? `in ${row.hostApp}` : null].filter(Boolean).join(' · '));
    const chips = [];
    if (item.branch) chips.push(el('span', 'chip mono', item.branch));
    const changes = row.changes || item.session?.changes;
    if (changes?.count) chips.push(el('span', 'chip mono', `${changes.count} uncommitted`));
    if (row.ci) chips.push(el('span', `chip mono ${/fail/.test(row.ci.signal) ? 'bad' : /pass|success/.test(row.ci.signal) ? 'ok' : ''}`, ciText(row.ci)));
    if (Number.isFinite(item.cost)) chips.push(el('span', 'chip', `${money(item.cost)} today`));
    $('session-chips').replaceChildren(...chips);
    $('detach').hidden = item.type !== 'tab'; $('stop').hidden = item.type !== 'tab';
    $('stop').disabled = item.type !== 'tab' || !running(item.session);
    if (item.type === 'tab' && term && activeId === item.session.sessionId) term.options.disableStdin = !running(item.session);
  }
  function renderRail(item) {
    const rail = $('rail'), row = item.row;
    const agents = el('section', 'rail-section');
    const head = el('div', 'rail-head');
    head.append(el('h2', 'label', 'Agents'));
    const subs = row?.subagents;
    if (subs?.total) head.append(el('span', 'count', `${subs.running} running · ${subs.total} total`));
    agents.append(head);
    const tree = el('ul', 'tree');
    const root = el('li', 'root');
    const name = el('span', 't-name', row ? 'Main agent' : item.type === 'tab' && item.session.kind === 'shell' ? 'Shell' : item.tool);
    if (row?.model) name.append(el('span', 't-kind', row.model));
    root.append(indicator(item.status), name, el('span', 't-time', dur(since(item.elapsed))));
    root.append(el('span', `t-now${item.group === 'needs' ? ' needs' : ''}`, item.waitingOn || item.doing));
    tree.append(root);
    for (const a of subs?.list || []) {
      const li = el('li', `child depth-${Math.min(2, a.depth || 1)}`);
      const n = el('span', 't-name', a.name); n.append(el('span', 't-kind', a.kind));
      // A waiting agent shows how long it has waited (when that is known), not how long it has run.
      const timing = a.status === 'waiting' ? (finite(a.wait_ms) ? `waiting ${dur(since(a.wait_ms))}` : 'waiting') : LIVE_SUB(a.status) ? dur(since(a.start_ms))
        : finite(a.start_ms) && finite(a.end_ms) ? `${a.status} in ${dur(a.start_ms - a.end_ms)}` : `${clean(a.status)} ${ago(since(a.end_ms))}`;
      const time = el('span', 't-time', timing);
      if (a.status === 'waiting') { time.classList.add('waiting'); time.title = finite(a.start_ms) ? `Running for ${dur(since(a.start_ms))}` : ''; }
      li.append(indicator(SUB_STATE(a.status), 'small'), n, time);
      tree.append(li);
    }
    const hs = handoffsFor(item);
    for (const h of hs.slice(-4)) {
      const out = h.from === row.handle;
      const li = el('li', 'child hand');
      li.append(indicator(h.state === 'failed' ? 'stuck' : h.state === 'succeeded' ? 'check' : h.state === 'ended' ? 'idle' : h.state === 'blocked' ? 'needs' : 'working', 'small'),
        el('span', 't-name', `${out ? '→' : '←'} ${out ? peerName(h.to, h) : peerName(h.from, h)}`), el('span', 't-time', (HANDOFF_STATE[h.state] || ['Sent'])[0]));
      tree.append(li);
    }
    agents.append(tree);
    if (subs?.total) agents.append(el('p', 'rail-note', subs.total > subs.list.length ? `Showing the newest ${subs.list.length}. Subagents report status and timing, not their tools.` : 'Subagents report status and timing, not their tools.'));
    else if (!row) agents.append(el('p', 'rail-note', item.type === 'tab' && item.session.kind === 'shell' ? 'An agent you start in this shell appears here when Plexiform’s hooks report it.' : 'No agent status reported for this tab yet.'));
    const sections = [agents];
    if (hs.length) {
      const sec = el('section', 'rail-section'), h2 = el('div', 'rail-head');
      h2.append(el('h2', 'label', 'Hand-offs'), el('span', 'count', String(hs.length)));
      sec.append(h2, ...hs.slice(-3).reverse().map(h => handoffCard(h, row.handle)));
      sections.push(sec);
    }
    if (row?.timeline?.length) {
      const sec = el('section', 'rail-section'), h2 = el('div', 'rail-head');
      h2.append(el('h2', 'label', 'Activity'), el('span', 'count', 'since this window opened'));
      const list = el('ol', 'timeline');
      for (const entry of [...row.timeline].reverse().slice(0, 8)) {
        const li = el('li', '');
        li.append(indicator(STATUS[entry.bucket] ? entry.bucket : 'idle', 'small'), el('span', 'tl-text', entry.text), el('span', 'tl-time', ago(since(entry.ago_ms))));
        list.append(li);
      }
      sec.append(h2, list); sections.push(sec);
    }
    rail.replaceChildren(...sections);
  }
  function renderStatusline() {
    const item = view.name === 'session' ? itemByKey(view.key) : null;
    if (!item) return;
    const row = item.row || {}, bits = [];
    const span = (cls, text) => el('span', cls, text);
    bits.push(span('sl-provider', [item.tool, row.model].filter(Boolean).join(' · ')));
    const board = boardOf(item);
    if (board) {
      const b = span(`sl-board ${board.kind}`, board.label);
      if (board.why) b.append(span('sl-why', `· ${board.why}`));
      b.title = [board.label, board.why].filter(Boolean).join(' · ');
      bits.push(b);
    }
    if (Number.isSafeInteger(row.notesWaiting) && row.notesWaiting > 0) bits.push(span('sl-notes', `${row.notesWaiting} ${row.notesWaiting === 1 ? 'note' : 'notes'} waiting`));
    if (row.handle) bits.push(span('mono', row.handle));
    bits.push(span('', `${STATUS[item.status].label} · ${dur(since(item.elapsed))}`));
    bits.push(span('sl-spacer', ''));
    if (item.type === 'tab') {
      bits.push(span('', connection));
      if (term && terminalShown()) bits.push(span('mono', `${term.cols}×${term.rows}`));
    } else bits.push(span('', 'Observed · read-only'));
    $('statusline').replaceChildren(...bits);
  }
  function renderDetail(item) {
    const row = item.row || {}, body = $('detail-body');
    const now = el('div', `now status-${item.status}`);
    now.append(el('div', 'now-text', item.waitingOn || item.doing), el('div', 'now-meta', `${STATUS[item.status].label} for ${dur(since(item.elapsed))}${row.quiet ? ' · no hook update in 10 minutes' : ''}`));
    now.append(el('p', 'readonly-note', row.hostApp ? `This session runs in ${row.hostApp}. Plexiform Terminal shows its status but never sends it input — reply there.` : 'This session runs in another app. Plexiform Terminal shows its status but never sends it input.'));
    const facts = el('dl', 'facts');
    const pairs = [['Branch', item.branch || DASH, true], ['Changes', row.changes ? (row.changes.count ? `${row.changes.count} uncommitted` : 'Clean') : DASH], ['PR / CI', ciText(row.ci) || DASH],
      ['Tasks', row.tasks ? `${row.tasks.done} of ${row.tasks.created} done` : DASH], ['Spend today', Number.isFinite(item.cost) ? `${money(item.cost)} in this folder` : DASH],
      ['Started', finite(item.started) ? ago(since(item.started)) : DASH], ['Last report', ago(since(row.age_ms))]];
    const board = boardOf(item);
    if (board) pairs.push(['Board', [board.label, board.why].filter(Boolean).join(' · ')]);
    for (const [name, value, mono] of pairs) { const wrap = el('div', 'fact'); wrap.append(el('dt', '', name), el('dd', mono ? 'mono' : '', value)); facts.append(wrap); }
    const blocks = [now, facts];
    if (row.changes?.files?.length) {
      const files = el('ul', 'files');
      for (const file of row.changes.files) { const li = el('li', ''); li.append(el('span', 'file-state mono', file.state), el('span', 'mono', file.path)); files.append(li); }
      if (row.changes.count > row.changes.files.length) files.append(el('li', 'more', `and ${row.changes.count - row.changes.files.length} more`));
      blocks.push(files);
    }
    body.replaceChildren(...blocks);
  }
  function renderSession() {
    const item = itemByKey(view.key);
    if (!item) { show({ name: 'overview' }); return; }
    const tab = item.type === 'tab';
    $('terminal-view').hidden = !tab;
    $('detail-view').hidden = tab;
    renderSessionHead(item); renderRail(item); renderStatusline();
    if (!tab) renderDetail(item);
  }

  function render() {
    items = buildItems();
    renderSidebar();
    if (view.name === 'overview') renderOverview();
    else if (view.name === 'session') renderSession();
    if (!$('palette').hidden) renderPalette();
  }
  function update(state) {
    if (!state || typeof state !== 'object') return;
    if (Array.isArray(state.sessions)) snapshot.sessions = state.sessions.filter(session => session && typeof session.sessionId === 'string');
    if (Array.isArray(state.rows)) snapshot.rows = state.rows.filter(row => row && typeof row === 'object' && typeof row.id === 'string');
    if (state.totals && typeof state.totals === 'object') snapshot.totals = state.totals;
    if ('bus' in state) snapshot.bus = state.bus && typeof state.bus === 'object' ? state.bus : null;
    if (Array.isArray(state.handoffs)) snapshot.handoffs = state.handoffs.filter(h => h && typeof h === 'object' && Array.isArray(h.steps));
    if (Array.isArray(state.notes)) snapshot.notes = state.notes.filter(n => n && typeof n === 'object' && typeof n.from === 'string' && typeof n.to === 'string');
    if (typeof state.connected === 'boolean') snapshot.connected = state.connected;
    if (typeof state.development === 'boolean') $('development').hidden = !state.development;
    snapshot.at = Date.now();
    for (const id of detached) if (!sessionById(id)) detached.delete(id);
    if (activeId && !sessionById(activeId)) { const was = terminalShown(); closeTerminal(); show(was ? { name: 'overview' } : view); }
    else { render(); if (activeId) connectionText(); }
    // A tab that appears while the window is open (e.g. started here) opens.
    const ids = snapshot.sessions.map(session => session.sessionId);
    if (knownIds && !spawning) {
      const fresh = snapshot.sessions.find(session => !knownIds.has(session.sessionId) && running(session));
      if (fresh) void openTab(fresh.sessionId, { focus: false });
    }
    // Terminal first: at launch, the most recent running tab opens.
    if (!knownIds && !activeId) {
      const recent = [...snapshot.sessions].reverse().find(running);
      if (recent) void openTab(recent.sessionId, { focus: true });
    }
    knownIds = new Set(ids);
  }

  // ---- Quick switch ------------------------------------------------------
  let paletteIndex = 0, paletteEntries = [], lastFocus = null;
  const COMMANDS = [
    { label: 'Overview', hint: '⌘0', run: () => show({ name: 'overview' }) },
    { label: 'New shell…', hint: '⌘T', run: () => spawn('shell') },
    { label: 'New Claude session…', run: () => spawn('claude') },
    { label: 'New Codex session…', run: () => spawn('codex') },
  ];
  function renderPalette() {
    const query = $('palette-input').value.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const match = text => words.every(word => text.toLowerCase().includes(word));
    const numbered = shortcutItems();
    paletteEntries = [
      ...items.map(item => ({ item, hint: numbered.indexOf(item) >= 0 && numbered.indexOf(item) < 9 ? `⌘${numbered.indexOf(item) + 1}` : '', text: [item.project, item.tool, item.branch, item.doing, STATUS[item.status].label, item.row?.hostApp, item.group === 'earlier' ? 'earlier' : ''].filter(Boolean).join(' ') })).filter(entry => match(entry.text)),
      ...COMMANDS.filter(command => match(command.label)).map(command => ({ command, hint: command.hint || '' })),
    ];
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteEntries.length - 1));
    const list = document.createDocumentFragment();
    paletteEntries.forEach((entry, index) => {
      const option = el('div', 'popt'); option.id = `popt-${index}`;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === paletteIndex));
      if (entry.item) {
        const item = entry.item, text = el('span', 'popt-text');
        text.append(el('span', 'popt-title', `${item.project}`), el('span', 'popt-sub', [item.tool, item.branch, item.doing].filter(Boolean).join(' · ')));
        option.append(indicator(item.status), text, el('span', 'popt-tag', item.type === 'external' ? 'View' : 'Terminal'));
      } else option.append(el('span', 'popt-cmd', '›'), el('span', 'popt-text popt-title', entry.command.label));
      if (entry.hint) option.append(el('kbd', '', entry.hint));
      option.addEventListener('mousemove', () => { if (paletteIndex !== index) { paletteIndex = index; markPalette(); } });
      option.addEventListener('click', () => choose(index));
      list.append(option);
    });
    if (!paletteEntries.length) list.append(el('div', 'popt-empty', 'No matching sessions'));
    $('palette-list').replaceChildren(list);
    markPalette();
  }
  function markPalette() {
    $('palette-list').querySelectorAll('[role=option]').forEach((option, index) => option.setAttribute('aria-selected', String(index === paletteIndex)));
    const current = $(`popt-${paletteIndex}`);
    if (current) { $('palette-input').setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' }); }
  }
  function openPalette() {
    lastFocus = document.activeElement;
    $('palette').hidden = false; $('palette-input').value = ''; paletteIndex = 0;
    renderPalette(); $('palette-input').focus();
  }
  function closePalette(restore = true) {
    $('palette').hidden = true;
    if (restore) (terminalShown() && term ? term : lastFocus)?.focus?.();
  }
  function choose(index) {
    const entry = paletteEntries[index]; if (!entry) return;
    closePalette(false);
    if (entry.item) open(entry.item); else entry.command.run();
  }
  $('palette-input').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
  $('palette-input').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const n = paletteEntries.length; if (!n) return;
      paletteIndex = (paletteIndex + (event.key === 'ArrowDown' ? 1 : -1) + n) % n; markPalette();
    } else if (event.key === 'Enter') { event.preventDefault(); choose(paletteIndex); }
    else if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
    else if (event.key === 'Tab') event.preventDefault();
  });
  $('palette').addEventListener('mousedown', event => { if (event.target === $('palette')) closePalette(); });

  // ---- Actions -----------------------------------------------------------
  async function spawn(kind) {
    if (spawning) return;
    spawning = true;
    document.querySelectorAll('[data-spawn]').forEach(item => { item.disabled = true; });
    try {
      const current = view.name === 'session' ? itemByKey(view.key) : null;
      const from = current?.type === 'external' ? current.row?.id : activeId;
      const result = checked(await api.spawn({ kind, from: from || null }));
      if (result?.session) {
        const id = result.session.sessionId;
        if (!sessionById(id)) snapshot.sessions.push(result.session);
        knownIds?.add(id);
        await openTab(id);
      }
    } catch (error) { notice(error.message); }
    finally { spawning = false; document.querySelectorAll('[data-spawn]').forEach(item => { item.disabled = false; }); }
  }
  for (const button of document.querySelectorAll('[data-spawn]')) button.addEventListener('click', () => { void spawn(button.dataset.spawn); });
  for (const button of document.querySelectorAll('[data-range]')) button.addEventListener('click', () => { range = Number(button.dataset.range); render(); });
  $('detach').addEventListener('click', async () => {
    const id = activeId;
    if (!id) return;
    try {
      checked(await api.detach(id)); detached.add(id); closeTerminal(); show({ name: 'overview' });
      notice('Terminal detached. Its process keeps running; choose it in the sidebar to reattach.');
    } catch (error) { notice(error.message); }
  });
  $('stop').addEventListener('click', async () => {
    if (!activeId) return;
    try { checked(await api.stop(activeId)); } catch (error) { notice(error.message); }
  });
  $('reconnect').addEventListener('click', async () => {
    $('reconnect').disabled = true; $('keeper-state').textContent = 'Reconnecting…';
    try { checked(await api.reconnect()); $('notice').hidden = true; if (activeId) { const id = activeId; closeTerminal(); void openTab(id, { focus: false }); } }
    catch (error) { notice(error.message); }
    finally { $('reconnect').disabled = false; }
  });
  $('nav-overview').addEventListener('click', () => show({ name: 'overview' }));
  $('quick-open').addEventListener('click', openPalette);
  $('next-needs').addEventListener('click', nextNeeds);
  $('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });

  // Arrow keys (and Home/End) move between sidebar rows and between Overview lanes.
  const listKeys = (container, selector) => container.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...container.querySelectorAll(selector)].filter(node => node.offsetParent !== null), at = rows.indexOf(document.activeElement);
    if (at < 0 || !rows.length) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)));
    rows[next].focus(); rows[next].scrollIntoView({ block: 'nearest' });
  });
  listKeys($('session-list'), '.srow');
  listKeys($('lanes'), 'button.lane-head');
  document.addEventListener('keydown', event => {
    if (event.key === 'Meta') document.body.classList.add('cmd-held');
    if (event.key === 'Escape' && !$('palette').hidden) { event.preventDefault(); closePalette(); return; }
    if (event.key === 'Escape' && view.name === 'session' && !terminalShown()) { show({ name: 'overview' }); return; }
    if (!event.metaKey || event.altKey || event.ctrlKey) return;
    const key = event.key.toLowerCase(), stop = () => { event.preventDefault(); event.stopPropagation(); };
    if (key === 't' && !event.shiftKey) { stop(); void spawn('shell'); }
    else if (key === 'p' && !event.shiftKey) { stop(); if ($('palette').hidden) openPalette(); else closePalette(); }
    else if (key === 'j' && !event.shiftKey) { stop(); nextNeeds(); }
    else if (key === '0') { stop(); show({ name: 'overview' }); }
    else if (/^[1-9]$/.test(key)) { const target = shortcutItems()[Number(key) - 1]; if (target) { stop(); closePalette(false); open(target); } }
  }, true);
  document.addEventListener('keyup', event => { if (event.key === 'Meta') document.body.classList.remove('cmd-held'); });
  window.addEventListener('blur', () => document.body.classList.remove('cmd-held'));

  new ResizeObserver(scheduleFit).observe($('terminal'));
  new ResizeObserver(() => { if (view.name === 'overview') requestAnimationFrame(() => { fitLabels(); drawArrows(); }); }).observe($('lanes'));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (term) term.options.theme = theme(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleFit(); });
  window.addEventListener('focus', () => { if (terminalShown() && $('palette').hidden) term?.focus(); });
  // Elapsed times and lanes keep moving between state pushes.
  setInterval(() => { if (!document.hidden) render(); }, 15000);

  if (!api) { snapshot.connected = false; render(); notice('Open Plexiform Terminal as an app to connect to its Session Keeper.'); return; }
  let receivedLiveState = false;
  api.onState(state => { receivedLiveState = true; update(state); });
  api.onNotice(notice);
  api.onOpen?.(event => { if (typeof event?.sessionId === 'string') { knownIds?.add(event.sessionId); void openTab(event.sessionId); } });
  api.onData(event => {
    if (!term || event?.sessionId !== activeId) return;
    if (event.reset) term.reset();
    if (typeof event.data !== 'string') return;
    try { term.write(Uint8Array.from(atob(event.data), character => character.charCodeAt(0))); }
    catch { notice('Terminal output could not be decoded. Detach and reattach to refresh it.'); }
  });
  render();
  void api.ready().then(state => {
    checked(state);
    if (!receivedLiveState) update(state);
  }).catch(error => { snapshot.connected = false; render(); notice(error.message); });
})();
