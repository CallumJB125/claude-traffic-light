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
  const DASH = '—';
  const leaf = value => clean(value).replace(/\/+$/, '').split('/').pop() || clean(value) || 'Session';
  const KIND = { shell: 'Shell', claude: 'Claude', codex: 'Codex' };
  const running = session => session && session.state === 'running';
  const finite = value => Number.isFinite(value) && value >= 0;
  const money = usd => Number.isFinite(usd) ? `$${usd.toFixed(2)}` : DASH;
  const bytesText = value => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
  function dur(ms) {
    if (!finite(ms)) return DASH;
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }
  const ago = ms => { const d = dur(ms); return d === DASH || d === 'now' ? (d === 'now' ? 'just now' : DASH) : `${d} ago`; };

  // Status: colour and shape are both distinct, and every indicator has a text label.
  const STATUS = {
    needs: { label: 'Needs you', group: 'needs' },
    stuck: { label: 'Failed', group: 'needs' },
    working: { label: 'Running', group: 'running' },
    live: { label: 'Process running', group: 'running' },
    check: { label: 'Finished', group: 'finished' },
    exited: { label: 'Exited', group: 'finished' },
    idle: { label: 'Idle', group: 'idle' },
    shell: { label: 'Shell', group: 'shells' },
  };
  const GROUPS = [['needs', 'Needs you'], ['running', 'Running'], ['finished', 'Finished'], ['idle', 'Idle'], ['shells', 'Shells']];
  const indicator = (status, extraClass = '') => {
    const node = el('span', `ind${extraClass ? ` ${extraClass}` : ''}`);
    node.dataset.s = STATUS[status] ? status : 'idle';
    node.setAttribute('role', 'img'); node.setAttribute('aria-label', STATUS[status]?.label || 'Idle');
    return node;
  };

  let snapshot = { sessions: [], rows: [], totals: null, connected: null, at: Date.now() };
  let view = { name: 'overview' }, activeId = null, term = null, fitAddon = null;
  let selecting = 0, spawning = false, fitFrame = 0, knownIds = null, items = [];
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

  // One list for the sidebar, palette, shortcuts and overview: keeper tabs
  // (with their observed agent status when Plexiform links them) then
  // external sessions, which are read-only.
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
        tool: row?.tool || KIND[session.kind] || clean(session.kind) || 'Session',
        project: leaf(session.cwd), branch: row?.branch || session.branch || null,
        doing, waitingOn: row?.waitingOn || null,
        elapsed: row ? (row.bucket === 'working' ? row.working_ms ?? row.since_ms : row.since_ms) : startedMs,
        started: row?.started_ms ?? startedMs, cost: row?.cost?.usd, detached: detached.has(session.sessionId),
      });
    }
    for (const row of snapshot.rows) {
      if (typeof row.tabId === 'string' && sessionById(row.tabId)) continue;
      list.push({
        key: `o:${row.id}`, type: 'external', session: null, row, status: STATUS[row.bucket] ? row.bucket : 'idle',
        tool: row.tool || 'AI', project: row.project || 'Unknown folder', branch: row.branch || null,
        doing: row.doing, waitingOn: row.waitingOn || null,
        elapsed: row.bucket === 'working' ? row.working_ms ?? row.since_ms : row.since_ms,
        started: row.started_ms, cost: row.cost?.usd, detached: false,
      });
    }
    const order = Object.fromEntries(GROUPS.map(([id], i) => [id, i]));
    // Needs-you is a queue (longest wait first); other groups keep start order
    // so ⌘-number shortcuts move only when a session changes group.
    list.sort((a, b) => {
      const ga = order[STATUS[a.status].group], gb = order[STATUS[b.status].group];
      if (ga !== gb) return ga - gb;
      if (ga === 0) return (b.elapsed ?? -1) - (a.elapsed ?? -1);
      return (b.started ?? -1) - (a.started ?? -1) || a.key.localeCompare(b.key);
    });
    return list;
  }
  const itemByKey = key => items.find(item => item.key === key);

  // ---- Terminal ----------------------------------------------------------
  const theme = () => {
    const css = getComputedStyle(document.documentElement), v = name => css.getPropertyValue(name).trim();
    const light = matchMedia('(prefers-color-scheme: light)').matches;
    const ansi = light
      ? { black: '#1f2328', red: '#c4362c', green: '#1a7f4b', yellow: '#9a6700', blue: '#2259c9', magenta: '#8a3fb8', cyan: '#127a87', white: '#6e7781', brightBlack: '#57606a', brightRed: '#d9473d', brightGreen: '#1f9358', brightYellow: '#b07a00', brightBlue: '#3570e0', brightMagenta: '#9d50cf', brightCyan: '#1690a0', brightWhite: '#8c959f' }
      : { black: '#1c1e23', red: '#ec7b72', green: '#6cc596', yellow: '#e2b45f', blue: '#7fa8eb', magenta: '#c19be6', cyan: '#6cc4cf', white: '#cfd3da', brightBlack: '#5f6673', brightRed: '#ff978e', brightGreen: '#8ad9ad', brightYellow: '#f0cb85', brightBlue: '#9dbff5', brightMagenta: '#d4b6f2', brightCyan: '#8fd8e0', brightWhite: '#f4f5f7' };
    return { background: v('--terminal'), foreground: v('--term-fg'), cursor: v('--term-fg'), cursorAccent: v('--terminal'), selectionBackground: light ? '#b6cdf580' : '#3d5a8a99', ...ansi };
  };
  function scheduleFit() {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      if (!term || !fitAddon || $('terminal').hidden || $('terminal-view').hidden || document.hidden) return;
      try { fitAddon.fit(); } catch { return; }
      $('dimensions').textContent = `${term.cols} × ${term.rows}`;
      if (activeId) void api.resize({ sessionId: activeId, cols: term.cols, rows: term.rows }).catch(error => notice(error.message));
    });
  }
  function disposeTerminal() {
    term?.dispose(); term = null; fitAddon = null;
    $('terminal').replaceChildren(); $('dimensions').textContent = '';
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
      if (data === '\u001b[I' || data === '\u001b[O' || !activeId || view.name !== 'terminal' || !document.hasFocus() || !running(sessionById(activeId))) return;
      void api.write({ sessionId: activeId, data }).then(checked).catch(error => notice(error.message));
    });
    scheduleFit();
  }
  async function openTab(sessionId, { focus = true } = {}) {
    const session = sessionById(sessionId);
    if (!session) return;
    detached.delete(sessionId);
    if (activeId === sessionId && term) { show({ name: 'terminal' }); scheduleFit(); if (focus) term.focus(); return; }
    const selection = ++selecting;
    activeId = sessionId; show({ name: 'terminal' });
    $('terminal').hidden = false;
    createTerminal(); render();
    $('connection').textContent = 'Attaching…';
    try {
      checked(await api.select(sessionId));
      if (selection !== selecting || activeId !== sessionId) return;
      connectionText();
      scheduleFit();
      if (focus) term?.focus();
    } catch (error) {
      if (selection !== selecting) return;
      $('connection').textContent = 'Session unavailable'; notice(error.message);
    }
  }
  function closeTerminal() {
    ++selecting; activeId = null; disposeTerminal(); $('terminal').hidden = true;
  }
  function connectionText() {
    const session = sessionById(activeId);
    if (!session) return;
    $('connection').textContent = snapshot.connected === false ? 'Session Keeper offline · output shown may be stale'
      : running(session) ? 'Attached · closing this window keeps the session running' : 'Exited · output retained';
  }

  // ---- Navigation --------------------------------------------------------
  function show(next) {
    view = next;
    $('overview-view').hidden = view.name !== 'overview';
    $('terminal-view').hidden = view.name !== 'terminal';
    $('detail-view').hidden = view.name !== 'detail';
    if (view.name === 'overview') $('nav-overview').setAttribute('aria-current', 'page'); else $('nav-overview').removeAttribute('aria-current');
    render();
    if (view.name === 'terminal') scheduleFit();
  }
  function open(item, options) {
    if (!item) return;
    if (item.type === 'tab') void openTab(item.session.sessionId, options);
    else { show({ name: 'detail', key: item.key }); $('detail-view').querySelector('.scroll').scrollTop = 0; }
  }
  const currentKey = () => view.name === 'terminal' && activeId ? `k:${activeId}` : view.name === 'detail' ? view.key : null;
  function nextNeeds() {
    const queue = items.filter(item => STATUS[item.status].group === 'needs');
    if (!queue.length) return;
    const at = queue.findIndex(item => item.key === currentKey());
    open(queue[(at + 1) % queue.length]);
  }

  // ---- Sidebar -----------------------------------------------------------
  function metaLine(item, className) {
    const line = el('span', className);
    line.append(el('span', 'tool', item.tool));
    if (item.branch) line.append(el('span', 'sep', '·'), el('span', 'branch', item.branch));
    else if (item.type === 'external' && item.row?.hostApp) line.append(el('span', 'sep', '·'), el('span', 'host', `in ${item.row.hostApp}`));
    if (Number.isFinite(item.cost)) line.append(el('span', 'cost', money(item.cost)));
    return line;
  }
  function renderSidebar() {
    const list = $('session-list'), focusedKey = document.activeElement?.closest?.('#session-list [data-key]')?.dataset.key;
    const fragment = document.createDocumentFragment(), current = currentKey();
    let number = 0;
    for (const [group, title] of GROUPS) {
      const members = items.filter(item => STATUS[item.status].group === group);
      if (!members.length) continue;
      const section = el('section', `group group-${group}`);
      const head = el('h3', 'group-head');
      head.append(el('span', '', title), el('span', 'group-count', members.length));
      section.append(head);
      for (const item of members) {
        number++;
        const row = el('button', `srow${item.detached ? ' detached' : ''}`);
        row.dataset.key = item.key;
        if (item.type === 'tab') row.dataset.tabId = item.session.sessionId;
        if (item.key === current) row.setAttribute('aria-current', 'true');
        row.title = item.type === 'external' ? `${item.tool} in ${item.project} · observed, read-only` : `${item.tool} in ${clean(item.session.cwd)}`;
        const main = el('span', 'srow-main');
        const top = el('span', 'srow-top');
        top.append(el('span', 'srow-title', item.project), el('span', 'srow-time', dur(since(item.elapsed))));
        if (number <= 9) top.append(el('kbd', 'srow-kbd', `⌘${number}`));
        const doing = el('span', 'srow-doing', item.detached ? `Detached · ${item.doing}` : item.doing);
        main.append(top, metaLine(item, 'srow-meta'), doing);
        row.append(indicator(item.status), main);
        if (item.type === 'external') row.append(el('span', 'srow-ext', '↗'));
        row.addEventListener('click', () => open(item));
        section.append(row);
      }
      fragment.append(section);
    }
    if (!items.length) {
      const empty = el('div', 'side-empty');
      empty.append(el('p', 'side-empty-title', 'No sessions yet'), el('p', '', 'Start a shell, Claude or Codex below. Agents running in other apps appear here when Plexiform reports them.'));
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    if (focusedKey) list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
    const needs = items.filter(item => STATUS[item.status].group === 'needs');
    $('next-needs').hidden = !needs.length;
    $('next-needs-label').textContent = needs.length === 1 ? '1 session needs you' : `${needs.length} sessions need you`;
    const connected = snapshot.connected;
    $('keeper-dot').dataset.state = connected === true ? 'on' : connected === false ? 'off' : 'wait';
    $('keeper-state').textContent = connected === true ? 'Session Keeper connected' : connected === false ? 'Session Keeper offline' : 'Connecting to Session Keeper…';
    $('reconnect').hidden = connected !== false;
  }

  // ---- Overview ----------------------------------------------------------
  function stat(label, value, sub, tone) {
    const tile = el('div', `stat${tone ? ` tone-${tone}` : ''}`);
    tile.append(el('div', 'stat-label', label), el('div', 'stat-value', value), el('div', 'stat-sub', sub));
    return tile;
  }
  function action(item) {
    if (item.type === 'tab') {
      const button = el('button', 'btn', item.detached ? 'Reattach' : 'Open terminal');
      button.addEventListener('click', () => open(item)); return button;
    }
    const button = el('button', 'btn ghost', 'Details');
    button.addEventListener('click', () => open(item)); return button;
  }
  function facts(pairs, className = 'facts') {
    const list = el('dl', className);
    for (const [name, value, mono] of pairs) {
      const wrap = el('div', 'fact');
      wrap.append(el('dt', '', name), el('dd', mono ? 'mono' : '', value));
      list.append(wrap);
    }
    return list;
  }
  const ciText = ci => ci ? [ci.pr ? `PR #${ci.pr}` : null, ci.label].filter(Boolean).join(' · ') : DASH;
  const subagentText = s => s && s.total ? `${s.running} running · ${s.total} total` : s ? 'None' : DASH;
  const changesText = c => c ? (c.count ? `${c.count} uncommitted` : 'Clean') : DASH;
  function timeline(entries, limit) {
    const list = el('ol', 'timeline');
    for (const entry of [...entries].reverse().slice(0, limit)) {
      const li = el('li', '');
      li.append(indicator(STATUS[entry.bucket] ? entry.bucket : 'idle', 'small'), el('span', 'tl-text', entry.text), el('span', 'tl-time', ago(since(entry.ago_ms))));
      list.append(li);
    }
    return list;
  }
  function renderOverview() {
    const agents = items.filter(item => item.row || (item.type === 'tab' && item.session.kind !== 'shell'));
    const queue = items.filter(item => STATUS[item.status].group === 'needs');
    const live = agents.filter(item => item.status !== 'exited');
    const working = live.filter(item => STATUS[item.status].group === 'running').length;
    const totals = snapshot.totals;
    const longest = queue.reduce((max, item) => Math.max(max, since(item.elapsed) ?? 0), 0);
    const tabs = snapshot.sessions.length, runningTabs = snapshot.sessions.filter(running).length;
    $('overview-summary').textContent = `${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · updates every few seconds`;
    const stats = [
      stat('Live agents', String(live.length), live.length ? `${working} running · ${live.length - working - queue.length} finished or idle` : 'None reported', live.length ? 'working' : ''),
      stat('Needs you', String(queue.length), queue.length ? `Longest waiting ${dur(longest)}` : 'Nothing is waiting', queue.length ? 'needs' : ''),
      stat('Spend today', totals && Number.isFinite(totals.spendToday) ? money(totals.spendToday) : DASH,
        totals && Number.isFinite(totals.spendToday) ? (totals.unpricedTurns ? `Claude, priced turns · ${totals.unpricedTurns} unpriced` : 'Claude usage on this Mac') : 'No usage rollup for today yet'),
      stat('Terminals', String(tabs), snapshot.connected === false ? 'Session Keeper offline' : tabs ? `${runningTabs} running` : 'None open'),
    ];
    $('stats').replaceChildren(...stats);

    $('queue-count').textContent = queue.length || '';
    const q = document.createDocumentFragment();
    for (const item of queue) {
      const card = el('article', 'qrow');
      card.append(indicator(item.status));
      const body = el('div', 'qrow-body');
      const head = el('div', 'qrow-head');
      head.append(el('span', 'qrow-title', item.project), el('span', 'chip', item.tool));
      if (item.branch) head.append(el('span', 'chip mono', item.branch));
      const meta = el('div', 'qrow-meta', [item.type === 'external' && item.row?.hostApp ? `Answer in ${item.row.hostApp}` : item.type === 'external' ? 'Answer in its own app' : 'In this terminal', `waiting ${dur(since(item.elapsed))}`].join(' · '));
      body.append(head, el('div', 'qrow-wait', item.status === 'stuck' ? item.doing : item.waitingOn || item.doing), meta);
      card.append(body, action(item));
      q.append(card);
    }
    if (!queue.length) q.append(el('p', 'empty-line', 'Nothing is waiting on you. Sessions that ask a question or need approval appear here first.'));
    $('queue').replaceChildren(q);

    $('agent-count').textContent = agents.length || '';
    const cards = document.createDocumentFragment();
    for (const item of agents) {
      const row = item.row, card = el('article', `card status-${item.status}`);
      const head = el('div', 'card-head');
      head.append(indicator(item.status));
      const title = el('div', 'card-title');
      title.append(el('h4', '', item.project), el('span', 'card-sub', [item.tool, row?.model, item.type === 'external' && row?.hostApp ? `in ${row.hostApp}` : item.type === 'tab' ? 'this app' : null].filter(Boolean).join(' · ')));
      head.append(title, el('span', 'card-time', dur(since(item.elapsed))));
      const doing = el('p', 'card-doing', item.doing);
      card.append(head, doing);
      card.append(facts([
        ['Branch', item.branch || DASH, true],
        ['Changes', changesText(row?.changes || item.session?.changes || null)],
        ['PR / CI', ciText(row?.ci)],
        ['Subagents', subagentText(row?.subagents)],
        ['Spend today', Number.isFinite(item.cost) ? `${money(item.cost)} in folder` : DASH],
        ['Started', item.started !== null && item.started !== undefined ? ago(since(item.started)) : DASH],
      ]));
      if (row?.timeline?.length) card.append(timeline(row.timeline, 4));
      const foot = el('div', 'card-foot');
      foot.append(el('span', 'card-note', item.type === 'external' ? 'Observed · read-only' : item.detached ? 'Detached · still running' : 'Terminal tab'), action(item));
      card.append(foot);
      cards.append(card);
    }
    if (!agents.length) cards.append(el('p', 'empty-line', 'No agent activity reported. Agents appear here when Plexiform’s hooks report them; terminals work without it.'));
    $('agents').replaceChildren(cards);

    $('keeper-count').textContent = tabs || '';
    const terms = document.createDocumentFragment();
    for (const item of items.filter(i => i.type === 'tab')) {
      const s = item.session, button = el('button', 'trow');
      button.dataset.key = item.key;
      button.append(indicator(item.status));
      const text = el('span', 'trow-text');
      text.append(el('span', 'trow-title', `${KIND[s.kind] || clean(s.kind)} · ${leaf(s.cwd)}`), el('span', 'trow-meta mono', clean(s.cwd)));
      const bits = [running(s) ? 'running' : s.state === 'unknown' ? 'unknown' : 'exited', Number.isSafeInteger(s.pid) && s.pid > 0 ? `PID ${s.pid}` : null, finite(s.outputBytes) ? bytesText(s.outputBytes) : null, item.detached ? 'detached' : null].filter(Boolean).join(' · ');
      button.append(text, el('span', 'trow-side', bits));
      button.addEventListener('click', () => open(item));
      terms.append(button);
    }
    if (!tabs) terms.append(el('p', 'empty-line', 'No terminals open. Press ⌘T for a new shell.'));
    $('keeper-sessions').replaceChildren(terms);
  }

  // ---- Detail (read-only) ------------------------------------------------
  function renderDetail() {
    if (view.name !== 'detail') return;
    const item = itemByKey(view.key);
    const head = $('detail-head'), body = $('detail-body');
    if (!item) {
      head.replaceChildren(el('h1', '', 'Session ended'));
      body.replaceChildren(el('p', 'empty-line', 'This session is no longer reported. It may have ended or stopped sending status.'));
      return;
    }
    const row = item.row || {};
    const title = el('div', 'detail-title');
    title.append(indicator(item.status));
    const text = el('div', 'head-text');
    text.append(el('h1', '', item.project), el('p', 'sub', [item.tool, row.model, row.hostApp ? `in ${row.hostApp}` : null, STATUS[item.status].label].filter(Boolean).join(' · ')));
    title.append(text);
    head.replaceChildren(title);

    const now = el('section', 'block');
    now.append(el('div', 'block-head')); now.firstChild.append(el('h2', '', 'Now'));
    const doing = el('div', `now status-${item.status}`);
    doing.append(el('div', 'now-text', item.waitingOn || item.doing), el('div', 'now-meta', `${STATUS[item.status].label} for ${dur(since(item.elapsed))}${row.quiet ? ' · no hook update in 10 minutes' : ''}`));
    now.append(doing);
    const readOnly = el('p', 'readonly-note', row.hostApp ? `This session runs in ${row.hostApp}. Plexiform Terminal shows its status but never sends it input — reply there.` : 'This session runs in another app. Plexiform Terminal shows its status but never sends it input.');
    now.append(readOnly);

    const work = el('section', 'block');
    work.append(el('div', 'block-head')); work.firstChild.append(el('h2', '', 'Work'));
    work.append(facts([
      ['Branch', item.branch || DASH, true], ['Changes', changesText(row.changes)], ['PR / CI', ciText(row.ci)],
      ['Tasks', row.tasks ? `${row.tasks.done} of ${row.tasks.created} done` : DASH], ['Spend today', Number.isFinite(item.cost) ? `${money(item.cost)} in this folder` : DASH],
      ['Started', finite(item.started) ? ago(since(item.started)) : DASH], ['Last report', ago(since(row.age_ms))],
    ], 'facts wide'));
    if (row.changes?.files?.length) {
      const files = el('ul', 'files');
      for (const file of row.changes.files) { const li = el('li', ''); li.append(el('span', 'file-state mono', file.state), el('span', 'mono', file.path)); files.append(li); }
      if (row.changes.count > row.changes.files.length) files.append(el('li', 'more', `and ${row.changes.count - row.changes.files.length} more`));
      work.append(files);
    }
    if (row.ci?.title) work.append(el('p', 'small-note', `Latest GitHub signal: ${row.ci.title}${row.ci.repo ? ` · ${row.ci.repo}` : ''} · ${ago(row.ci.ago_ms)}`));

    const blocks = [now, work];
    if (row.subagents?.list?.length) {
      const subs = el('section', 'block');
      subs.append(el('div', 'block-head')); subs.firstChild.append(el('h2', '', 'Subagents'), el('span', 'count', row.subagents.total));
      const list = el('ul', 'subagents');
      for (const s of row.subagents.list) {
        const li = el('li', '');
        const st = s.status === 'working' || s.status === 'running' ? 'working' : s.status === 'done' ? 'check' : s.status === 'failed' ? 'stuck' : 'idle';
        li.append(indicator(st, 'small'), el('span', 'sa-name', s.name), el('span', 'sa-kind', s.kind), el('span', 'sa-time', `${s.status} · ${dur(since(s.since_ms))}`));
        list.append(li);
      }
      subs.append(list); blocks.push(subs);
    }
    if (row.timeline?.length) {
      const act = el('section', 'block');
      act.append(el('div', 'block-head')); act.firstChild.append(el('h2', '', 'Activity'), el('span', 'block-note', 'Since this window opened'));
      act.append(timeline(row.timeline, 12)); blocks.push(act);
    }
    body.replaceChildren(...blocks);
  }

  // ---- Terminal header ---------------------------------------------------
  function renderSessionBar() {
    const item = activeId ? itemByKey(`k:${activeId}`) : null;
    if (!item) return;
    const s = item.session;
    const ind = $('session-ind'); ind.dataset.s = item.status; ind.setAttribute('aria-label', STATUS[item.status].label);
    $('session-project').textContent = item.project;
    $('session-tool').textContent = item.tool;
    $('session-branch').hidden = !item.branch; $('session-branch').textContent = clean(item.branch || '');
    $('session-doing').textContent = clean([item.doing, item.row ? dur(since(item.elapsed)) : null, Number.isFinite(item.cost) ? `${money(item.cost)} today in folder` : null].filter(v => v && v !== DASH).join(' · '));
    $('session-cwd').textContent = clean(s.cwd); $('session-cwd').title = clean(s.cwd);
    $('stop').disabled = !running(s);
    if (term) term.options.disableStdin = !running(s);
    connectionText();
  }

  function render() {
    items = buildItems();
    renderSidebar(); renderSessionBar();
    if (view.name === 'overview') renderOverview();
    renderDetail();
    if (!$('palette').hidden) renderPalette();
  }
  function update(state) {
    if (!state || typeof state !== 'object') return;
    if (Array.isArray(state.sessions)) snapshot.sessions = state.sessions.filter(session => session && typeof session.sessionId === 'string');
    if (Array.isArray(state.rows)) snapshot.rows = state.rows.filter(row => row && typeof row === 'object' && typeof row.id === 'string');
    if (state.totals && typeof state.totals === 'object') snapshot.totals = state.totals;
    if (typeof state.connected === 'boolean') snapshot.connected = state.connected;
    if (typeof state.development === 'boolean') $('development').hidden = !state.development;
    snapshot.at = Date.now();
    for (const id of detached) if (!sessionById(id)) detached.delete(id);
    if (activeId && !sessionById(activeId)) { closeTerminal(); if (view.name === 'terminal') view = { name: 'overview' }; show(view); }
    else render();
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
    paletteEntries = [
      ...items.map((item, i) => ({ item, hint: i < 9 ? `⌘${i + 1}` : '', text: [item.project, item.tool, item.branch, item.doing, STATUS[item.status].label, item.row?.hostApp].filter(Boolean).join(' ') })).filter(entry => match(entry.text)),
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
    if (restore) (view.name === 'terminal' && term ? term : lastFocus)?.focus?.();
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
      const from = view.name === 'detail' ? itemByKey(view.key)?.row?.id : activeId;
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

  // Arrow keys move between sidebar rows.
  $('session-list').addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...$('session-list').querySelectorAll('.srow')], at = rows.indexOf(document.activeElement);
    if (at < 0) return;
    event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Meta') document.body.classList.add('cmd-held');
    if (event.key === 'Escape' && !$('palette').hidden) { event.preventDefault(); closePalette(); return; }
    if (event.key === 'Escape' && view.name === 'detail') { show({ name: 'overview' }); return; }
    if (!event.metaKey || event.altKey || event.ctrlKey) return;
    const key = event.key.toLowerCase(), stop = () => { event.preventDefault(); event.stopPropagation(); };
    if (key === 't' && !event.shiftKey) { stop(); void spawn('shell'); }
    else if (key === 'p' && !event.shiftKey) { stop(); if ($('palette').hidden) openPalette(); else closePalette(); }
    else if (key === 'j' && !event.shiftKey) { stop(); nextNeeds(); }
    else if (key === '0') { stop(); show({ name: 'overview' }); }
    else if (/^[1-9]$/.test(key)) { const target = items[Number(key) - 1]; if (target) { stop(); closePalette(false); open(target); } }
  }, true);
  document.addEventListener('keyup', event => { if (event.key === 'Meta') document.body.classList.remove('cmd-held'); });
  window.addEventListener('blur', () => document.body.classList.remove('cmd-held'));

  new ResizeObserver(scheduleFit).observe($('terminal'));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (term) term.options.theme = theme(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleFit(); });
  window.addEventListener('focus', () => { if (activeId && view.name === 'terminal' && $('palette').hidden) term?.focus(); });
  // Elapsed times keep moving between state pushes.
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
