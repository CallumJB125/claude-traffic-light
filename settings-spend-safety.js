// Preferences → Spend: your Claude plan, the API-price toggle and per-project
// daily caps (src/spend-safety-main.js stores them in spend-safety.json).
(() => {
  const api = window.settingsApi && window.settingsApi.spendSafety;
  const $ = (id) => document.getElementById(id);
  if (!api || !$('safety-plan')) return;
  const capsText = (caps) => Object.entries(caps || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  function parseCaps(text) {
    const out = {};
    for (const line of String(text).split('\n')) {
      const m = /^\s*(.+?)\s*=\s*\$?\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
      if (m) out[m[1]] = Number(m[2]);
    }
    return out;
  }
  function showNow(v) {
    const LABEL = { api: 'API key', pro: 'Claude Pro', max5: 'Claude Max 5x', max20: 'Claude Max 20x' };
    // A gateway or cloud provider bills Claude Code itself, so no Claude plan applies (A10).
    const ROUTED = {
      gateway: 'Claude Code goes through a gateway (ANTHROPIC_BASE_URL), so that service bills it, not a Claude plan.',
      cloud: 'Claude Code runs on a cloud provider (Bedrock, Vertex AI or Foundry), which bills it per token, not a Claude plan.',
    };
    $('safety-detected').textContent = ROUTED[v.detected] || (v.detected ? `Claude Code says: ${LABEL[v.detected]}.` : 'Plexiform could not tell your plan from Claude Code, so pick it here.');
    if (!v.subscriber || v.showDollars || !v.limits) return;
    // A subscriber who hasn't asked for API prices sees the limit estimate, not dollars.
    $('spend-now').textContent = `${v.limits.fiveHour.text}. ${v.limits.week.text}. (Estimate)`;
  }
  async function load() {
    try {
      const v = await api.get();
      if (!v) return;
      $('safety-plan').value = v.settings.plan;
      $('safety-show-api').checked = v.settings.showApiPrices;
      $('safety-caps').value = capsText(v.settings.projectCaps);
      $('safety-loops').checked = v.settings.notifyLoops;
      showNow(v);
    } catch {}
  }
  async function save() {
    const r = await api.set({ plan: $('safety-plan').value, showApiPrices: $('safety-show-api').checked, projectCaps: parseCaps($('safety-caps').value), notifyLoops: $('safety-loops').checked });
    $('safety-status').textContent = r && r.ok ? 'Saved.' : (r && r.error) || 'Could not save.';
    load();
  }
  for (const id of ['safety-plan', 'safety-show-api', 'safety-caps', 'safety-loops']) $(id).addEventListener('change', save);
  load();
})();
