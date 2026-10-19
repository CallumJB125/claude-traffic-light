'use strict';
// Declared metadata only. Never a provider lifecycle event or execution grant.
const fs = require('node:fs');
const path = require('node:path');
const State = require('../hooks/session-state');
const RECENT_MS = 90_000, LIMIT = 64, MAX_FILE = 262144;
const ID = /^[A-Za-z0-9_.-]{1,120}$/, TURN = /^[A-Za-z0-9_.:-]{1,120}$/;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const identifier = x => typeof x === 'string' && ID.test(x);
const turn = x => typeof x === 'string' && TURN.test(x);
const text = (x, n) => typeof x === 'string' && x.trim() === x && x.length > 0 && x.length <= n && !/[\u0000-\u001f\u007f-\u009f]/.test(x);
const cwdValid = x => text(x, 500) && path.isAbsolute(x) && path.normalize(x) === x;
const keys = ['schema','parentSessionId','expectedTurnId','cwd','agentId','publicName','taskTitle','status'];
const statuses = new Set(['working','waiting','done']);
const closed = (x, names) => object(x) && Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x,k));
function requestValid(x) {
  return closed(x,keys) && x.schema === 1 && identifier(x.parentSessionId) && turn(x.expectedTurnId) && cwdValid(x.cwd) && identifier(x.agentId) && text(x.publicName,80) && text(x.taskTitle,200) && typeof x.status === 'string' && statuses.has(x.status);
}
function current(parent, now, fresh = true) {
  if (!object(parent) || parent.source !== 'codex' || parent.codexLifecycle !== 1 || parent.codexClosedTurn !== false || !identifier(parent.sessionId) || !turn(parent.codexTurnId) || !cwdValid(parent.cwd) || parent.remote || parent.device || !Number.isSafeInteger(now) || now < 0) return false;
  const at = typeof parent.codexHookAt === 'string' ? Date.parse(parent.codexHookAt) : NaN;
  return !fresh || Number.isFinite(at) && at >= 0 && at <= now && now-at <= RECENT_MS;
}
function readRegular(file, max = MAX_FILE) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > max) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > max) return null;
    const buffer = Buffer.alloc(max + 1); let bytes = 0;
    while (bytes <= max) { const count = fs.readSync(fd,buffer,bytes,buffer.length-bytes,null); if (!count) break; bytes += count; }
    const after = fs.lstatSync(file);
    if (bytes > max || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) return null;
    return buffer.subarray(0,bytes).toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
function readParent(file) { try { return JSON.parse(readRegular(file)); } catch { return null; } }
function storedValid(x) {
  return closed(x,['id','name','taskTitle','status','parentTurnId','observedAt','source']) && identifier(x.id) && text(x.name,80) && text(x.taskTitle,200) && typeof x.status === 'string' && statuses.has(x.status) && turn(x.parentTurnId) && Number.isSafeInteger(x.observedAt) && x.observedAt >= 0 && x.source === 'self-reported';
}
function project(parent, now) {
  if (!current(parent,now,false) || !Array.isArray(parent.codexSelfReports)) return [];
  const result = [], seen = new Set();
  for (const x of parent.codexSelfReports.slice(0,LIMIT)) {
    if (!storedValid(x) || x.parentTurnId !== parent.codexTurnId || x.observedAt > now || seen.has(x.id)) continue;
    seen.add(x.id); const ageMs = now-x.observedAt;
    result.push({id:x.id,name:x.name,taskTitle:x.taskTitle,status:x.status,observedAt:x.observedAt,source:x.source,ageMs,freshness:ageMs<=RECENT_MS?'recent':'stale'});
  }
  return result;
}
function apply({sessionsDir,host,request,now = Date.now}) {
  if (!requestValid(request) || typeof host !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(host)) return {ok:false,status:'invalid'};
  const file = State.sessionFileFor(sessionsDir,host,'codex',request.parentSessionId);
  const outcome = State.withLockOrSkip(file, () => {
    const time = now(), parent = readParent(file);
    if (!current(parent,time) || parent.host !== host || parent.sessionId !== request.parentSessionId || parent.codexTurnId !== request.expectedTurnId || parent.cwd !== request.cwd) return {ok:false,status:'stale'};
    // Old provider roster and every parent activity/input clock are preserved.
    const reports = project(parent,time).map(x => ({id:x.id,name:x.name,taskTitle:x.taskTitle,status:x.status,parentTurnId:parent.codexTurnId,observedAt:x.observedAt,source:x.source}));
    const index = reports.findIndex(x => x.id === request.agentId);
    if (index < 0 && reports.length >= LIMIT) return {ok:false,status:'full'};
    const report = {id:request.agentId,name:request.publicName,taskTitle:request.taskTitle,status:request.status,parentTurnId:parent.codexTurnId,observedAt:time,source:'self-reported'};
    if (index < 0) reports.push(report); else reports[index] = report;
    State.writeJsonAtomic(file,{...parent,codexSelfReports:reports});
    return {ok:true,status:'recorded'};
  });
  return outcome ?? {ok:false,status:'busy'};
}
function select({sessionsDir,host,cwd,now = Date.now(),deadline = Date.now()+1500}) {
  if (!cwdValid(cwd) || typeof host !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(host)) return null;
  const files = []; let directory;
  try {
    const entry = fs.lstatSync(sessionsDir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    directory = fs.opendirSync(sessionsDir); let item;
    while ((item = directory.readSync())) {
      if (files.length >= 2048 || Date.now() >= deadline) return null;
      files.push(item.name);
    }
  } catch { return null; } finally { if (directory) try { directory.closeSync(); } catch {} }
  let found = null;
  for (const name of files) {
    if (Date.now() >= deadline) return null;
    if (!name.startsWith(`${host}-codex-`) || !name.endsWith('.json')) continue;
    const parent = readParent(path.join(sessionsDir,name));
    if (!current(parent,now) || parent.host !== host || parent.cwd !== cwd || path.basename(State.sessionFileFor(sessionsDir,host,'codex',parent.sessionId)) !== name) continue;
    if (found) return null;
    found = {parentSessionId:parent.sessionId,expectedTurnId:parent.codexTurnId};
  }
  return found;
}
module.exports = {RECENT_MS,LIMIT,requestValid,current,readRegular,project,apply,select};
