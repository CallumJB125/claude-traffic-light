const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lightsApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  // main answers a failed save with {error}; surface it as a rejection so no caller stores it as the config
  saveConfig: async (partial) => {
    const r = await ipcRenderer.invoke('save-config', partial);
    if (r && r.error) throw new Error(r.error);
    return r;
  },
  resetRules: () => ipcRenderer.invoke('reset-rules'),
  openHatch: () => ipcRenderer.invoke('hatch:open'),
  removeCharacter: (id) => ipcRenderer.invoke('hatch:remove', id),
  burstChip: () => ipcRenderer.invoke('burst:chip'),
  burstUsage: (range) => ipcRenderer.invoke('burst:usage', range),
  limits: () => ipcRenderer.invoke('usage:limits'),
  getAggregateStatus: () => ipcRenderer.invoke('get-aggregate-status'),
  getStats: (days) => ipcRenderer.invoke('get-stats', days),
  exportStats: (format, days) => ipcRenderer.invoke('export-stats', format, days),
  getCosts: () => ipcRenderer.invoke('get-costs'),
  saveSpendLimits: (v) => ipcRenderer.invoke('save-spend-limits', v),
  openAiTools: () => ipcRenderer.invoke('usage:open-ai-tools'),
  openOptimiser: () => ipcRenderer.invoke('usage:open-optimiser'),
  openAutoAnswer: () => ipcRenderer.invoke('usage:open-auto-answer'),
  // Rules only save for now (src/auto-rules.js: nothing answers yet, and the tab says so); PLEXIFORM_SHOW_AUTOANSWER=0 hides it.
  showAutoAnswer: process.env.PLEXIFORM_SHOW_AUTOANSWER !== '0',
  modelMix: () => ipcRenderer.invoke('model-mix'),
  usageBundle: (q) => ipcRenderer.invoke('usage-bundle', q),
  workCost: () => ipcRenderer.invoke('work-cost'),
  exportWorkCost: () => ipcRenderer.invoke('work-cost-export'),
  costGuard: { report: () => ipcRenderer.invoke('cost-guard:report'), set: (v) => ipcRenderer.invoke('cost-guard:set', v), resume: () => ipcRenderer.invoke('cost-guard:resume') },
  previewSound: (name) => ipcRenderer.invoke('preview-sound', name),
  chooseSoundFile: () => ipcRenderer.invoke('choose-sound-file'),
  exportRules: (rules) => ipcRenderer.invoke('export-rules', rules),
  importRules: () => ipcRenderer.invoke('import-rules'),
  exportSetup: () => ipcRenderer.invoke('setup-export'),
  importSetupPick: () => ipcRenderer.invoke('setup-import-pick'),
  importSetupApply: (mode) => ipcRenderer.invoke('setup-import-apply', mode),
  connectAgent: (which) => ipcRenderer.invoke('connect-agent', which),
  signalEndpoint: () => ipcRenderer.invoke('signal-endpoint'),
  previewOnWidget: (look, ms) => ipcRenderer.invoke('preview-on-widget', look, ms),
  openPreferences: () => ipcRenderer.invoke('open-preferences'),
  cameos: {
    list: () => ipcRenderer.invoke('cameos-list'),
    chooseFile: () => ipcRenderer.invoke('cameos-choose-file'),
    add: (payload) => ipcRenderer.invoke('cameos-add', payload),
    remove: (id) => ipcRenderer.invoke('cameos-remove', id),
  },
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', callback),
  onShowView: (cb) => ipcRenderer.on('show-view', (e, v) => cb(v)),
  // Auto-answer rules: main says why a rule can't be saved (null = fine).
  checkAutoRule: (rule) => ipcRenderer.invoke('check-auto-rule', rule),
  onAutoRulePrefill: (cb) => ipcRenderer.on('auto-rule-prefill', (e, rule) => cb(rule)),
  // Widget rules from the community gallery: main checked and migrated them; the page still asks before loading.
  onOffer: (cb) => ipcRenderer.on('rules:offer', (e, rules) => cb(rules)),
  onMotionPaused: (cb) => ipcRenderer.on('motion-paused', (e, paused) => cb(paused)),
  onWindowFocus: (cb) => ipcRenderer.on('window-focus', (e, focused) => cb(focused)),
});

// "Share to gallery…" (src/gallery-publish.js): main builds and checks the item; the page names a kind, a ref and a draft token.
contextBridge.exposeInMainWorld('galleryPublishApi', {
  begin: (kind, ref) => ipcRenderer.invoke('gallery-publish:begin', String(kind), ref),
  draft: (kind, ref, meta) => ipcRenderer.invoke('gallery-publish:draft', String(kind), ref, meta),
  open: (token) => ipcRenderer.invoke('gallery-publish:open', String(token)),
  copy: (token) => ipcRenderer.invoke('gallery-publish:copy', String(token)),
});
// User characters: the list main has validated, and a nudge when it changes.
contextBridge.exposeInMainWorld('userCharacters', {
  list: () => ipcRenderer.invoke('characters:list'),
  onChange: (cb) => ipcRenderer.on('characters:changed', () => cb()),
});
