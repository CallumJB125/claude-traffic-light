    const workingInput = document.getElementById('workingStaleMinutes');
    const waitingInput = document.getElementById('waitingStaleHours');
    const soundInput = document.getElementById('soundOnAmber');
    const status = document.getElementById('status');
    const NOTIFY_KINDS = ['permission-ask', 'turn-failed', 'offline'];
    const syncNotifyKinds = () => { const on = document.getElementById('notifyOnStates').checked; for (const k of NOTIFY_KINDS) document.getElementById(`notify-${k}`).disabled = !on; };
    document.getElementById('notifyOnStates').addEventListener('change', syncNotifyKinds);

    async function load() {
      const config = await window.settingsApi.getConfig();
      workingInput.value = config.workingStaleMinutes;
      waitingInput.value = config.waitingStaleHours;
      soundInput.checked = config.soundOnAmber;
      document.getElementById('notifyOnStates').checked = config.notifyOnStates !== false;
      for (const k of NOTIFY_KINDS) document.getElementById(`notify-${k}`).checked = (config.notifyStates || {})[k] !== false;
      syncNotifyKinds();
      document.getElementById('showWidget').checked = config.showWidget !== false;
      document.getElementById('menuBarMode').checked = !!config.menuBarMode;
      document.getElementById('seasonal').checked = config.seasonal !== false;
      document.getElementById('askFromWidget').checked = !!config.askFromWidget;
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
      document.getElementById('busyHold').checked = config.busyHold !== false;
      document.getElementById('busyCalendar').checked = !!config.busyCalendar;
      document.getElementById('busyCalendarTitles').checked = !!config.busyCalendarTitles;
      document.getElementById('busyFocus').checked = config.busyFocus !== false;
      document.getElementById('busyIcsUrl').value = config.busyIcsUrl || '';
      document.getElementById('busyFocusShortcut').value = config.busyFocusShortcut || '';
      showBusy();
    }

    // One click: ticking the calendar saves it at once, and that save is what
    // shows macOS's one-time access prompt. It is off until then.
    document.getElementById('busyCalendar').addEventListener('change', async (e) => {
      try { await window.settingsApi.saveConfig({ busyCalendar: e.target.checked }); } catch { /* Save reports errors */ }
      setTimeout(showBusy, 1500);
    });

    // What each busy source can actually see right now.
    const CAL_WORDS = {
      fullAccess: ['Connected.', true],
      notDetermined: ['Waiting for macOS calendar access. If no prompt appeared, untick and tick this again.', false],
      denied: ['Calendar access is off. Turn on Claude Buddy in System Settings › Privacy & Security › Calendars.', false],
      restricted: ['Calendar access is blocked on this Mac (a profile or Screen Time).', false],
      writeOnly: ['Buddy has “Add Events Only” access, which can’t see when you’re busy. Switch it to Full Access in System Settings › Privacy & Security › Calendars.', false],
      missing: ['Not available in this build (the calendar helper is missing). An ICS feed still works.', false],
    };
    const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    async function showBusy() {
      let st;
      try { st = await window.settingsApi.busyStatus(); } catch { return; }
      const cal = document.getElementById('busy-calendar-state');
      const words = st.calendar.on ? CAL_WORDS[st.calendar.status] || ['Checking…', false] : ['', false];
      cal.textContent = words[0] + (words[1] && st.calendar.next ? ` Next busy: ${hhmm(st.calendar.next)}.` : '');
      cal.className = `busy-state${words[1] ? ' ok' : ''}`;
      // macOS dropped a grant it had given (an update signed differently does
      // that): one click asks again, instead of untick-and-tick.
      if (st.calendar.on && st.calendar.reset) {
        cal.textContent = 'macOS forgot Buddy’s calendar access (this can happen after an update).';
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
    window.settingsApi.spend().then((sp) => {
      if (!sp) { spendEl('now').textContent = 'Reading your transcripts…'; return; }
      const eq = sp.mode === 'subscription' ? ' (API-price equivalent)' : '';
      const n = sp.budget.week.unpriced;
      spendEl('now').textContent = `So far: $${sp.budget.day.spent.toFixed(2)} today, $${sp.budget.week.spent.toFixed(2)} this week${eq}.${n ? ` ${n} turn${n === 1 ? '' : 's'} unpriced (unknown model), not counted.` : ''}`;
    }).catch(() => {});
    // ── end F1 spend ──

    document.getElementById('save').addEventListener('click', async () => {
      try {
      await window.settingsApi.saveConfig({
        workingStaleMinutes: Math.max(1, Math.min(60, Number(workingInput.value) || 6)),
        waitingStaleHours: Math.max(1, Math.min(24, Number(waitingInput.value) || 4)),
        soundOnAmber: soundInput.checked,
        notifyOnStates: document.getElementById('notifyOnStates').checked,
        notifyStates: Object.fromEntries(NOTIFY_KINDS.map((k) => [k, document.getElementById(`notify-${k}`).checked])),
        showWidget: document.getElementById('showWidget').checked,
        menuBarMode: document.getElementById('menuBarMode').checked,
        seasonal: document.getElementById('seasonal').checked,
        askFromWidget: document.getElementById('askFromWidget').checked,
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
        busyCalendar: document.getElementById('busyCalendar').checked,
        busyCalendarTitles: document.getElementById('busyCalendarTitles').checked,
        busyFocus: document.getElementById('busyFocus').checked,
        busyIcsUrl: document.getElementById('busyIcsUrl').value.trim().slice(0, 2000),
        busyFocusShortcut: document.getElementById('busyFocusShortcut').value.trim().slice(0, 100),
        remoteTailscale: document.getElementById('remoteTailscale').checked,
      });
      setTimeout(showBusy, 1500);
      showRemote(await window.settingsApi.remoteDevices());
      status.className = '';
      status.textContent = 'Saved';
      setTimeout(() => (status.textContent = ''), 2500);
      } catch (err) {
        status.className = 'err';
        status.textContent = `Save failed — ${err.message}`;
        status.setAttribute('role', 'alert');
        setTimeout(() => { status.textContent = ''; status.className = ''; status.setAttribute('role', 'status'); }, 6000);
      }
    });

    document.querySelectorAll('[data-agent]').forEach((b) => b.addEventListener('click', async () => {
      const r = await window.settingsApi.connectAgent(b.dataset.agent);
      document.getElementById('connect-hint').textContent = r && r.ok ? `Connected ${b.textContent}: wrote ${r.file}. Restart it to pick up the hooks.`
        : r && r.error ? `Did not connect ${b.textContent}: in ${r.file}, ${r.error}` : 'Could not connect.';
    }));
    const mcpToggle = document.getElementById('mcp-toggle');
    const showMcp = (st) => {
      mcpToggle.dataset.on = st.installed ? '1' : '';
      mcpToggle.textContent = st.installed ? 'Disable Claude integration' : 'Enable Claude integration';
      if (st.error) document.getElementById('mcp-hint').textContent = `Could not update ${st.path}: ${st.error}`;
      else if (st.installed && !st.current) document.getElementById('mcp-hint').textContent = 'Registered, but pointing at an older copy of Buddy. Disable and enable again to update it.';
    };
    mcpToggle.addEventListener('click', async () => showMcp(await window.settingsApi.mcpSetEnabled(!mcpToggle.dataset.on)));
    window.settingsApi.mcpStatus().then(showMcp);
    window.settingsApi.signalEndpoint().then((e) => { document.getElementById('endpoint').textContent = `http://127.0.0.1:${e.port}/signal`; document.getElementById('emit-path').textContent = e.emit; if (e.token) document.getElementById('token-path').textContent = e.token; });
    const showGit = (g) => {
      if (!g) return;
      const n = g.repos.length;
      document.getElementById('git-status').textContent = !g.enabled ? ''
        : g.hint ? g.hint
        : g.state === 'ok' ? `Watching ${n} repo${n === 1 ? '' : 's'} as @${g.login}${g.rate ? ` · ${g.rate.remaining} GitHub requests left this hour` : ''}.`
        : g.state === 'rate-limited' || g.state === 'backoff' ? `GitHub didn't answer (${g.error}); trying again later.`
        : '';
    };
    window.settingsApi.gitStatus().then(showGit);

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
          : `${d.lastSeenAt ? `seen ${ago(d.lastSeenAt)}` : 'not seen since Buddy started'} · ${d.sessions} live session${d.sessions === 1 ? '' : 's'}`;
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
    window.settingsApi.remoteDevices().then(showRemote);
    const pvStatus = document.getElementById('privacy-status');
    const pvDone = (r) => { pvStatus.textContent = !r ? '' : r.error ? r.error : (r.file || r.path) ? `Saved ${r.file || r.path}` : typeof r === 'string' && r ? `Could not open the folder: ${r}` : ''; };
    document.getElementById('privacy-export-stats').addEventListener('click', async () => pvDone(await window.settingsApi.exportStats('json', 60)));
    document.getElementById('privacy-export-setup').addEventListener('click', async () => pvDone(await window.settingsApi.exportSetup()));
    document.getElementById('privacy-folder').addEventListener('click', async () => pvDone(await window.settingsApi.showDataFolder()));
    window.settingsApi.privacyText().then((t) => {
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
      if (id !== 'health') return;
      refreshHealth();
      document.getElementById('health').scrollIntoView({ block: 'start' });
    });
    // ── end Health ──
    load();

    // ── Voice (F7) ── its own saves, so the Save button's list stays untouched.
    (async () => {
      const hotkey = document.getElementById('voice-hotkey');
      const longPress = document.getElementById('voice-longPress');
      const askClaude = document.getElementById('voice-askClaude');
      const hint = document.getElementById('voice-hint');
      const intro = hint.textContent;
      const [config, st] = await Promise.all([window.settingsApi.getConfig(), window.settingsApi.voiceStatus()]);
      for (const h of st.hotkeys) hotkey.append(new Option(h.label, h.accelerator));
      const v = config.voice || {};
      hotkey.value = v.hotkey || '';
      longPress.checked = v.longPress !== false;
      askClaude.checked = !!v.askClaude;
      const show = (cur) => {
        hint.textContent = !st.available ? st.reason
          : cur.taken ? `${cur.taken} is taken by another app — pick another key.`
            : intro;
      };
      show({ taken: st.hotkeyTaken });
      if (!st.available) for (const el of [hotkey, longPress, askClaude]) el.disabled = true;
      const save = async () => {
        await window.settingsApi.saveConfig({ voice: { hotkey: hotkey.value || null, longPress: longPress.checked, askClaude: askClaude.checked } });
        const now = await window.settingsApi.voiceStatus();
        show({ taken: now.hotkeyTaken });
      };
      for (const el of [hotkey, longPress, askClaude]) el.addEventListener('change', () => save().catch((err) => { hint.textContent = `Save failed — ${err.message}`; }));
    })();
