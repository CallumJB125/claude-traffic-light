'use strict';
// The Settings sheet's panes (redesign R8-1): who may call which channel and write which config key.
// One table, read by main (the guards), by the pane pages (settings.js, as window.SettingsPanes) and by the
// tests that pin it. Authority never comes from this file's data about the page: main decides who a sender is
// from the page it created (fromUtilityPage(e, 'settings:<pane>')); the table only says what that pane may do.
// Preview only until R6a: every `settings:*` page exists only with the dev chat preview on.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else root.SettingsPanes = factory(root);
}(typeof self !== 'undefined' ? self : this, (root) => {
  // R8-1: the six panes settings.html already has (div.pane[data-section]), one to one. Re-splitting them into the
  // redesign's eleven panes is R8-2/3.
  const PANES = Object.freeze(['general', 'notifications', 'spend', 'widget', 'privacy', 'advanced']);

  // Every channel settings-preload.js exposes, with the one pane whose section uses it. 'none' = no pane may call
  // it (the old Settings page still can); get-config / save-config are filtered by KEY_OWNER instead.
  const CHANNEL_PANE = Object.freeze({
    'voice-status': 'general',
    'busy-status': 'notifications', 'busy-reconnect-calendar': 'notifications', 'busy-open-privacy': 'notifications',
    'get-spend': 'spend', 'spend-safety:get': 'spend', 'spend-safety:set': 'spend',
    'get-privacy': 'privacy', 'export-stats': 'privacy', 'setup-export': 'privacy', 'show-data-folder': 'privacy',
    'crash-reports:state': 'privacy', 'crash-reports:set-opt-in': 'privacy', 'crash-reports:export': 'privacy',
    'policy:state': 'privacy', 'policy:preview': 'privacy', 'policy:apply': 'privacy', 'policy:pick-folder': 'privacy',
    'data:inventory': 'privacy', 'data:export': 'privacy', 'data:export-activity': 'privacy', 'data:delete': 'privacy',
    'backups-list': 'privacy', 'backups-now': 'privacy', 'backups-diff': 'privacy', 'backups-restore': 'privacy', 'backups-open-folder': 'privacy',
    'interaction-host-status': 'privacy', 'open-feedback': 'privacy',
    'cli-install-status': 'advanced', 'cli-install': 'advanced', 'ghostty-dock-install': 'advanced', 'signal-endpoint': 'advanced',
    'native-board-status': 'advanced', 'native-board-boards': 'advanced', 'native-board-connect': 'advanced', 'native-board-disconnect': 'advanced',
    'git-status': 'advanced', 'deploy:settings': 'advanced', 'deploy:set-enabled': 'advanced', 'deploy:token-save': 'advanced', 'deploy:token-remove': 'advanced',
    'remote-devices': 'advanced', 'remote-pair': 'advanced', 'remote-revoke': 'advanced', 'remote-copy-code': 'advanced',
    'health-report': 'advanced', 'health-fix': 'advanced', 'health-copy-diagnostics': 'advanced', 'compaction-stats': 'advanced',
    'connect-agent': 'none', 'account-view': 'none', 'account-open': 'none',
    'burst:status': 'none', 'burst:consent-text': 'none', 'burst:action': 'none', 'burst:test': 'none', 'burst:set-compaction': 'none',
    'get-config': 'config', 'save-config': 'config',
  });

  // Every config key, with the one pane whose controls write it. 'none' = no pane writes it (set by the widget, the
  // tray or main). A key missing here is refused from every pane.
  const KEY_OWNER = Object.freeze({
    workingStaleMinutes: 'general', stuckMinutes: 'general', waitingStaleHours: 'general', voice: 'general',
    sounds: 'notifications', quietHours: 'notifications', mutedProjects: 'notifications', notifyOnStates: 'notifications', notifyStates: 'notifications',
    oneKeyApprove: 'notifications', busyHold: 'notifications', slackPresence: 'notifications', busyCalendar: 'notifications', busyCalendarTitles: 'notifications',
    busyFocus: 'notifications', busyIcsUrl: 'notifications', busyFocusShortcut: 'notifications', agentMailInbox: 'notifications',
    spend: 'spend',
    showWidget: 'widget', menuBarMode: 'widget', lowPower: 'widget', seasonal: 'widget', askFromWidget: 'widget', showTasks: 'widget', showAgents: 'widget',
    agentRoster: 'widget', agentKinds: 'widget', agentChipSize: 'widget', roam: 'widget', randomEvents: 'widget', simpleMode: 'widget', homeComposer: 'widget',
    teamSessionSharing: 'privacy', teamBrief: 'privacy', explainMode: 'privacy', remoteInteractionHost: 'privacy', codexDaemonMessaging: 'privacy',
    integrations: 'advanced', gitSignals: 'advanced', gitRepos: 'advanced', gitDeployWorkflows: 'advanced', remoteTailscale: 'advanced', agentBus: 'advanced', compaction: 'advanced',
    character: 'none', snoozeUntil: 'none', fastHook: 'none', keepAwake: 'none', paceTooltip: 'none', agentAwareness: 'none', mcpBusUserOff: 'none', mcpUserOff: 'none',
    remoteInteractionResetPending: 'none', autoAnswer: 'none', persona: 'none',
  });

  // Keys every pane may READ (never write): simpleMode decides which developer sections the page shows at all.
  const SHARED_READS = Object.freeze(['simpleMode']);

  const isPane = (p) => typeof p === 'string' && PANES.includes(p);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const ownedKeys = (pane) => (isPane(pane) ? Object.keys(KEY_OWNER).filter((k) => KEY_OWNER[k] === pane) : []);
  const readKeys = (pane) => (isPane(pane) ? [...new Set([...ownedKeys(pane), ...SHARED_READS])] : []);
  /** The channel's pane, or null for an unknown channel. */
  const paneOfChannel = (ch) => (typeof ch === 'string' && own(CHANNEL_PANE, ch) ? CHANNEL_PANE[ch] : null);
  /** True when every key of `partial` is owned by `pane` (an empty object is fine). */
  const writesAllowed = (pane, partial) => isPane(pane) && !!partial && typeof partial === 'object' && !Array.isArray(partial)
    && Object.keys(partial).every((k) => own(KEY_OWNER, k) && KEY_OWNER[k] === pane);
  const pick = (obj, keys) => { const o = {}; for (const k of keys) if (own(obj, k)) o[k] = obj[k]; return o; };
  /** A saved config as a pane may see it. */
  const readView = (pane, config) => pick(config || {}, readKeys(pane));
  /** The pane a page's ?pane= asks for: a known id or null. Only chooses what to render, never what is allowed. */
  const paneFromSearch = (search) => {
    let v = null;
    try { const all = new URLSearchParams(search).getAll('pane'); v = all.length === 1 ? all[0] : null; } catch { v = null; }
    return isPane(v) ? v : null;
  };

  /** In a pane document: the pane this page was loaded for (null = the whole old page). Rendering and loaders only; main decides authority. */
  const current = root && root.location && typeof root.location.search === 'string' ? paneFromSearch(root.location.search) : null;
  const inPane = (...panes) => current === null || panes.includes(current);

  return { current, inPane, PANES, CHANNEL_PANE, KEY_OWNER, SHARED_READS, isPane, ownedKeys, readKeys, paneOfChannel, writesAllowed, pick, readView, paneFromSearch };
}));
