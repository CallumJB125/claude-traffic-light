'use strict';
// QoL3b: what a click on one of Plexiform's session notifications does, and its buttons. Pure; main runs the result.
//   clickPlan(n, row, isRemote?) → {kind:'jump'} | {kind:'note', body} | {kind:'none'}: never silent for a session notification.
//   actionsFor(n, {row, stop}) → [{text, run}] with run 'stop' | 'overview' | 'snooze'. The array that builds the
//   buttons is the one an action index is read against, so an index can never pick another button.
//   pick(list, details, legacyIndex) → the chosen entry or null (a bad or out-of-range index runs nothing, review S3).
// A device name as a note may show it: no control or direction characters, at most 60 characters.
function deviceLabel(name) {
  const s = [...String(typeof name === 'string' ? name : '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim()];
  return s.length ? s.slice(0, 60).join('') : 'another device';
}

const remoteId = (id) => typeof id === 'string' && id.startsWith('remote:');
const remoteRow = (row) => !!(row && (row.remote || row.device));

// isRemote(row): main's host check (src/focus/jump.js isRemote), asked of the row and of the bare id.
function clickPlan(n, row, isRemote = null) {
  const id = n && typeof n.sessionId === 'string' && n.sessionId ? n.sessionId : null;
  if (!id) return n && (n.hostApp || n.kind === 'runaway') ? { kind: 'jump' } : { kind: 'none' };
  const hostRemote = typeof isRemote === 'function' && ((row && isRemote(row)) || isRemote({ sessionId: id }));
  if (remoteId(id) || remoteRow(row) || hostRemote) return { kind: 'note', body: `That session runs on ${deviceLabel(row && row.deviceName)}. Answer it there.` };
  if (!row) return { kind: 'note', body: "That session isn't running any more." };
  return { kind: 'jump' };
}

const STOP = Object.freeze({ text: 'Stop session', run: 'stop' });
const OVERVIEW = Object.freeze({ text: 'Show in Overview', run: 'overview' });
const SNOOZE = Object.freeze({ text: 'Snooze 1 hour', run: 'snooze' });

function actionsFor(n, { row = null, stop = false, isRemote = null } = {}) {
  const local = !!(row && !remoteRow(row) && n && typeof n.sessionId === 'string' && !remoteId(n.sessionId) && clickPlan(n, row, isRemote).kind === 'jump');
  if (n && n.kind === 'runaway') return [...(stop ? [STOP] : []), ...(local ? [OVERVIEW] : [])];
  return local ? [OVERVIEW, SNOOZE] : [];
}

function pick(list, details, legacyIndex) {
  const raw = details && typeof details === 'object' && 'actionIndex' in details ? details.actionIndex : legacyIndex;
  if (!Number.isInteger(raw) || raw < 0 || !Array.isArray(list) || raw >= list.length) return null;
  return list[raw];
}

module.exports = { clickPlan, actionsFor, pick, deviceLabel, STOP, OVERVIEW, SNOOZE };
