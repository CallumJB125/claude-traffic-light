// Any tool without native hooks (Aider, OpenCode, Copilot CLI, Windsurf, Amp, …).
// Nothing is installed into the tool: `plexiform-run <tool> [args]` (see
// src/ai-tools-generic.js) launches it and reports start and exit. So the
// widget can show working → done/failed and nothing else: no prompts, no tool
// names, no answering. Payload: { tool, session, cwd, pid, code }.
const ID = /^[A-Za-z0-9_.-]{1,120}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.+-]{0,39}$/;

function normalize(event, payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  const base = { sessionId: typeof d.session === 'string' && ID.test(d.session) ? d.session : null, cwd: typeof d.cwd === 'string' && d.cwd.length < 500 && !/[\0\r\n]/.test(d.cwd) ? d.cwd : null, pid: Number.isInteger(d.pid) && d.pid > 1 ? d.pid : null, extra: {} };
  const tool = typeof d.tool === 'string' && NAME.test(d.tool) ? d.tool : null;
  if (event === 'start') return [{ ...base, signal: 'prompt-submit', tool }];
  if (event === 'stop') return [{ ...base, signal: 'stop', tool: null, pid: null }];
  if (event === 'exit') return [{ ...base, signal: Number(d.code) === 0 ? 'stop' : 'turn-failed', tool: null, pid: null }];
  return [];
}

module.exports = {
  id: 'generic',
  label: 'Custom tool',
  capabilities: { working: true, yourTurn: false, blocked: false, answer: false, subagents: false, limits: false, cost: false },
  transport: 'command',
  NAME,
  // Nothing of ours lives in the tool, so there is nothing to detect, install or strip.
  detect: () => false,
  normalize,
};
