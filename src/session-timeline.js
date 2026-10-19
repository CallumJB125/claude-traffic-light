'use strict';

// One session's timeline, oldest first: what the AI was asked, files edited,
// commands run, approvals asked and answered, turn ends with spend so far,
// checkpoint turns with +/- counts, and how it stands now. Read-only, from the
// local sources the handover already uses: the session's own transcript
// (src/handover-transcripts.js), its hook facts (hooks/handover-tap.js), the
// [state] lines Plexiform writes to app.log, and the "What changed" checkpoint
// turns (src/checkpoints.js). Everything but readTranscript is pure.

const path = require('node:path');
const Transcripts = require('./handover-transcripts.js');
const Usage = require('../usage.js');
const { redactSecretsPass } = require('./scrub.js');

const MAX_EVENTS = 3000;
const CAP = { prompt: 2000, reply: 8000, command: 500, path: 500 };
const EDIT = /^(?:Edit|Write|MultiEdit|NotebookEdit|apply_patch|write_file|replace|edit_file|create_file)$/i;
const READ = /^(?:Read|Grep|Glob|LS|NotebookRead|view_image|read_file|list_dir|search)$/i;
const DENIED = /doesn't want to proceed|tool use was rejected|permission (?:was )?denied|user (?:denied|rejected)/i;
const ENDED = new Set(['stop', 'session-end', 'turn-failed', 'limit-hit', 'idle', 'idle-nudge']);

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const isoOf = (v) => { const t = typeof v === 'string' ? Date.parse(v) : Number.isFinite(v) ? v : NaN; return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null; };
const parse = (s) => { if (typeof s !== 'string' || s.length > 512 * 1024) return null; try { return JSON.parse(s); } catch { return null; } };
const clip = (s, n) => { const t = String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n') : '');

// A model name as the timeline header shows it (letters, digits and . _ : / @ + -).
const MODEL = /^[A-Za-z0-9._:/@+-]{1,80}$/;
function usageCost(model, u) {
  const key = Usage.modelKey(model);
  if (!key || !obj(u)) return null;
  const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
  const cc = obj(u.cache_creation);
  return Usage.costOf({ input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cacheRead: Number(u.cache_read_input_tokens) || 0, cacheWrite, cacheWrite1h: cc ? Math.min(cacheWrite, Number(cc.ephemeral_1h_input_tokens) || 0) : 0 }, key);
}

function toolEvent(at, name, input) {
  // Only the parent transcript's explicit tool call is inspected. No child
  // transcript is discovered or read, and a request is not proof of execution.
  const delegated = /^(?:functions\.)?(?:collaboration\.)?(?:spawn_agent|followup_task|send_message|interrupt_agent|send_input|resume_agent|close_agent|wait_agent)$/.test(name)
    || /^(?:Agent|Task)$/.test(name);
  if (delegated) return { at, kind: 'delegation', tool: clip(name, 80),
    text: clip(input.prompt || input.message || '', CAP.prompt),
    target: clip(input.target || input.task_name || input.id || input.description || input.subagent_type || 'New subagent', 200) };
  const file = str(input.file_path) || str(input.notebook_path) || str(input.filePath) || str(input.path);
  const cmd = Transcripts.commandOf(input.command ?? input.cmd);
  if (str(cmd)) return { at, kind: 'command', text: clip(cmd, CAP.command) };
  if (file && EDIT.test(name)) return { at, kind: 'edit', path: clip(file, CAP.path) };
  if (file && READ.test(name)) return { at, kind: 'read', path: clip(file, CAP.path) };
  return { at, kind: 'tool', tool: clip(name, 80) };
}

function claudeEvents(lines) {
  const out = [], names = new Map(), delegated = new Map(), usage = new Map();
  let model = null;
  let reply = null;
  const push = (e) => { if (out.length < MAX_EVENTS) out.push(e); };
  const turnEnd = (at) => { if (out[out.length - 1]?.kind !== 'turn-end') push({ at, kind: 'turn-end', text: reply ? clip(reply, CAP.reply) : null }); reply = null; };
  for (const line of lines) {
    const d = parse(line);
    if (!obj(d) || d.isSidechain) continue;
    const at = isoOf(d.timestamp);
    if (!at) continue;
    const m = obj(d.message);
    if (d.type === 'user' && m && !d.isMeta) {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const r of blocks) {
        if (!r || r.type !== 'tool_result') continue;
        if (delegated.has(r.tool_use_id)) { push({ at, kind: 'delegation-result', tool: names.get(r.tool_use_id), target: delegated.get(r.tool_use_id), text: clip(textOf(r.content), CAP.reply), failed: !!r.is_error }); delegated.delete(r.tool_use_id); }
        if (!r.is_error) continue;
        const tool = names.get(r.tool_use_id) || null;
        push(DENIED.test(textOf(r.content)) ? { at, kind: 'approval', answer: 'denied', tool } : { at, kind: 'failed', tool });
      }
      if (blocks.some((c) => c && c.type === 'tool_result')) continue;
      const text = typeof m.content === 'string' ? m.content : textOf(blocks.filter((c) => c && c.type === 'text'));
      if (/^\s*\[Request interrupted/.test(text)) { push({ at, kind: 'interrupted' }); continue; }
      const p = Transcripts.promptText(text);
      if (p) push({ at, kind: 'prompt', text: clip(p, CAP.prompt) });
    } else if (d.type === 'assistant' && m && Array.isArray(m.content)) {
      if (MODEL.test(m.model ?? '') && m.model !== '<synthetic>') model = m.model;
      if (obj(m.usage)) usage.set(m.id && d.requestId ? `${m.id}:${d.requestId}` : d.uuid || `n${usage.size}`, { at, usd: usageCost(m.model, m.usage) });
      for (const c of m.content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'tool_use' && str(c.name)) {
          const event = toolEvent(at, c.name, obj(c.input) || {});
          if (typeof c.id === 'string' && names.size < 5000) { names.set(c.id, c.name); if (event.kind === 'delegation') delegated.set(c.id, event.target); }
          push(event);
        }
        else if (c.type === 'text' && str(c.text)) reply = c.text;
      }
      if (m.stop_reason === 'end_turn') turnEnd(at);
    } else if (d.type === 'system' && (d.subtype === 'stop_hook_summary' || d.subtype === 'turn_duration')) turnEnd(at);
  }
  return { events: out, usage: [...usage.values()], model };
}

function codexEvents(lines) {
  const out = [], delegated = new Map();
  let reply = null, lastPrompt = null;
  const push = (e) => { if (out.length < MAX_EVENTS) out.push(e); };
  const command = (c, at) => { const t = Transcripts.commandOf(c); if (!str(t)) return; const text = clip(t, CAP.command); const prev = out[out.length - 1]; if (!(prev && prev.kind === 'command' && prev.text === text)) push({ at, kind: 'command', text }); };
  const edit = (file, at) => { if (str(file)) push({ at, kind: 'edit', path: clip(String(file).replace(/^file:\/\//, ''), CAP.path) }); };
  const prompt = (t, at) => { const p = Transcripts.promptText(t); if (p && p !== lastPrompt) { lastPrompt = p; push({ at, kind: 'prompt', text: clip(p, CAP.prompt) }); } };
  for (const line of lines) {
    const d = parse(line);
    if (!obj(d)) continue;
    const at = isoOf(d.timestamp);
    if (!at) continue;
    const p = obj(d.payload) || {};
    if (d.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user') prompt(textOf(p.content), at);
      else if (p.type === 'message' && p.role === 'assistant') { const t = textOf(p.content); if (str(t)) reply = t; }
      else if (p.type === 'function_call' && str(p.name)) {
        const args = obj(typeof p.arguments === 'string' ? parse(p.arguments) : p.arguments) || {};
        if (args.command || args.cmd) command(args.command || args.cmd, at); else {
          const event = toolEvent(at, p.name, args);
          if (event.kind === 'delegation' && typeof p.call_id === 'string' && delegated.size < 5000) delegated.set(p.call_id, event);
          push(event);
        }
      } else if (p.type === 'function_call_output' && delegated.has(p.call_id)) {
        const event = delegated.get(p.call_id); delegated.delete(p.call_id);
        push({ at, kind: 'delegation-result', tool: event.tool, target: event.target, text: clip(typeof p.output === 'string' ? p.output : textOf(p.output), CAP.reply) });
      } else if (p.type === 'local_shell_call') command(p.action && p.action.command, at);
      else if (p.type === 'custom_tool_call' && p.name === 'apply_patch' && typeof p.input === 'string') for (const m of p.input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) edit(m[1].trim(), at);
      else if (p.type === 'custom_tool_call' && str(p.name)) push({ at, kind: 'tool', tool: clip(p.name, 80) });
    } else if (d.type === 'event_msg') {
      if (p.type === 'user_message') prompt(p.message, at);
      else if (p.type === 'agent_message' && str(p.message)) reply = p.message;
      else if (p.type === 'exec_approval_request' || p.type === 'apply_patch_approval_request') push({ at, kind: 'approval', answer: 'asked', tool: p.type === 'exec_approval_request' ? 'shell' : 'apply_patch' });
      else if (p.type === 'task_complete') { push({ at, kind: 'turn-end', text: str(p.last_agent_message) || reply ? clip(str(p.last_agent_message) || reply, CAP.reply) : null }); reply = null; }
      else if (p.type === 'turn_aborted') push({ at, kind: 'interrupted' });
      else if (p.type === 'item_completed' && obj(p.item)) {
        const it = p.item;
        if (it.type === 'CommandExecution') command(it.command, at);
        else if (it.type === 'FileChange' && obj(it.changes)) for (const f of Object.keys(it.changes).slice(0, 200)) edit(f, at);
      }
    }
  }
  return { events: out, usage: [] };
}

// A transcript file → { events, usage, partial }, or null. Bounded like the handover's read.
function readTranscript(file, adapter) {
  if (adapter !== 'claude-code' && adapter !== 'codex') return null;
  let r;
  try { r = Transcripts.readBounded(file, Transcripts.WIDE_TAIL_BYTES); } catch { return null; }
  const got = adapter === 'codex' ? codexEvents(r.lines) : claudeEvents(r.lines);
  return { ...got, partial: r.partial, adapter };
}

// Hook facts only (no transcript): the few facts that carry a time.
function factsEvents(f) {
  const out = [];
  if (!obj(f)) return out;
  if (isoOf(f.startedAt)) out.push({ at: isoOf(f.startedAt), kind: 'start' });
  if (str(f.firstPrompt) && f.firstPrompt !== f.lastPrompt) out.push({ at: isoOf(f.startedAt) || isoOf(f.lastPromptAt), kind: 'prompt', text: clip(f.firstPrompt, CAP.prompt) });
  if (str(f.lastPrompt)) out.push({ at: isoOf(f.lastPromptAt) || isoOf(f.lastActive), kind: 'prompt', text: clip(f.lastPrompt, CAP.prompt) });
  if (f.lastToolFailed && isoOf(f.lastToolFailed.at)) out.push({ at: isoOf(f.lastToolFailed.at), kind: 'failed', tool: f.lastToolFailed.tool || null });
  if (isoOf(f.lastStopAt)) out.push({ at: isoOf(f.lastStopAt), kind: 'turn-end', text: str(f.lastAssistant) ? clip(f.lastAssistant, CAP.reply) : null, failed: f.lastTurnFailed === f.lastStopAt || undefined });
  if (isoOf(f.endedAt)) out.push({ at: isoOf(f.endedAt), kind: 'end' });
  return out.filter((e) => e.at);
}

// app.log [state] transitions (mcp-server.js parseTransition shape) → approvals asked / answered, and the end.
function transitionEvents(transitions) {
  const out = [];
  const list = (Array.isArray(transitions) ? transitions : []).filter((t) => t && isoOf(t.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const t of list) {
    const at = isoOf(t.at);
    if (t.to === 'permission-ask' && t.from !== 'permission-ask') out.push({ at, kind: 'approval', answer: 'asked' });
    else if (t.from === 'permission-ask' && t.to !== 'permission-ask') out.push({ at, kind: 'approval', answer: ENDED.has(t.to) ? 'unanswered' : 'answered' });
    if (t.to === 'session-end') out.push({ at, kind: 'end' });
    if (t.to === 'limit-hit') out.push({ at, kind: 'limit' });
  }
  return out;
}

// src/checkpoints.js turns() → one event per finished turn with its files and +/- counts.
function checkpointEvents(turns) {
  return (Array.isArray(turns) ? turns : []).filter((t) => t && Number.isFinite(t.at) && Array.isArray(t.files)).map((t) => ({
    at: isoOf(t.at), kind: 'checkpoint', turn: t.turn, approx: !!t.approx,
    files: t.files.slice(0, 200).map((f) => ({ path: clip(String(f.path || ''), CAP.path), status: typeof f.status === 'string' ? f.status.slice(0, 1) : 'M', add: Number.isFinite(f.add) ? f.add : null, del: Number.isFinite(f.del) ? f.del : null })),
  })).filter((e) => e.at);
}

const relTo = (cwd) => (p) => {
  if (typeof p !== 'string') return p;
  const root = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd.replace(/\/+$/, '') : '';
  return root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
};

function statusOf({ state, facts, events }) {
  if (state && str(state.status)) return state.status;
  const f = obj(facts) || {};
  const answered = events.findLastIndex((e) => e.kind === 'approval' && e.answer !== 'asked');
  const last = events.findLast((e, i) => e.kind !== 'checkpoint' && !(e.kind === 'approval' && (e.answer !== 'asked' || i < answered)));
  if (f.endedAt || last?.kind === 'end') return 'Ended';
  if (last?.kind === 'limit') return 'Limit reached';
  if (last?.kind === 'approval') return 'Waiting for an approval';
  if (f.lastTurnFailed && f.lastTurnFailed === f.lastStopAt) return 'Last turn failed';
  if (last?.kind === 'turn-end') return 'Turn finished';
  if (last?.kind === 'interrupted') return 'Interrupted';
  if (f.awaitingReply || last?.kind === 'prompt') return 'Working, or interrupted';
  return last ? 'Working' : 'Unknown';
}

// Everything known about one session → the timeline. state: src/session-handover-main.js stateOf, or null.
function build({ adapter, sessionId, cwd = '', branch = null, state = null, facts = null, transcript = null, transitions = [], checkpoints = [] }) {
  const f = obj(facts) || {};
  const root = str(cwd) || str(f.cwd) || '';
  const rel = relTo(root);
  const own = transcript && Array.isArray(transcript.events) ? transcript.events : factsEvents(f);
  const tEvents = transitionEvents(transitions);
  const asked = tEvents.filter((e) => e.kind === 'approval');
  // A denial seen in the transcript marks the answer it followed instead of standing alone.
  const merged = own.filter((e) => {
    if (e.kind !== 'approval' || e.answer !== 'denied') return true;
    const t = Date.parse(e.at);
    const match = asked.find((a) => a.answer === 'answered' && t - Date.parse(a.at) >= 0 && t - Date.parse(a.at) <= 30000);
    if (!match) return true;
    match.answer = 'denied'; match.tool = e.tool;
    return false;
  });
  const all = [...merged, ...tEvents, ...checkpointEvents(checkpoints)].map((e, i) => ({ ...e, i })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.i - b.i);
  const usage = (transcript && transcript.usage || []).filter((u) => Number.isFinite(u.usd) && u.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const events = [];
  let ui = 0, spent = 0;
  for (const { i, ...e } of all) {
    if (e.path) e.path = rel(e.path);
    if (e.files) e.files = e.files.map((x) => ({ ...x, path: rel(x.path) }));
    while (ui < usage.length && Date.parse(usage[ui].at) <= Date.parse(e.at)) spent += usage[ui++].usd;
    if (e.kind === 'turn-end' && usage.length) e.spendUsd = Math.round(spent * 10000) / 10000;
    const prev = events[events.length - 1];
    if (e.kind === 'read' && prev && prev.kind === 'read') { if (!prev.paths.includes(e.path) && prev.paths.length < 50) prev.paths.push(e.path); continue; }
    events.push(e.kind === 'read' ? { at: e.at, kind: 'read', paths: [e.path] } : e);
  }
  const total = usage.reduce((n, u) => n + u.usd, 0);
  const files = new Map();
  const fileOf = (p) => { if (!files.has(p)) files.set(p, { path: p, edits: 0, add: null, del: null }); return files.get(p); };
  for (const e of events) {
    if (e.kind === 'edit') fileOf(e.path).edits += 1;
    if (e.kind === 'checkpoint') for (const x of e.files) { const r = fileOf(x.path); if (x.add != null) r.add = (r.add || 0) + x.add; if (x.del != null) r.del = (r.del || 0) + x.del; }
  }
  if (!transcript) for (const [p, k] of Object.entries(obj(f.files) || {})) if (k === 'edit') fileOf(rel(p));
  const commands = transcript ? events.filter((e) => e.kind === 'command').length : (Array.isArray(f.commands) ? f.commands.length : 0);
  const count = (kind, answer) => events.filter((e) => e.kind === kind && (!answer || e.answer === answer)).length;
  const started = [isoOf(f.startedAt), events[0]?.at].filter(Boolean).sort()[0] || null;
  return {
    v: 1, adapter: String(adapter || ''), sessionId: String(sessionId || ''), cwd: root, project: root ? path.basename(root) : '',
    branch: str(branch) || str(f.branch) || null,
    model: (transcript && MODEL.test(transcript.model ?? '') ? transcript.model : null) || (obj(state) && MODEL.test(state.model ?? '') ? state.model : null),
    source: transcript ? 'transcript' : Object.keys(f).length ? 'hooks' : 'state',
    partial: !!(transcript && transcript.partial),
    startedAt: started,
    lastActive: events.length ? events[events.length - 1].at : isoOf(f.lastActive),
    status: statusOf({ state, facts: f, events }),
    spend: usage.length ? { usd: Math.round(total * 10000) / 10000, partial: !!(transcript && transcript.partial) } : null,
    counts: { prompts: count('prompt'), files: [...files.values()].filter((x) => x.edits || x.add || x.del).length, commands, approvals: count('approval', 'asked'), answered: count('approval', 'answered'), denied: count('approval', 'denied'), failures: count('failed'), turns: count('turn-end') },
    files: [...files.values()].sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path)).slice(0, 300),
    commands: transcript ? [] : (Array.isArray(f.commands) ? f.commands.slice(-50).map((c) => clip(String(c), CAP.command)) : []),
    events,
  };
}

const APPROVAL = { asked: 'Approval asked', answered: 'Approval answered', denied: 'Approval denied', unanswered: 'Approval ended unanswered' };
const usd = (n) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
// One event → what a page shows: { label, text, mono, files, spend }. text null: nothing to show.
function describe(e) {
  const k = e.kind;
  if (k === 'delegation' || k === 'delegation-result') return {
    label: k === 'delegation' ? 'Subagent request recorded' : e.failed ? 'Subagent tool reported an error' : 'Subagent tool result recorded',
    text: e.text == null ? null : `${e.target || 'Subagent'}${e.tool ? ` · ${e.tool}` : ''}\n${e.text}`,
    hidden: e.text == null,
  };
  if (k === 'prompt') return { label: 'Asked', text: e.text ?? null, hidden: e.text == null };
  if (k === 'edit') return { label: 'Edited', text: e.path, mono: true };
  if (k === 'read') return { label: 'Read', text: (e.paths || []).join(', '), mono: true };
  if (k === 'command') return { label: 'Ran', text: e.text, mono: true };
  if (k === 'tool') return { label: 'Used', text: e.tool, mono: true };
  if (k === 'approval') return { label: APPROVAL[e.answer] || 'Approval', text: e.tool || null, mono: true };
  if (k === 'failed') return { label: 'Tool failed', text: e.tool || null, mono: true };
  if (k === 'interrupted') return { label: 'Interrupted', text: null };
  if (k === 'turn-end') return { label: e.failed ? 'Turn failed' : 'Turn finished', text: e.text ?? null, spend: Number.isFinite(e.spendUsd) ? `${usd(e.spendUsd)} so far` : null };
  if (k === 'checkpoint') return { label: `Checkpoint, turn ${e.turn}${e.approx ? ' (approximate)' : ''}`, text: null, files: e.files || [] };
  if (k === 'start') return { label: 'Started', text: null };
  if (k === 'end') return { label: 'Session ended', text: null };
  if (k === 'limit') return { label: 'Usage limit reached', text: null };
  return { label: k, text: null };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Every string in a value, through fn.
function mapStrings(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

// For this computer's own page: secrets redacted, the home folder shown as ~.
function forDisplay(timeline, { home = null } = {}) {
  const h = typeof home === 'string' ? home.replace(/[\\/]+$/, '') : '';
  const re = h.length > 1 ? new RegExp(`(?:file://)?${escapeRe(h)}(?![\\w.-])`, 'g') : null;
  return mapStrings(timeline, (s) => { const t = redactSecretsPass(s); return re ? t.replace(re, '~') : t; });
}

module.exports = { build, describe, usd, readTranscript, claudeEvents, codexEvents, factsEvents, transitionEvents, checkpointEvents, forDisplay, mapStrings, usageCost };
