// The "Stuck?" signal's view side: which sessions carry the flag that
// hooks/session-machine.js classify() sets, how the lamp and the words show
// it. Pure; main.js hands in the resolved look and the live sessions.
const minutes = (ms) => `${Math.max(1, Math.round(ms / 60000))}m`;

function stuckSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.stuck && Number.isFinite(s.stuck.sinceMs));
}

// The oldest quiet session leads: { count, tool, since, text } or null.
function summary(sessions) {
  const list = stuckSessions(sessions).sort((a, b) => b.stuck.sinceMs - a.stuck.sinceMs);
  if (!list.length) return null;
  const top = list[0].stuck;
  const since = minutes(top.sinceMs);
  return { count: list.length, tool: top.tool, since, text: `Stuck? ${top.tool ? `last tool ${top.tool} · ` : ''}since ${since}` };
}

// Amber on the lamp, but only over green: red (needs you, broken) and amber
// (already your turn) say more than "quiet", so they stay as they are.
function applyStuck(look, stuck) {
  if (!stuck || !look || look.lamp !== 'green') return look;
  return { ...look, lamp: 'amber', stuck: true };
}

module.exports = { stuckSessions, summary, applyStuck };
