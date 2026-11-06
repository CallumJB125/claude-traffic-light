'use strict';

(() => {
  const api = window.terminal;
  const $ = id => document.getElementById(id);
  const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 2000);
  const node = (tag, value, className) => {
    const el = document.createElement(tag);
    if (value !== undefined) el.textContent = clean(value);
    if (className) el.className = className;
    return el;
  };
  const idOf = session => session.id || session.sessionId;
  const leaf = path => clean(path).replace(/\/+$/, '').split('/').pop() || clean(path) || 'Session';
  const kindOf = session => ({ shell: 'Shell', claude: 'Claude', codex: 'Codex' }[session.kind] || clean(session.kind || 'Session'));
  const statusOf = session => clean(session.state || session.status || 'Running');
  const running = session => !['exited', 'stopped', 'ended', 'failed'].includes(String(session.state || session.status).toLowerCase());
  const bytesText = value => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
  const toneOf = row => {
    const value = String(row.bucket || row.status || row.state || '').toLowerCase();
    if (/needs|waiting|approval/.test(value)) return 'needs';
    if (/fail|stuck|error/.test(value)) return 'failed';
    if (/working|running|busy/.test(value)) return 'working';
    return '';
  };
  let snapshot = { sessions: [], rows: [] }, activeId = null, term = null, fitAddon = null;
  let selecting = 0, spawning = false, fitFrame = 0;
  const detached = new Set();

  function notice(message) {
    $('notice-text').textContent = clean(typeof message === 'string' ? message : message?.message || message?.error || 'The operation could not be completed.');
    $('notice').hidden = false;
  }
  function checked(result) {
    if (result?.ok === false || result?.error) throw new Error(clean(result.message || result.error?.message || result.error || result.code || 'Operation failed'));
    return result;
  }
  const sessionById = id => snapshot.sessions.find(session => idOf(session) === id);
  const theme = () => {
    const css = getComputedStyle(document.documentElement);
    return { background: css.getPropertyValue('--terminal').trim(), foreground: css.getPropertyValue('--text').trim(), cursor: css.getPropertyValue('--accent').trim(), selectionBackground: matchMedia('(prefers-color-scheme: light)').matches ? '#c8ced780' : '#59647780', black:'#202329',red:'#e4776e',green:'#67b899',yellow:'#d8aa60',blue:'#83a7d8',magenta:'#b79bd5',cyan:'#79bfc9',white:'#cbd0d8',brightBlack:'#697180',brightRed:'#ff9187',brightGreen:'#83d9b9',brightYellow:'#e4c58b',brightBlue:'#9bbff0',brightMagenta:'#ceb0eb',brightCyan:'#94d7df',brightWhite:'#f0f1f3' };
  };

  function scheduleFit() {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      if (!term || !fitAddon || $('terminal').hidden || document.hidden) return;
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
    term = new Terminal({ fontFamily: '"SF Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.25, scrollback: 5000, cursorBlink: false, allowProposedApi: false, allowTransparency: false, convertEol: false, theme: theme(), windowOptions: {} });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    // Keeper owns terminal query replies. Replay must never generate session input.
    for (const identifier of [{ final:'c' }, { prefix:'>', final:'c' }, { prefix:'=', final:'c' }, { final:'n' }, { prefix:'?', final:'n' }, { final:'t' }, { intermediates:'$', final:'p' }, { prefix:'?', intermediates:'$', final:'p' }]) term.parser.registerCsiHandler(identifier, () => true);
    for (const identifier of [{ intermediates:'$', final:'q' }, { intermediates:'+', final:'q' }]) term.parser.registerDcsHandler(identifier, () => true);
    for (const command of [0, 1, 2, 4, 10, 11, 12, 52]) term.parser.registerOscHandler(command, () => true);
    term.options.linkHandler = { activate() {}, hover() {}, leave() {} };
    term.open($('terminal'));
    term.onData(data => {
      // Focus-report mode may be present in a replay. It never grants input.
      if (data === '\u001b[I' || data === '\u001b[O' || !activeId || !document.hasFocus() || !running(sessionById(activeId) || {})) return;
      void api.write({ sessionId: activeId, data }).then(checked).catch(error => notice(error.message));
    });
    scheduleFit();
  }

  async function select(sessionId, { focus = true } = {}) {
    const session = sessionById(sessionId);
    if (!session) return;
    const selection = ++selecting;
    detached.delete(sessionId); activeId = sessionId;
    $('terminal').hidden = false; $('empty').hidden = true; $('session-bar').hidden = false;
    createTerminal(); render();
    $('connection').textContent = 'Attaching to session…';
    try {
      checked(await api.select(sessionId));
      if (selection !== selecting || activeId !== sessionId) return;
      $('connection').textContent = running(session) ? 'Attached · closing this window keeps the session running' : `Session ${statusOf(session).toLowerCase()} · output retained`;
      scheduleFit();
      if (focus) term?.focus();
    } catch (error) {
      if (selection !== selecting) return;
      $('connection').textContent = 'Session unavailable'; notice(error.message);
    }
  }
  function showEmpty() {
    ++selecting; activeId = null; disposeTerminal();
    $('terminal').hidden = true; $('empty').hidden = false; $('session-bar').hidden = true;
    $('connection').textContent = snapshot.connected === false ? 'Session Keeper unavailable · reopen the preview to reconnect' : 'Session Keeper connected · no session attached';
    render();
  }
  function renderTabs() {
    const fragment = document.createDocumentFragment();
    for (const session of snapshot.sessions) {
      const id = idOf(session);
      if (detached.has(id)) continue;
      const tab = node('button', undefined, 'tab');
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(activeId === id));
      tab.setAttribute('aria-controls', 'terminal'); tab.tabIndex = activeId === id ? 0 : -1;
      tab.title = `${kindOf(session)} · ${clean(session.cwd)} · ${statusOf(session)}`;
      tab.append(node('span', undefined, `dot ${toneOf(session)}`), node('span', `${kindOf(session)} · ${leaf(session.cwd)}`, 'tab-label'));
      tab.addEventListener('click', () => { void select(id); });
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = snapshot.sessions.filter(item => !detached.has(idOf(item)));
        const index = tabs.findIndex(item => idOf(item) === id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault(); void select(idOf(tabs[next]), { focus: false });
        requestAnimationFrame(() => $('tabs').querySelector('[aria-selected="true"]')?.focus());
      });
      fragment.append(tab);
    }
    $('tabs').replaceChildren(fragment);
    const session = sessionById(activeId);
    if (session) {
      $('session-kind').textContent = kindOf(session); $('session-cwd').textContent = clean(session.cwd);
      $('session-cwd').title = clean(session.cwd); $('stop').disabled = !running(session);
      if (term) term.options.disableStdin = !running(session);
      if (!running(session)) $('connection').textContent = `Session ${statusOf(session).toLowerCase()} · output retained`;
    }
  }
  function addMetric(list, name, value) { list.append(node('dt', name), node('dd', value)); }
  function costText(value) {
    if (Number.isFinite(value)) return `$${value.toFixed(2)}`;
    if (value && typeof value === 'object') {
      if (Number.isFinite(value.usd)) return `$${value.usd.toFixed(2)}`;
      if (Number.isFinite(value.amount)) return `${clean(value.currency || 'USD')} ${value.amount.toFixed(2)}`;
    }
    return typeof value === 'string' && value ? clean(value) : 'Unavailable';
  }
  function renderOverview() {
    $('keeper-count').textContent = snapshot.sessions.length;
    const sessions = document.createDocumentFragment();
    for (const session of snapshot.sessions) {
      const id = idOf(session), button = node('button', undefined, `keeper-session${activeId === id ? ' selected' : ''}`);
      button.title = clean(session.cwd);
      const text = node('span', undefined, 'keeper-text');
      text.append(node('span', `${kindOf(session)} · ${leaf(session.cwd)}`, 'keeper-title'), node('span', `${statusOf(session)}${session.pid ? ` · PID ${session.pid}` : ''}${detached.has(id) ? ' · detached' : ''}`, 'keeper-meta'));
      if (Number.isFinite(session.outputBytes) && session.outputBytes >= 0) text.append(node('span', `${bytesText(session.outputBytes)} output`, 'keeper-meta'));
      button.append(node('span', undefined, `dot ${toneOf(session)}`), text, node('span', activeId === id ? '↵' : '↗', 'keeper-arrow'));
      button.addEventListener('click', () => { void select(id); }); sessions.append(button);
    }
    if (!snapshot.sessions.length) sessions.append(node('p', 'No sessions started. Choose New shell, Claude, or Codex to begin.', 'overview-empty'));
    $('keeper-sessions').replaceChildren(sessions);
    const rows = snapshot.rows, agents = document.createDocumentFragment();
    let needs = 0;
    for (const row of rows) {
      if (toneOf(row) === 'needs') needs++;
      const card = node('article', undefined, 'agent-card'), heading = node('div', undefined, 'agent-heading');
      heading.append(node('span', undefined, `dot ${toneOf(row)}`), node('h4', row.title || row.label || 'Agent session', 'agent-title'));
      card.append(heading, node('p', row.status || row.bucket || 'Status unavailable', 'agent-status'));
      if (row.project || row.cwd) card.append(node('p', row.project || row.cwd, 'agent-project'));
      const list = node('dl', undefined, 'telemetry');
      const provider = typeof row.provider === 'object' ? row.provider?.label : row.provider;
      if (provider) addMetric(list, 'Provider', provider);
      addMetric(list, 'Cost', costText(row.cost));
      const approvals = Number.isSafeInteger(row.approvals) ? row.approvals : Number.isSafeInteger(row.approvals?.count) ? row.approvals.count : Array.isArray(row.approvals) ? row.approvals.length : null;
      addMetric(list, 'Approvals', approvals === null ? 'Unavailable' : approvals);
      addMetric(list, 'Branch', row.branch || 'Unavailable');
      if (row.hostApp) addMetric(list, 'Terminal', row.hostApp);
      if (row.freshness) addMetric(list, 'Freshness', row.freshness);
      else if (Number.isFinite(row.age_ms) && row.age_ms >= 0) addMetric(list, 'Last reported', row.age_ms < 60_000 ? 'Within a minute' : `${Math.floor(row.age_ms / 60_000)} min ago`);
      card.append(list);
      const matching = snapshot.sessions.find(session => idOf(session) === (row.keeperSessionId || row.ref?.tabId));
      if (matching) {
        const open = node('button', 'Open terminal'); open.addEventListener('click', () => { void select(idOf(matching)); }); card.append(open);
      } else card.append(node('p', 'External session · overview only', 'source-note'));
      agents.append(card);
    }
    if (!rows.length) agents.append(node('p', 'No agent telemetry has been reported. Terminal sessions work independently; agent activity appears when Plexiform reports it.', 'overview-empty'));
    $('agents').replaceChildren(agents);
    $('agent-count').textContent = rows.length;
    $('overview-summary').textContent = rows.length ? `${rows.length} observed ${rows.length === 1 ? 'agent' : 'agents'}` : 'No agent activity reported';
    $('attention').hidden = needs === 0; $('attention').textContent = `${needs} ${needs === 1 ? 'agent needs' : 'agents need'} your attention`;
  }
  function render() { renderTabs(); renderOverview(); }
  function update(state) {
    if (!state || typeof state !== 'object') return;
    if (Array.isArray(state.sessions)) snapshot.sessions = state.sessions.filter(session => session && typeof idOf(session) === 'string');
    if (Array.isArray(state.rows)) snapshot.rows = state.rows.filter(row => row && typeof row === 'object');
    if (typeof state.connected === 'boolean') snapshot.connected = state.connected;
    if (typeof state.development === 'boolean') $('development').hidden = !state.development;
    if (activeId && !sessionById(activeId)) showEmpty();
    render();
    const restore = !activeId && !spawning && snapshot.sessions.find(session => !detached.has(idOf(session)));
    if (restore) void select(idOf(restore), { focus: false });
  }

  for (const button of document.querySelectorAll('[data-spawn]')) button.addEventListener('click', async () => {
    if (spawning) return;
    spawning = true;
    document.querySelectorAll('[data-spawn]').forEach(item => { item.disabled = true; });
    try {
      const result = checked(await api.spawn({ kind: button.dataset.spawn }));
      if (result?.session) {
        const session = result.session, id = idOf(session);
        if (!sessionById(id)) snapshot.sessions.push(session);
        await select(id);
      }
    } catch (error) { notice(error.message); }
    finally { spawning = false; document.querySelectorAll('[data-spawn]').forEach(item => { item.disabled = false; }); }
  });
  $('detach').addEventListener('click', async () => {
    const id = activeId;
    if (!id) return;
    try {
      checked(await api.detach(id)); detached.add(id);
      const next = snapshot.sessions.find(session => idOf(session) !== id && !detached.has(idOf(session)));
      if (next) await select(idOf(next)); else showEmpty();
      notice('Tab detached. Its process stays in the Session Keeper; select it in the overview to reattach.');
    } catch (error) { notice(error.message); }
  });
  $('stop').addEventListener('click', async () => {
    if (!activeId) return;
    try { checked(await api.stop(activeId)); } catch (error) { notice(error.message); }
  });
  $('toggle-overview').addEventListener('click', () => {
    $('overview').hidden = !$('overview').hidden;
    $('toggle-overview').setAttribute('aria-expanded', String(!$('overview').hidden)); scheduleFit();
  });
  $('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
  document.addEventListener('keydown', event => {
    if (!event.metaKey || event.altKey || event.ctrlKey) return;
    if (event.key.toLowerCase() === 't' && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation(); document.querySelector('[data-spawn="shell"]').click();
    } else if (/^[1-9]$/.test(event.key)) {
      const tabs = snapshot.sessions.filter(session => !detached.has(idOf(session)));
      const target = tabs[Number(event.key) - 1];
      if (target) { event.preventDefault(); event.stopPropagation(); void select(idOf(target)); }
    }
  }, true);
  new ResizeObserver(scheduleFit).observe($('terminal'));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (term) term.options.theme = theme(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleFit(); });
  window.addEventListener('focus', () => { if (activeId) term?.focus(); });
  if (!api) { $('connection').textContent = 'Session Keeper connection unavailable'; notice('Open Plexiform Terminal as an app to connect to its Session Keeper.'); return; }
  let receivedLiveState = false;
  api.onState(state => { receivedLiveState = true; update(state); });
  api.onNotice(notice);
  api.onData(event => {
    if (!term || event?.sessionId !== activeId) return;
    if (event.reset) term.reset();
    if (typeof event.data !== 'string') return;
    try {
      const bytes = Uint8Array.from(atob(event.data), character => character.charCodeAt(0));
      term.write(bytes);
    } catch { notice('Terminal output could not be decoded. Detach and reattach to refresh it.'); }
  });
  void api.ready().then(state => {
    checked(state);
    if (!receivedLiveState) update(state);
    if (!activeId && snapshot.sessions.length) void select(idOf(snapshot.sessions[0]), { focus: false });
    else if (!activeId) showEmpty();
  }).catch(error => { $('connection').textContent = 'Session Keeper unavailable'; notice(error.message); });
})();
