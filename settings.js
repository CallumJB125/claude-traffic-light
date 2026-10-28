    const inPane = (...p) => !window.SettingsPanes || window.SettingsPanes.inPane(...p); // R8-1: a pane document runs only its own sections' loaders
    const PANE = window.SettingsPanes ? window.SettingsPanes.current : null;
    // C4: in the Settings sheet (the chat-first preview only) the same key is "Show chats": the new chat and the task box.
    // The old page keeps its own words.
    if (PANE) {
      const box = document.getElementById('homeComposer');
      if (box?.parentElement) box.parentElement.lastChild.textContent = ' Show chats';
      const hint = document.getElementById('hint-home-composer');
      if (hint) hint.textContent = 'New chat and the task box. Turn it off if you only use your AI tools in your own terminals; Plexiform still shows those sessions, what needs you, the widget and the board as before.';
    }
    const workingInput = document.getElementById('workingStaleMinutes');
    const waitingInput = document.getElementById('waitingStaleHours');
    const soundInput = document.getElementById('sounds');
    const status = document.getElementById('status');
    const NOTIFY_KINDS = ['permission-ask', 'turn-failed', 'offline', 'stuck'];
    const syncNotifyKinds = () => { const on = document.getElementById('notifyOnStates').checked; for (const k of NOTIFY_KINDS) document.getElementById(`notify-${k}`).disabled = !on; };
    document.getElementById('notifyOnStates').addEventListener('change', syncNotifyKinds);

    async function load() {
      const config = await window.settingsApi.getConfig();
      workingInput.value = config.workingStaleMinutes;
      waitingInput.value = config.waitingStaleHours;
      document.getElementById('stuckMinutes').value = config.stuckMinutes ?? 5;
      soundInput.checked = config.sounds !== false;
      document.getElementById('notifyOnStates').checked = config.notifyOnStates !== false;
      for (const k of NOTIFY_KINDS) document.getElementById(`notify-${k}`).checked = (config.notifyStates || {})[k] !== false;
      syncNotifyKinds();
      const q = config.quietHours || {};
      document.getElementById('quietEnabled').checked = q.enabled === true;
      document.getElementById('quietStart').value = q.start || '22:00';
      document.getElementById('quietEnd').value = q.end || '07:00';
      const qDays = Array.isArray(q.days) ? q.days : [0, 1, 2, 3, 4, 5, 6];
      for (const box of document.querySelectorAll('#quiet-days input')) box.checked = qDays.includes(Number(box.dataset.day));
      document.getElementById('mutedProjects').value = (config.mutedProjects || []).join('\n');
      document.getElementById('showWidget').checked = config.showWidget !== false;
      document.getElementById('menuBarMode').checked = !!config.menuBarMode;
      document.getElementById('lowPower').value = ['auto', 'on', 'off'].includes(config.lowPower) ? config.lowPower : 'auto';
      document.getElementById('ghosttyDock').value = config.integrations?.ghosttyDock === 'off' ? 'off' : 'auto';
      document.getElementById('seasonal').checked = config.seasonal !== false;
      document.getElementById('askFromWidget').checked = !!config.askFromWidget;
      document.getElementById('oneKeyApprove').checked = config.oneKeyApprove === true;
      document.getElementById('showTasks').checked = config.showTasks !== false;
      document.getElementById('showAgents').checked = config.showAgents !== false;
      document.getElementById('agentRoster').checked = config.agentRoster !== false;
      const kinds = config.agentKinds || {};
      document.getElementById('kind-subagent').checked = kinds.subagent !== false;
      document.getElementById('kind-teammate').checked = kinds.teammate !== false;
      document.getElementById('kind-ralph').checked = kinds.ralph !== false || kinds.ultrawork !== false;
      document.getElementById('agentChipSize').value = ['small', 'normal', 'large'].includes(config.agentChipSize) ? config.agentChipSize : 'normal';
      document.getElementById('roam').checked = config.roam !== false;
      document.getElementById('randomEvents').checked = config.randomEvents !== false;
      document.getElementById('gitSignals').checked = config.gitSignals !== false;
      document.getElementById('gitRepos').value = (config.gitRepos || []).join(', ');
      document.getElementById('gitDeployWorkflows').value = (config.gitDeployWorkflows || []).join(', ');
      loadSpend(config.spend || {}); // F1 spend
      document.getElementById('remoteTailscale').checked = !!config.remoteTailscale;
      document.getElementById('teamSessionSharing').checked = config.teamSessionSharing !== false;
      document.getElementById('teamBrief').checked = config.teamBrief === true;
      document.getElementById('explainMode').checked = config.explainMode === true;
      document.getElementById('agentMailInbox').checked = config.agentMailInbox === true;
      const bus = config.agentBus || {};
      document.getElementById('agentBusEnabled').checked = bus.enabled !== false;
      document.getElementById('agentBusAutoAccept').checked = bus.autoAccept !== false;
      document.getElementById('agentBusAuto').checked = bus.scope !== 'listed';
      document.getElementById('agentBusRepos').value = (bus.repos || []).join('\n');
      document.getElementById('agentBusExclude').value = (bus.exclude || []).join('\n');
      document.getElementById('agentBusWallClock').value = bus.wallClockMin ?? 20;
      document.getElementById('agentBusCaps').checked = bus.caps?.enabled === true;
      document.getElementById('agentBusMemberUsd').value = bus.caps?.memberUsd ?? 20;
      document.getElementById('agentBusHandoffUsd').value = bus.caps?.handoffUsd ?? 5;
      document.getElementById('remoteInteractionHost').checked = config.remoteInteractionHost === true;
      document.getElementById('codexDaemonMessaging').checked = config.codexDaemonMessaging === true;
      document.getElementById('busyHold').checked = config.busyHold !== false;
      document.getElementById('slackPresence').checked = config.slackPresence === true;
      document.getElementById('busyCalendar').checked = !!config.busyCalendar;
      document.getElementById('busyCalendarTitles').checked = !!config.busyCalendarTitles;
      document.getElementById('busyFocus').checked = config.busyFocus !== false;
      document.getElementById('busyIcsUrl').value = config.busyIcsUrl || '';
      document.getElementById('busyFocusShortcut').value = config.busyFocusShortcut || '';
      document.getElementById('simpleMode').checked = config.simpleMode === true;
      document.getElementById('homeComposer').checked = config.homeComposer !== false;
      document.body.classList.toggle('simple', config.simpleMode === true);
      showBusy();
    }
    document.getElementById('simpleMode').addEventListener('change', (e) => document.body.classList.toggle('simple', e.target.checked));
    // The colour key (src/colour-legend.js): one meaning per lamp colour, the same everywhere.
    if (window.PlexiformLegend) {
      document.getElementById('legend').replaceChildren(...window.PlexiformLegend.LEGEND.map((e) => {
        const li = document.createElement('li');
        const g = document.createElement('span'); g.className = `glyph ${e.colour}`; g.textContent = e.glyph; g.setAttribute('aria-hidden', 'true');
        const t = document.createElement('span'); t.textContent = `${e.label}: ${e.meaning}. ${e.detail}`;
        li.append(g, t); return li;
      }));
    }

    // One click: ticking the calendar saves it at once, and that save is what
    // shows macOS's one-time access prompt. It is off until then.
    document.getElementById('busyCalendar').addEventListener('change', async (e) => {
      try { await window.settingsApi.saveConfig({ busyCalendar: e.target.checked }); flash(); } catch (err) { flash(err); }
      setTimeout(showBusy, 1500);
    });

    // What each busy source can actually see right now.
    const CAL_WORDS = {
      fullAccess: ['Connected.', true],
      notDetermined: ['Waiting for macOS calendar access. If no prompt appeared, untick and tick this again.', false],
      denied: ['Calendar access is off. Turn on Plexiform in System Settings › Privacy & Security › Calendars.', false],
      restricted: ['Calendar access is blocked on this Mac (a profile or Screen Time).', false],
      writeOnly: ['Plexiform has “Add Events Only” access, which can’t see when you’re busy. Switch it to Full Access in System Settings › Privacy & Security › Calendars.', false],
      missing: ['Not available in this build (the calendar helper is missing). An ICS feed still works.', false],
    };
    const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    async function showBusy() {
      if (!inPane('notifications')) return;
      let st;
      try { st = await window.settingsApi.busyStatus(); } catch { return; }
      const cal = document.getElementById('busy-calendar-state');
      const words = st.calendar.on ? CAL_WORDS[st.calendar.status] || ['Checking…', false] : ['', false];
      cal.textContent = words[0] + (words[1] && st.calendar.next ? ` Next busy: ${hhmm(st.calendar.next)}.` : '');
      cal.className = `busy-state${words[1] ? ' ok' : ''}`;
      // macOS dropped a grant it had given (an update signed differently does
      // that): one click asks again, instead of untick-and-tick.
      if (st.calendar.on && st.calendar.reset) {
        cal.textContent = 'macOS forgot Plexiform’s calendar access (this can happen after an update).';
        cal.className = 'busy-state';
        const again = document.createElement('button');
        again.type = 'button';
        again.className = 'secondary';
        again.style.marginLeft = '6px';
        again.style.padding = '1px 8px';
        again.textContent = 'Reconnect calendar';
        again.addEventListener('click', async () => { again.disabled = true; try { await window.settingsApi.busyReconnectCalendar(); } finally { showBusy(); } });
        cal.append(again);
      }
      if (st.calendar.on && ['denied', 'writeOnly'].includes(st.calendar.status)) {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'secondary';
        open.style.marginLeft = '6px';
        open.style.padding = '1px 8px';
        open.textContent = 'Open Privacy settings';
        open.addEventListener('click', () => window.settingsApi.busyOpenPrivacy());
        cal.append(open);
      }
      const focus = document.getElementById('busy-focus-state');
      focus.textContent = !st.focus.on ? '' : st.focus.via ? `Reading Focus ${st.focus.via === 'shortcut' ? 'through your Shortcut' : 'directly'}${st.focus.focused ? ` — on now${st.focus.mode ? ` (${st.focus.mode})` : ''}` : ''}.`
        : st.focus.error === 'no-access' ? 'Can’t read Focus here without Full Disk Access — use a Focus Shortcut below.' : st.focus.error ? `Focus unavailable: ${st.focus.error}` : 'Checking…';
      focus.className = `busy-state${st.focus.via ? ' ok' : ''}`;
      const ics = document.getElementById('busy-ics-state');
      ics.textContent = !st.ics.on ? '' : st.ics.error ? `Couldn’t load it: ${st.ics.error}` : st.ics.fetchedAt ? `Loaded ${st.ics.events} event${st.ics.events === 1 ? '' : 's'}.` : 'Loading…';
      ics.className = `busy-state${st.ics.on && !st.ics.error && st.ics.fetchedAt ? ' ok' : ''}`;
    }
    const commaList = (id) => document.getElementById(id).value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50);

    // ── F1 spend ──
    const spendEl = (id) => document.getElementById(`spend-${id}`);
    function loadSpend(sp) {
      spendEl('mode').value = sp.mode === 'subscription' ? 'subscription' : 'api';
      spendEl('daily').value = sp.dailyBudget || 0;
      spendEl('weekly').value = sp.weeklyBudget || 0;
      spendEl('warn').value = Math.round((sp.warnAt || 0.8) * 100);
      spendEl('runaway-dollars').value = sp.runawayDollars ?? 40;
      spendEl('runaway-tokens').value = Math.round((sp.runawayTokens || 0) / 1000);
      spendEl('runaway-minutes').value = sp.runawayMinutes || 20;
      spendEl('notify-runaway').checked = sp.notifyRunaway !== false;
      spendEl('notify-budget-warning').checked = sp.notifyBudgetWarning !== false;
      spendEl('notify-budget-exceeded').checked = sp.notifyBudgetExceeded !== false;
    }
    function spendSettings() {
      const n = (id) => Math.max(0, Number(spendEl(id).value) || 0);
      return {
        mode: spendEl('mode').value,
        dailyBudget: n('daily'),
        weeklyBudget: n('weekly'),
        warnAt: Math.min(1, Math.max(0.1, n('warn') / 100 || 0.8)),
        runawayDollars: n('runaway-dollars'),
        runawayTokens: n('runaway-tokens') * 1000,
        runawayMinutes: Math.min(240, Math.max(1, n('runaway-minutes') || 20)),
        notifyRunaway: spendEl('notify-runaway').checked,
        notifyBudgetWarning: spendEl('notify-budget-warning').checked,
        notifyBudgetExceeded: spendEl('notify-budget-exceeded').checked,
      };
    }
    if (inPane('spend')) window.settingsApi.spend().then((sp) => {
      if (!sp) { spendEl('now').textContent = 'Reading your transcripts…'; return; }
      const eq = sp.mode === 'subscription' ? ' (API-price equivalent)' : '';
      const n = sp.budget.week.unpriced;
      spendEl('now').textContent = `So far: $${sp.budget.day.spent.toFixed(2)} today, $${sp.budget.week.spent.toFixed(2)} this week${eq}.${n ? ` ${n} turn${n === 1 ? '' : 's'} unpriced (unknown model), not counted.` : ''}`;
    }).catch(() => {});
    // ── end F1 spend ──

    async function saveAll() {
      try {
      const payload = {
        workingStaleMinutes: Math.max(1, Math.min(60, Number(workingInput.value) || 6)),
        stuckMinutes: Math.max(0, Math.min(60, Math.round(Number(document.getElementById('stuckMinutes').value) || 0))),
        waitingStaleHours: Math.max(1, Math.min(24, Number(waitingInput.value) || 4)),
        sounds: soundInput.checked,
        quietHours: {
          enabled: document.getElementById('quietEnabled').checked,
          start: document.getElementById('quietStart').value || '22:00',
          end: document.getElementById('quietEnd').value || '07:00',
          days: [...document.querySelectorAll('#quiet-days input')].filter((b) => b.checked).map((b) => Number(b.dataset.day)),
        },
        mutedProjects: document.getElementById('mutedProjects').value.split('\n').map((x) => x.trim()).filter(Boolean),
        notifyOnStates: document.getElementById('notifyOnStates').checked,
        notifyStates: Object.fromEntries(NOTIFY_KINDS.map((k) => [k, document.getElementById(`notify-${k}`).checked])),
        showWidget: document.getElementById('showWidget').checked,
        menuBarMode: document.getElementById('menuBarMode').checked,
        lowPower: document.getElementById('lowPower').value,
        integrations: { ghosttyDock: document.getElementById('ghosttyDock').value },
        seasonal: document.getElementById('seasonal').checked,
        askFromWidget: document.getElementById('askFromWidget').checked,
        oneKeyApprove: document.getElementById('oneKeyApprove').checked,
        showTasks: document.getElementById('showTasks').checked,
        showAgents: document.getElementById('showAgents').checked,
        agentRoster: document.getElementById('agentRoster').checked,
        agentKinds: {
          subagent: document.getElementById('kind-subagent').checked,
          teammate: document.getElementById('kind-teammate').checked,
          ralph: document.getElementById('kind-ralph').checked,
          ultrawork: document.getElementById('kind-ralph').checked,
        },
        agentChipSize: document.getElementById('agentChipSize').value,
        roam: document.getElementById('roam').checked,
        randomEvents: document.getElementById('randomEvents').checked,
        gitSignals: document.getElementById('gitSignals').checked,
        gitRepos: commaList('gitRepos'),
        gitDeployWorkflows: commaList('gitDeployWorkflows'),
        spend: spendSettings(), // F1 spend
        busyHold: document.getElementById('busyHold').checked,
        slackPresence: document.getElementById('slackPresence').checked,
        busyCalendar: document.getElementById('busyCalendar').checked,
        busyCalendarTitles: document.getElementById('busyCalendarTitles').checked,
        busyFocus: document.getElementById('busyFocus').checked,
        busyIcsUrl: document.getElementById('busyIcsUrl').value.trim().slice(0, 2000),
        busyFocusShortcut: document.getElementById('busyFocusShortcut').value.trim().slice(0, 100),
        remoteTailscale: document.getElementById('remoteTailscale').checked,
        teamSessionSharing: document.getElementById('teamSessionSharing').checked,
        teamBrief: document.getElementById('teamBrief').checked,
        explainMode: document.getElementById('explainMode').checked,
        agentMailInbox: document.getElementById('agentMailInbox').checked,
        agentBus: {
          enabled: document.getElementById('agentBusEnabled').checked,
          autoAccept: document.getElementById('agentBusAutoAccept').checked,
          scope: document.getElementById('agentBusAuto').checked ? 'auto' : 'listed',
          repos: document.getElementById('agentBusRepos').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 100),
          exclude: document.getElementById('agentBusExclude').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 100),
          wallClockMin: Math.round(Number(document.getElementById('agentBusWallClock').value) || 20),
          caps: { enabled: document.getElementById('agentBusCaps').checked, memberUsd: Number(document.getElementById('agentBusMemberUsd').value) || 20, handoffUsd: Number(document.getElementById('agentBusHandoffUsd').value) || 5 },
        },
        remoteInteractionHost: document.getElementById('remoteInteractionHost').checked,
        codexDaemonMessaging: document.getElementById('codexDaemonMessaging').checked,
        simpleMode: document.getElementById('simpleMode').checked,
        homeComposer: document.getElementById('homeComposer').checked,
      };
      // R8-1: a pane document saves only the keys its pane owns (main refuses a write with any other key, whole).
      const body = PANE ? window.SettingsPanes.pick(payload, window.SettingsPanes.ownedKeys(PANE)) : payload;
      if (PANE && !Object.keys(body).length) return; // this pane's controls write nothing through the page-wide save
      await window.settingsApi.saveConfig(body);
      if (inPane('phone')) setTimeout(showInteractionHost, 1500);
      if (inPane('notifications')) setTimeout(showBusy, 1500);
      if (inPane('phone')) showRemote(await window.settingsApi.remoteDevices());
      flash();
      } catch (err) { flash(err); }
    }

    let flashTimer = null;
    function flash(err) {
      clearTimeout(flashTimer);
      status.className = err ? 'err' : '';
      status.setAttribute('role', err ? 'alert' : 'status');
      status.textContent = err ? `Save failed — ${err.message}` : 'Saved';
      flashTimer = setTimeout(() => { status.textContent = ''; status.className = ''; status.setAttribute('role', 'status'); }, err ? 6000 : 2500);
    }
    window.showSaved = flash;

    // Every control saves when it changes. Voice, Compactor, crash reports and
    // the calendar tick keep their own saves (and say Saved themselves); boards
    // and the device name only fill in a form for their button.
    let saving = Promise.resolve();
    const OWN_SAVE = /^(voice-|compact-|native-board-|remote-name$|busyCalendar$)/;
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (!t.matches || !t.matches('input, select, textarea') || OWN_SAVE.test(t.id || '') || t.closest('#backups, #health, #privacy')) return;
      saving = saving.then(saveAll);
    });

    const SECTIONS = PANE ? window.SettingsPanes.NAV : ['general', 'notifications', 'spend', 'widget', 'privacy', 'advanced'];
    // R8-2a: a pane document shows the elements tagged data-pane=<its pane>, wherever they sit; the old page keeps its six div.pane.
    if (PANE) {
      const nav = document.getElementById('section-nav');
      nav.replaceChildren(...window.SettingsPanes.NAV.map((id) => { const b = document.createElement('button'); b.type = 'button'; b.dataset.go = id; b.textContent = window.SettingsPanes.TITLE[id]; return b; }));
      for (const p of document.querySelectorAll('.pane')) {
        for (const c of p.children) c.classList.toggle('not-pane', c.dataset.pane !== PANE);
        p.dataset.section = [...p.children].some((c) => c.dataset.pane === PANE) ? PANE : '';
      }
      document.getElementById('answering-title').textContent = 'Answering from the widget';
      document.getElementById('agent-mail-pointer').textContent = 'Agent mail (teammates\' AI questions and hand-offs to you) is under Agent messages.';
    }
    function showSection(id) {
      if (!SECTIONS.includes(id)) id = 'general';
      // R8-1: a pane document never swaps panes in place; another pane is another document (main opens it, pane senders only).
      if (PANE && window.SettingsPanes.ACCOUNT_NAV[id]) { window.settingsApi.goAccount?.(id); return; }
      if (PANE && id !== PANE) { window.settingsApi.goPane?.(id); return; }
      for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.section !== id;
      for (const b of document.querySelectorAll('#section-nav button')) { if (b.dataset.go === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
      try { history.replaceState(null, '', `?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), section: id })}`); } catch { /* embedded pages may refuse */ }
    }
    window.showSettingsSection = showSection;
    document.getElementById('go-widget-answering')?.addEventListener('click', () => { showSection('widget'); document.getElementById('askFromWidget')?.focus(); });
    for (const b of document.querySelectorAll('#section-nav button')) b.addEventListener('click', () => { showSection(b.dataset.go); document.body.scrollTop = 0; });
    showSection(PANE || new URLSearchParams(location.search).get('section') || location.hash.slice(1));


    const showCli = (r) => {
      const el = document.getElementById('cli-status');
      if (!r) return;
      if (r.cancelled) { el.textContent = 'Not installed.'; return; }
      if (r.error) { el.textContent = r.error; return; }
      if (r.installed || r.ok) el.textContent = `Installed at ${r.link}. If your shell can't find plexiform, add ~/.local/bin to your PATH.`;
      else if (r.blocked) el.textContent = `Something else is already at ${r.link}; Plexiform won't replace it.`;
      else el.textContent = `Creates a link at ${r.link}. You'll be asked to confirm first.`;
    };
    if (inPane('general')) window.settingsApi.cliStatus().then(showCli);
    document.getElementById('cli-install').addEventListener('click', async () => showCli(await window.settingsApi.cliInstall()));
    // Terminal access (QoL4b): one row per installed terminal, then Accessibility. Test only for a terminal macOS can
    // still ask about; once it has said no, the row points at System Settings instead (macOS won't ask again).
    const accessNote = document.getElementById('terminal-access-note');
    const showAccess = (rows) => {
      const list = document.getElementById('terminal-access-list');
      list.replaceChildren();
      for (const r of Array.isArray(rows) ? rows : []) {
        const li = document.createElement('li');
        li.className = 'row terminal-access-row';
        li.dataset.state = String(r.state || '');
        const name = document.createElement('strong');
        name.textContent = String(r.app || '');
        const text = document.createElement('span');
        text.textContent = ` ${String(r.text || '')}${r.fix ? ` ${String(r.fix)}` : ''}`;
        li.append(name, text);
        const acts = Array.isArray(r.actions) ? r.actions : [];
        if (acts.includes('test')) {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'secondary'; b.textContent = 'Test';
          b.setAttribute('aria-label', `Test ${String(r.app || '')}`);
          b.addEventListener('click', async () => {
            b.disabled = true;
            accessNote.textContent = `Testing ${String(r.app || '')}… If macOS asks, choose OK.`;
            try { const res = await window.settingsApi.terminalAccess('test', r.app); accessNote.textContent = res && res.note ? res.note : ''; if (res) showAccess(res.rows); } catch (err) { accessNote.textContent = err.message; }
            b.disabled = false;
          });
          li.append(b);
        }
        if (acts.includes('open-settings')) {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'secondary'; b.textContent = 'Open settings';
          b.setAttribute('aria-label', `Open System Settings for ${String(r.app || '')}`);
          b.addEventListener('click', () => window.settingsApi.terminalAccess('open', r.needs === 'accessibility' ? 'accessibility' : 'automation'));
          li.append(b);
        }
        list.append(li);
      }
      for (const id of ['terminal-access', 'terminal-access-title']) document.getElementById(id).hidden = !list.childElementCount;
    };
    if (inPane('terminal')) window.settingsApi.terminalAccess('view').then((res) => showAccess(res && res.rows), () => showAccess([]));
    // Ghostty Dock: Install only where it can be installed and isn't yet; Check again when installed but not usable.
    const showDock = (r, note) => {
      if (!r) return;
      const install = document.getElementById('ghostty-dock-install');
      const recheck = document.getElementById('ghostty-dock-recheck');
      const off = document.getElementById('ghosttyDock').value === 'off';
      install.hidden = off || r.show !== 'install';
      recheck.hidden = off || r.show !== 'recheck';
      install.disabled = false;
      const el = document.getElementById('ghostty-dock-status');
      el.textContent = note || r.message || r.error || (r.cancelled ? 'Not installed.' : '')
        || (r.launched || r.watching ? 'Terminal is open with the installer. Press Return there to install; Plexiform checks for Ghostty Dock every few seconds.' : '')
        || (r.show === 'recheck' ? `Installed, but not used yet: ${r.reason}.` : r.reason === 'ready' ? 'Installed and in use.' : '');
    };
    const dockAct = async (action) => {
      if (!inPane('terminal')) return;
      try { showDock(await window.settingsApi.ghosttyDock(action)); } catch (err) { showDock({}, err.message); }
    };
    dockAct('status');
    document.getElementById('ghostty-dock-install').addEventListener('click', (ev) => { ev.currentTarget.disabled = true; dockAct('install'); });
    document.getElementById('ghostty-dock-recheck').addEventListener('click', () => dockAct('recheck'));
    document.getElementById('ghostty-dock-github').addEventListener('click', () => dockAct('github'));
    document.getElementById('ghosttyDock').addEventListener('change', () => setTimeout(() => dockAct('status'), 300));
    window.settingsApi.onGhosttyDockChanged((r) => { showDock(r); document.getElementById('health-recheck')?.click(); });
    if (inPane('aitools')) window.settingsApi.signalEndpoint().then((e) => { document.getElementById('endpoint').textContent = `http://127.0.0.1:${e.port}/signal`; document.getElementById('emit-path').textContent = e.emit; if (e.token) document.getElementById('token-path').textContent = e.token; });
    const showGit = (g) => {
      if (!g) return;
      const n = g.repos.length;
      document.getElementById('git-status').textContent = !g.enabled ? ''
        : g.hint ? g.hint
        : g.state === 'ok' ? `Watching ${n} repo${n === 1 ? '' : 's'} as @${g.login}${g.rate ? ` · ${g.rate.remaining} GitHub requests left this hour` : ''}.`
        : g.state === 'rate-limited' || g.state === 'backoff' ? `GitHub didn't answer (${g.error}); trying again later.`
        : '';
    };
    if (inPane('projects')) window.settingsApi.gitStatus().then(showGit);

    const remoteEl = (id) => document.getElementById(`remote-${id}`);
    const ago = (iso) => {
      const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
      return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
    };
    // textContent throughout: device names come from this window, but a
    // hand-edited devices.json shouldn't be able to inject markup.
    function showRemote(v) {
      if (!v) return;
      document.querySelectorAll('.remote-port').forEach((el) => { el.textContent = v.port; });
      const list = remoteEl('list');
      list.replaceChildren(...v.devices.map((d) => {
        const li = document.createElement('li');
        const who = document.createElement('div'); who.className = 'who';
        const name = document.createElement('span'); name.textContent = d.name;
        const meta = document.createElement('span');
        meta.textContent = d.pairing === 'expired' ? 'Code expired unused: revoke and pair again'
          : d.pairing === 'waiting' ? 'Waiting for the device to use its code'
          : `${d.lastSeenAt ? `seen ${ago(d.lastSeenAt)}` : 'not seen since Plexiform started'} · ${d.sessions} live session${d.sessions === 1 ? '' : 's'}`;
        who.append(name, meta);
        const revoke = document.createElement('button');
        revoke.type = 'button'; revoke.className = 'secondary'; revoke.textContent = 'Revoke';
        revoke.setAttribute('aria-label', `Revoke ${d.name}`);
        // Said beside the button it's about, and gone again when it disarms.
        const note = document.createElement('span');
        note.className = 'revoke-note';
        note.setAttribute('role', 'status');
        note.setAttribute('aria-live', 'polite');
        revoke.addEventListener('click', async () => {
          if (!revoke.dataset.armed) {
            revoke.dataset.armed = '1'; revoke.textContent = 'Revoke now?'; revoke.classList.add('armed');
            note.textContent = `Click again to revoke ${d.name}. Its key stops working at once.`;
            setTimeout(() => { delete revoke.dataset.armed; revoke.textContent = 'Revoke'; revoke.classList.remove('armed'); note.textContent = ''; }, 4000);
            return;
          }
          const r = await window.settingsApi.remoteRevoke(d.id);
          remoteEl('pair-status').textContent = r.revoked ? `Revoked ${d.name}. Its key no longer works.` : `${d.name} was already gone.`;
          showRemote(r);
        });
        li.append(who, revoke, note);
        return li;
      }));
      const lb = v.loopback || {};
      remoteEl('listener').textContent = lb.error ? lb.error : lb.listening ? `Listening for devices on 127.0.0.1:${v.port}.` : 'Not listening for devices in this run.';
      const t = v.tailnet;
      remoteEl('tailnet').textContent = !t.enabled ? 'Listens on this Mac\'s Tailscale address only, for signed device events and nothing else.'
        : t.listening ? `Listening on ${t.address}:${v.port} for signed device events only.`
        : t.error || 'Not listening yet.';
    }
    remoteEl('pair').addEventListener('click', async () => {
      const r = await window.settingsApi.remotePair(remoteEl('name').value);
      if (r.error) { remoteEl('pair-status').textContent = r.error; return; }
      remoteEl('pair-status').textContent = `Paired ${r.paired.name}.`;
      remoteEl('name').value = '';
      remoteEl('code-name').textContent = r.paired.name;
      remoteEl('code-where').textContent = r.paired.name;
      // The name as the ssh host when it can be one; otherwise say what goes there.
      remoteEl('code-host').textContent = /^[A-Za-z0-9._-]+$/.test(r.paired.name) ? r.paired.name : `<${r.paired.name}'s ssh address>`;
      remoteEl('code-text').textContent = r.code;
      remoteEl('code').hidden = false;
      showRemote(r);
    });
    remoteEl('copy').addEventListener('click', async () => { if (await window.settingsApi.remoteCopyCode(remoteEl('code-text').textContent)) remoteEl('pair-status').textContent = 'Code copied; the clipboard forgets it in a minute.'; });
    remoteEl('done').addEventListener('click', () => { remoteEl('code-text').textContent = ''; remoteEl('code').hidden = true; });
    if (inPane('phone')) window.settingsApi.remoteDevices().then(showRemote);
    async function showInteractionHost() { document.getElementById('interaction-host-status').textContent = (await window.settingsApi.interactionHostStatus().catch(() => null)) ?? ''; }
    if (inPane('phone')) showInteractionHost();
    const pvStatus = document.getElementById('privacy-status');
    const pvDone = (r) => { pvStatus.textContent = !r ? '' : r.error ? r.error : (r.file || r.path) ? `Saved ${r.file || r.path}` : typeof r === 'string' && r ? `Could not open the folder: ${r}` : ''; };
    document.getElementById('privacy-export-stats').addEventListener('click', async () => pvDone(await window.settingsApi.exportStats('json', 60)));
    document.getElementById('privacy-export-setup').addEventListener('click', async () => pvDone(await window.settingsApi.exportSetup()));
    document.getElementById('privacy-folder').addEventListener('click', async () => pvDone(await window.settingsApi.showDataFolder()));
    if (inPane('privacy')) window.settingsApi.privacyText().then((t) => {
      document.getElementById('privacy-body').innerHTML = t ? window.renderPrivacy(t) : '<p>The privacy notice could not be loaded.</p>';
    });
    // ── Health ──
    // Run only when the section is on screen: the checks touch the disk and
    // ~/.claude, which a Preferences visit for something else needn't.
    const HEALTH_MARK = { ok: '✓', warn: '!', fail: '✕', info: 'i' };
    const HEALTH_SAY = { ok: 'OK', warn: 'Warning', fail: 'Problem', info: 'Note' };
    const healthSummary = document.getElementById('health-summary');
    function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function checkRow(c) {
      const li = el('li', 'check');
      li.dataset.status = c.status;
      li.dataset.check = c.id;
      const mark = el('span', 'mark', HEALTH_MARK[c.status] || '?');
      mark.setAttribute('aria-hidden', 'true');
      const name = el('span', 'name', c.label);
      name.prepend(el('span', 'visually-hidden', `${HEALTH_SAY[c.status] || c.status}: `));
      const line = el('div', 'line');
      // A long path in a detail keeps its start and its file, not four lines.
      const shorten = (p) => { const parts = p.split('/'); return parts.length > 5 ? [...parts.slice(0, 3), '…', ...parts.slice(-2)].join('/') : `${p.slice(0, 16)}…${p.slice(-24)}`; };
      const detail = el('span', 'detail', c.detail.replace(/\(([^()]{40,})\)/g, (m, p) => `(${shorten(p)})`));
      if (detail.textContent !== c.detail) detail.title = c.detail;
      line.append(name, detail);
      li.append(mark, line);
      const next = c.status !== 'ok' && c.next ? c.next : null;
      if (c.fix) {
        const act = el('div', 'act');
        const b = el('button', 'secondary', c.fixLabel || 'Fix');
        b.type = 'button';
        b.addEventListener('click', async () => {
          b.disabled = true;
          b.textContent = 'Fixing…';
          try {
            const res = await window.settingsApi.healthFix(c.fix);
            showHealth(res.report, res.error ? `${c.fixLabel} didn't work: ${res.error}` : null);
          } catch (err) {
            b.disabled = false;
            b.textContent = c.fixLabel || 'Fix';
            showSummary('err', `${c.fixLabel} didn't work: ${err.message}`);
          }
        });
        act.append(b);
        if (next) act.append(el('div', 'next', next));
        li.append(act);
      } else if (next) li.append(el('div', 'next', next));
      return li;
    }
    function showSummary(state, text) { healthSummary.dataset.state = state; healthSummary.textContent = text; }
    function showHealth(r, error) {
      if (!r) return;
      const bad = r.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
      const fine = bad.length ? r.checks.filter((c) => !bad.includes(c)) : [];
      document.getElementById('health-checks').replaceChildren(...(bad.length ? bad : r.checks).map(checkRow));
      document.getElementById('health-fine-checks').replaceChildren(...fine.map(checkRow));
      document.getElementById('health-fine-count').textContent = `${fine.length} check${fine.length === 1 ? '' : 's'} fine`;
      document.getElementById('health-fine').hidden = !fine.length;
      const n = bad.length;
      if (error) showSummary('err', error);
      else {
        const noFix = bad.some((c) => !c.fix);
        const what = n === 1 ? (noFix ? 'thing needs attention' : 'thing to fix') : (noFix ? 'things need attention' : 'things to fix');
        showSummary(!n ? 'ok' : bad.some((c) => c.status === 'fail') ? 'fail' : 'warn', n ? `${n} ${what}` : 'Everything looks fine');
      }
    }
    let healthRanAt = 0;
    const refreshHealth = () => {
      if (!inPane('advanced')) return Promise.resolve();
      healthRanAt = Date.now();
      if (!healthSummary.textContent) showSummary('', 'Checking…');
      return window.settingsApi.health().then((r) => showHealth(r)).catch((err) => showSummary('err', `Couldn't run the checks: ${err.message}`));
    };
    // First sight runs them once; after that, Check again or the tray's
    // Health… (which reruns, then scrolls here without a second run).
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !healthRanAt) refreshHealth();
    }).observe(document.getElementById('health'));
    document.getElementById('health-recheck').addEventListener('click', refreshHealth);
    document.getElementById('health-copy').addEventListener('click', async () => {
      const hint = document.getElementById('health-copy-hint');
      try {
        const r = await window.settingsApi.copyDiagnostics();
        hint.textContent = `Copied ${r.lines} lines to the clipboard, scrubbed of home paths, folder names and tokens.`;
      } catch (err) { hint.textContent = `Couldn't copy: ${err.message}`; }
    });
    window.settingsApi.onShowSection((id) => {
      if (id === 'widget') { showSection('widget'); return; }
      if (id !== 'health') return;
      showSection('advanced');
      refreshHealth();
      document.getElementById('health').scrollIntoView({ block: 'start' });
    });
    // ── end Health ──

    load();
    // The Widget page and the tray change some of these keys too: re-read on return so a later save keeps them.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load().catch(() => {}); });
    // A kept-alive pane gets no visibilitychange when it is shown again: main says so, and it re-reads (R8-1).
    window.settingsApi.onShown?.(() => { load().catch(() => {}); });

    // ── Voice (F7) ── its own saves, kept out of the page-wide list.
    (async () => {
      if (!inPane('general')) return;
      const hotkey = document.getElementById('voice-hotkey');
      const longPress = document.getElementById('voice-longPress');
      const askClaude = document.getElementById('voice-askClaude');
      const screenOn = document.getElementById('voice-screen');
      const point = document.getElementById('voice-point');
      const preset = document.getElementById('voice-preset');
      const screenHint = document.getElementById('voice-screen-hint');
      const screenIntro = screenHint.textContent;
      const hint = document.getElementById('voice-hint');
      const intro = hint.textContent;
      const [config, st] = await Promise.all([window.settingsApi.getConfig(), window.settingsApi.voiceStatus()]);
      for (const h of st.hotkeys) hotkey.append(new Option(h.label, h.accelerator));
      const v = config.voice || {};
      hotkey.value = v.hotkey || '';
      longPress.checked = v.longPress !== false;
      askClaude.checked = !!v.askClaude;
      screenOn.checked = v.screen === true;
      point.checked = v.point !== false;
      const syncScreen = (access) => {
        point.disabled = !st.available || !screenOn.checked;
        screenHint.textContent = screenOn.checked && access && access !== 'granted' && access !== 'unsupported'
          ? 'Turn on Screen Recording for Plexiform in System Settings, Privacy and Security, Screen Recording. Until then questions are answered without the screen.'
          : screenIntro;
      };
      syncScreen(st.screenAccess);
      const show = (cur) => {
        hint.textContent = !st.available ? st.reason
          : cur.taken ? `${cur.taken} is taken by another app — pick another key.`
            : intro;
      };
      show({ taken: st.hotkeyTaken });
      // The one-click preset only exists where the helper does (it starts hidden in the HTML).
      preset.hidden = !st.available;
      if (!st.available) for (const el of [hotkey, longPress, askClaude, screenOn, point, preset]) el.disabled = true;
      // Pointing starts on with the screen switch; turning the screen on resets it to on.
      screenOn.addEventListener('change', () => { if (screenOn.checked) point.checked = true; });
      const save = async () => {
        await window.settingsApi.saveConfig({ voice: { hotkey: hotkey.value || null, longPress: longPress.checked, askClaude: askClaude.checked, screen: screenOn.checked, point: point.checked } });
        flash();
        const now = await window.settingsApi.voiceStatus();
        show({ taken: now.hotkeyTaken });
        syncScreen(now.screenAccess);
      };
      const fail = (err) => { flash(err); hint.textContent = `Save failed — ${err.message}`; };
      for (const el of [hotkey, longPress, askClaude, screenOn, point]) el.addEventListener('change', () => save().catch(fail));
      preset.addEventListener('click', () => { hotkey.value = st.preset; save().catch(fail); });
    })();

    // ── Compactor ── its own saves. Numbers come only from recorded before/after counts.
    (async () => {
      if (!inPane('aitools')) return;
      const $ = (id) => document.getElementById(`compact-${id}`);
      const NAMES = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini', local: 'Local model' };
      const fmt = (n) => Math.abs(n).toLocaleString();
      const showThreshold = () => { $('threshold-value').textContent = `${$('threshold').value}%`; };
      const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
      // Payback: turns until the one-time reduction has paid for the compaction itself.
      const payback = (p) => (!p ? '' : p.kind === 'about' ? `pays back after about ${plural(p.turns, 'more turn')}`
        : p.kind === 'at-least' ? `pays back after at least ${plural(p.turns, 'more turn')} (estimate: its cost was not reported, so this counts only the context it had to read)`
        : p.kind === 'never' ? 'never pays back: the context did not get smaller'
        : p.kind === 'unknown' ? 'payback unknown: its cost was not reported' : '');
      const show = (st) => {
        const saved = $('saved'), last = $('last');
        if (!st) { saved.textContent = 'Not available right now.'; last.textContent = ''; return; }
        const t = st.total;
        if (!t.compactions) saved.textContent = 'Nothing compacted yet.';
        else if (!t.measured) saved.textContent = `${plural(t.compactions, 'compaction')}, not measured yet: the reduction is known after the next turn reports its token count.`;
        else {
          const parts = [];
          if (t.providerMeasured) {
            parts.push(t.reducedTokens >= 0
              ? `Context reduced by ${fmt(t.reducedTokens)} tokens a turn across ${plural(t.providerMeasured, 'compaction')} (the provider's own counts, the turn before vs the turn after)`
              : `Context grew by ${fmt(t.reducedTokens)} tokens: the summaries were larger than what they replaced`);
            if (t.costReported) parts.push(`The compactions themselves cost ${fmt(t.costTokens)} tokens (reported by the provider)`);
            if (t.costUnknown) parts.push(`${plural(t.costUnknown, 'compaction')} did not report ${t.costUnknown === 1 ? 'its' : 'their'} own cost${t.unknownCostFloorTokens ? `; ${t.costUnknown === 1 ? 'it' : 'each'} read its whole context, so at least ${fmt(t.unknownCostFloorTokens)} tokens (estimate)` : ''}`);
            const pb = payback(t.payback);
            if (pb) parts.push(pb[0].toUpperCase() + pb.slice(1));
          }
          if (t.estimatedReducedTokens) parts.push(`Local models: about ${fmt(t.estimatedReducedTokens)} tokens reduced for about ${fmt(t.estimatedCostTokens)} tokens of summarising (estimates, ~4 characters a token)`);
          saved.textContent = parts.length ? `${parts.join('. ')}.` : 'No measured change yet.';
        }
        const l = st.last;
        if (!l) { last.textContent = ''; return; }
        const src = l.source === 'provider' ? 'reported by the provider' : 'estimated';
        const what = l.reduced === null ? 'not measured (the provider reported no token counts)'
          : `context ${fmt(l.before)} → ${fmt(l.after)} tokens (${src}); compaction cost ${l.costSource === 'unknown' ? 'not reported' : `${fmt(l.cost)} tokens (${l.costSource === 'provider' ? 'reported by the provider' : 'estimated'})`}${payback(l.payback) ? `; ${payback(l.payback)}` : ''}`;
        last.textContent = `Last: ${NAMES[l.provider] || l.provider}, ${new Date(l.at).toLocaleString()}, ${what}.`;
      };
      const SOURCES = { learned: 'learned', override: 'your own setting', fixed: 'the one setting', off: 'never compacted' };
      const showLearned = (l) => {
        const box = $('burst-learned');
        box.replaceChildren();
        box.hidden = !l || !l.repos.length;
        if (box.hidden) return;
        box.append(document.createTextNode(l.intelligent ? `Burst's learned Compact at per repository (from the last ${plural(l.windowDays, 'day')}; change it in the Burst dashboard):` : 'Burst\'s Compact at per repository (change it in the Burst dashboard):'));
        const ul = document.createElement('ul');
        for (const r of l.repos) {
          const li = document.createElement('li');
          li.textContent = `${r.name}: ${r.source === 'off' || !r.inForce ? 'never compacted' : `${fmt(r.inForce)} tokens (${SOURCES[r.source]})`}`;
          ul.append(li);
        }
        box.append(ul);
      };
      const withNote = (st) => { show(st); showLearned(st?.burstLearned); if (st?.burstNote) $('saved').textContent = `${st.burstNote}, so Plexiform's own Claude compactor is off. ${$('saved').textContent}`; };
      const st = await window.settingsApi.compactionStats().catch(() => null);
      const s = st?.settings || {};
      $('enabled').checked = s.enabled === true;
      $('codex').checked = s.providers?.codex === true;
      $('threshold').value = Math.round((s.threshold || 0.55) * 100);
      showThreshold();
      withNote(st);
      const save = async () => {
        const cur = (await window.settingsApi.getConfig()).compaction || {};
        await window.settingsApi.saveConfig({ compaction: { ...cur, enabled: $('enabled').checked, providers: { ...cur.providers, codex: $('codex').checked }, threshold: Number($('threshold').value) / 100 } });
        flash();
        withNote(await window.settingsApi.compactionStats().catch(() => null));
      };
      $('threshold').addEventListener('input', showThreshold);
      for (const el of [$('enabled'), $('codex'), $('threshold')]) el.addEventListener('change', () => save().catch((err) => { flash(err); $('saved').textContent = `Save failed — ${err.message}`; }));
    })();
