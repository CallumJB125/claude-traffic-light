'use strict';
// The "Local models" card (plan "more features" wave 2, lane 7): what the
// Overview shows from one local-models overview() snapshot. Pure. Every
// command in `next.command` is shown as copyable text and never run.

const KIND = { ollama: 'Ollama', openai: 'OpenAI-compatible' };

// One next step per backend and health state.
function nextStep(id, kind, health, host) {
  const ollama = id === 'ollama' || (kind === 'ollama' && id !== 'lmstudio');
  if (health === 'not-running') {
    if (ollama) return { text: 'Open the Ollama app, or start it in a terminal:', command: 'ollama serve' };
    if (id === 'lmstudio') return { text: 'Open LM Studio, then start its local server in the Developer tab.', command: null };
    return { text: `Check that the server at ${host || 'this address'} is running and that the address is right.`, command: null };
  }
  if (health === 'no-models') {
    if (ollama) return { text: 'Pull a model first, for example:', command: 'ollama pull llama3.2' };
    if (id === 'lmstudio') return { text: 'Download and load a model in LM Studio.', command: null };
    return { text: 'Load a model on that server.', command: null };
  }
  return null;
}

const HEALTH_TEXT = { reachable: 'Running', 'not-running': 'Not running', 'no-models': 'Running, no models yet' };

// overview: { endpoints[], models[], detected[] } from createLocalModels().overview().
function localModelCard(overview) {
  const o = overview && typeof overview === 'object' ? overview : {};
  const endpoints = Array.isArray(o.endpoints) ? o.endpoints : [];
  const models = Array.isArray(o.models) ? o.models : [];
  const detected = Array.isArray(o.detected) ? o.detected : [];
  const byId = new Map();
  // Fixed loopback backends first (Ollama, LM Studio), answering or not; the other fixed ports only when they answer.
  for (const d of detected) if (d.reachable || d.id === 'ollama' || d.id === 'lmstudio') byId.set(d.id, { id: d.id, label: d.label, kind: d.kind, source: 'discovered', host: null, reachable: d.reachable, error: d.error ?? null });
  for (const e of endpoints) byId.set(e.id, { id: e.id, label: e.label, kind: e.kind, source: e.source, host: e.host ?? null, reachable: e.reachable, error: e.error ?? null });
  const backends = [...byId.values()].map((b) => {
    const mine = models.filter((m) => m.endpoint === b.id && m.reachable !== false).map((m) => ({ provider: m.provider, model: m.model, label: `Start a session with ${m.model}` }));
    const health = !b.reachable ? 'not-running' : mine.length ? 'reachable' : 'no-models';
    return {
      id: b.id, label: b.label, kind: KIND[b.kind] || b.kind, source: b.source, host: b.host,
      health, healthText: health === 'not-running' && b.error ? `${HEALTH_TEXT[health]}. ${b.error}` : HEALTH_TEXT[health],
      next: nextStep(b.id, b.kind, health, b.host), models: mine,
    };
  });
  const picker = backends.flatMap((b) => b.models.map((m) => ({ provider: m.provider, label: `${m.model} · ${b.label}` })));
  const ready = picker.length;
  const headline = ready ? `${ready} local model${ready === 1 ? '' : 's'} ready on this computer${backends.some((b) => b.source === 'configured') ? ' or your network' : ''}.`
    : backends.some((b) => b.health === 'no-models') ? 'A local model server is running but has no models yet.'
      : 'No local model server is running. Start Ollama or LM Studio to use a model on this computer.';
  return { headline, backends, picker, defaultProvider: picker[0]?.provider ?? null };
}

module.exports = { localModelCard, nextStep };
