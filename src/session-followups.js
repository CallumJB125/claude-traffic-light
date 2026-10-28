'use strict';
// Owner-local next-turn outbox. Storage must be the main-owned OS vault, never
// a hub or renderer. A saved message is not a provider receipt. In particular,
// an interrupted dispatch is never retried: a crash can happen after the
// provider acted but before its acknowledgement reached this process.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validFollowupSchedule, describeFollowup } = require('./recipe-schedules');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = new Set(['queued', 'blocked', 'sending', 'acknowledged', 'unconfirmed', 'refused', 'cancelled', 'expired']);
const MAX_ITEMS = 16, MAX_PER_TARGET = 3, MAX_FILE = 512 * 1024, MAX_AGE_MS = 7 * 86400 * 1000;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && !v.includes('\0') && !!v.trim() && v.trim().length <= 4000 && Buffer.byteLength(v.trim()) <= 8192;
const fail = (status, error) => ({ ok: false, status, error });
const unavailable = () => fail('locked', 'Encrypted follow-up storage or durable filesystem sync is unavailable. A save or receipt may be unconfirmed; inspect saved follow-ups before retrying. A failed pre-dispatch save never starts a provider turn.');
const validTarget = t => object(t) && ['owned', 'team'].includes(t.kind) && typeof t.key === 'string' && /^[0-9a-f]{64}$/.test(t.key)
  && object(t.route) && Buffer.byteLength(JSON.stringify(t.route)) <= 2048 && Number.isSafeInteger(t.generation) && t.generation >= 0
  && typeof t.provider === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(t.provider);
const validItem = e => object(e) && UUID.test(e.id) && /^[0-9a-f]{64}$/.test(e.scope) && validTarget(e.target)
  && typeof e.label === 'string' && e.label.length <= 240 && (text(e.text) || e.text === '' && ['cancelled','expired','refused'].includes(e.status))
  && STATES.has(e.status) && Number.isSafeInteger(e.createdAt) && e.createdAt >= 0 && Number.isSafeInteger(e.updatedAt) && e.updatedAt >= e.createdAt
  && validFollowupSchedule(e.schedule, e.createdAt)
  && typeof e.reason === 'string' && e.reason.length <= 600
  && (e.receipt == null || object(e.receipt) && typeof e.receipt.id === 'string' && e.receipt.id.length <= 100 && ['acknowledged','recorded','responding','completed'].includes(e.receipt.state));
const copy = v => JSON.parse(JSON.stringify(v));

function createSessionFollowups({ file, storage, scope, now = Date.now, onChange = () => {}, io = fs }) {
  if (!path.isAbsolute(file)) throw new Error('Follow-ups require a private absolute storage path.');
  let entries = [], loaded = false, closed = false, epoch = 0, chain = Promise.resolve();
  const current = s => !closed && typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) && scope() === s;
  const serial = fn => { const operation = chain.then(fn, fn); chain = operation.catch(() => {}); return operation; };
  const changed = () => { try { onChange(); } catch { /* no message content in notifications */ } };
  const dto = e => ({ id: e.id, label: e.label, text: e.text, status: e.status, reason: e.reason, createdAt: e.createdAt, updatedAt: e.updatedAt, expiresAt:e.createdAt+MAX_AGE_MS, target: e.target.key, receipt:e.receipt??null, schedule: { kind: e.schedule?.kind ?? 'ready', atMs: e.schedule?.atMs ?? null, label: describeFollowup(e.schedule) } });
  async function load() {
    if (loaded) return;
    const ticket = epoch;
    let restored = [];
    let st;
    try { st = io.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (st) {
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE || st.size === 0) throw new Error('Unavailable');
      const fd = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let bytes;
      try { const opened = io.fstatSync(fd); if (opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size) throw new Error('Unavailable'); bytes = io.readFileSync(fd); }
      finally { io.closeSync(fd); }
      const decoded = await storage.decryptAsync(bytes);
      if (typeof decoded !== 'string' || Buffer.byteLength(decoded) > MAX_FILE) throw new Error('Unavailable');
      const data = JSON.parse(decoded);
      if (!object(data) || ![1,2].includes(data.schema) || !Array.isArray(data.entries) || data.entries.length > MAX_ITEMS || !data.entries.every(validItem)
        || data.schema === 1 && data.entries.some(e => e.schedule !== undefined)
        || new Set(data.entries.map(e => e.id)).size !== data.entries.length) throw new Error('Unavailable');
      restored = data.entries.map(e => e.status === 'sending' ? { ...e, status: 'unconfirmed', reason: 'Plexiform restarted during dispatch. The provider may have acted; this message will not be resent.' } : e);
    }
    if (closed || ticket !== epoch) throw new Error('Closed');
    entries = restored; loaded = true;
  }
  async function save(next, keep) {
    const ticket = epoch;
    if (closed || !keep()) throw new Error('Unavailable');
    io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Directory sync is a prerequisite, not a best-effort optimization. If a
    // platform/filesystem cannot attest durable rename, do not publish an
    // executable outbox. A lost sending marker could otherwise replay a turn.
    const dir=path.dirname(file), flags=fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY||0)|(fs.constants.O_NOFOLLOW||0);
    if(io.lstatSync(dir).isSymbolicLink())throw new Error('Unavailable');
    let dirFd,parentFd;
    try{dirFd=io.openSync(dir,flags);parentFd=io.openSync(path.dirname(dir),flags);io.fsyncSync(dirFd);io.fsyncSync(parentFd);}
    catch(error){if(dirFd!==undefined)io.closeSync(dirFd);if(parentFd!==undefined)io.closeSync(parentFd);throw error;}
    io.closeSync(parentFd);
    // Old next-turn-only versions reject schema 2. Keeping schema 1 here
    // would let a downgraded app ignore schedules and dispatch them early.
    const clear = JSON.stringify({ schema: 2, entries: next });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      const bytes = await storage.encryptAsync(clear);
      if (closed || ticket !== epoch || !keep() || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_FILE || bytes.equals(Buffer.from(clear))) throw new Error('Unavailable');
      fd = io.openSync(tmp, 'wx', 0o600); io.writeFileSync(fd, bytes); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      if (closed || ticket !== epoch || !keep()) throw new Error('Unavailable');
      io.renameSync(tmp, file);
      io.fsyncSync(dirFd);
      // Publish only after the atomic ciphertext replacement succeeds.
      entries = next; changed();
    } finally { if (fd !== undefined) io.closeSync(fd); io.closeSync(dirFd); try { io.rmSync(tmp, { force: true }); } catch { /* preserve primary error */ } }
  }
  const snapshot = (s, match = null) => entries.filter(e => e.scope === s && (match === null || match(e.target))).map(dto);
  async function update(e, fields, s, keep = () => current(s)) {
    const next = entries.map(v => v.id === e.id ? { ...v, ...fields, updatedAt: Math.max(v.updatedAt, now()) } : v);
    await save(next, keep);
  }
  async function expire(s){
    const next=entries.map(e=>['queued','blocked','refused'].includes(e.status)&&now()>=e.createdAt+MAX_AGE_MS?{...e,status:'expired',text:'',reason:'Expired after seven days without dispatch. Saved message text was removed.',updatedAt:Math.max(e.updatedAt,now())}:e);
    if(next.some((e,i)=>e!==entries[i]))await save(next,()=>current(s));
  }
  // The only functions besides expire() that touch items outside the current scope (a test pins this).
  // They edit only status/reason/text/updatedAt of queued/blocked team items, and clear the text.
  function refuseTeam(match, reason, keep) {
    return serial(async () => {
      try {
        await load();
        let hit = false;
        const next = entries.map(e => {
          if (e.target.kind !== 'team' || !['queued', 'blocked'].includes(e.status) || !match(e)) return e;
          hit = true;
          return { ...e, status: 'refused', reason, text: '', updatedAt: Math.max(e.updatedAt, now()) };
        });
        if (hit && keep()) await save(next, () => !closed && keep());
      } catch { /* retried on the next pass; ciphertext is unchanged */ }
    });
  }
  return {
    // Another account on the same hub: terminal, text removed. The caller proves the viewer is stable.
    sweepForeign: ({ origin, viewer, current: keep = () => true } = {}) => typeof origin === 'string' && typeof viewer === 'string' && viewer
      ? refuseTeam(e => e.target.route?.origin === origin && e.target.route.viewer !== viewer, "Signed in as someone else; this follow-up won't be sent.", keep) : Promise.resolve(),
    // The hub account explicitly signed out or its token was revoked (never inferred from a missing viewer).
    signedOut: ({ origin, userId } = {}) => typeof origin === 'string' && typeof userId === 'string' && userId
      ? refuseTeam(e => e.target.route?.origin === origin && e.target.route.viewer === userId, "Signed out; this follow-up won't be sent.", () => true) : Promise.resolve(),
    list: (keep=()=>true, match=null) => {const s=scope();
      // The durable sending marker is already cached. A passive read must not
      // wait behind its provider acknowledgement, or Sending would never be
      // visible and the UI could still offer cancellation of a dispatched turn.
      if(loaded&&current(s)&&keep()===true&&entries.some(e=>e.scope===s&&e.status==='sending'))return Promise.resolve({ok:true,status:'ready',items:snapshot(s,match)});
      return serial(async () => { try { if (!current(s)||keep()!==true) return fail('stale', 'Select your account and workspace.'); await load();if(!current(s)||keep()!==true)return fail('stale','The account or view changed.');await expire(s); return current(s)&&keep()===true ? { ok: true, status: 'ready', items: snapshot(s, match) } : fail('stale', 'The account changed.'); } catch { return unavailable(); } });},
    enqueue: request => {const s=scope();return serial(async () => {
      if (!object(request) || !UUID.test(request.id) || !validTarget(request.target) || !text(request.text) || typeof request.label !== 'string' || request.label.length > 240) return fail('invalid', 'Check the target and message.');
      try {
        if (!current(s) || request.current?.() !== true) return fail('stale', 'This account or session changed. Review it again.');
        await load();
        if (!current(s) || request.current() !== true) return fail('stale', 'This account or session changed. Review it again.');
        const prior = entries.find(e => e.id === request.id);
        if (prior) return prior.scope === s && JSON.stringify(prior.target) === JSON.stringify(request.target) && prior.text === request.text.trim() && JSON.stringify(prior.schedule ?? {kind:'ready'}) === JSON.stringify(request.schedule ?? {kind:'ready'})
          ? { ok: true, status: prior.status, item: dto(prior) } : fail('invalid', 'This request ID was already used.');
        if (entries.length >= MAX_ITEMS) return fail('full', 'Discard an old follow-up before adding another (16 per device).');
        if (entries.filter(e => e.target.key === request.target.key && ['queued', 'blocked'].includes(e.status)).length >= MAX_PER_TARGET) return fail('full', 'Three follow-ups are already waiting for this session. Cancel one first.');
        const at = now();
        if (!validFollowupSchedule(request.schedule, at)) return fail('invalid', 'Choose a future time within seven days and review it again.');
        const schedule = copy(request.schedule ?? {kind:'ready'});
        const item = { id: request.id, scope: s, target: copy(request.target), label: request.label, text: request.text.trim(), status: 'queued', reason: 'Sent once, when the session is idle, while Plexiform is running and you are signed in as you. Dropped after seven days.', createdAt: at, updatedAt: at,receipt:null,schedule };
        await save([...entries, item], () => current(s) && request.current() === true);
        return { ok: true, status: 'queued', item: dto(item) };
      } catch { return unavailable(); }
    });},
    cancel: (id, keep=()=>true) => {const s=scope();return serial(async () => {
      if (!UUID.test(id)) return fail('invalid', 'Choose a follow-up.');
      try { if(!current(s)||keep()!==true)return fail('stale','The account or view changed.');await load(); if (!current(s)||keep()!==true) return fail('stale', 'The account or view changed.'); const item = entries.find(e => e.id === id && e.scope === s);
        if (!item) return fail('stale', 'That follow-up is unavailable.');
        if (['sending', 'acknowledged', 'unconfirmed'].includes(item.status)) return fail('unconfirmed', 'This message may have reached the provider. Discard removes the saved copy; it cannot undo a turn.');
        await update(item, { status: 'cancelled', text: '', reason: 'Cancelled before dispatch.' }, s,()=>current(s)&&keep()===true); return { ok: true, status: 'cancelled' };
      } catch { return unavailable(); }
    });},
    discard: (id,keep=()=>true) => {const s=scope();return serial(async () => {
      if (!UUID.test(id)) return fail('invalid', 'Choose a follow-up.');
      try { if(!current(s)||keep()!==true)return fail('stale','The account or view changed.');await load(); if (!current(s)||keep()!==true) return fail('stale', 'The account or view changed.'); const item = entries.find(e => e.id === id && e.scope === s); if (!item) return fail('stale', 'That follow-up is unavailable.');
        if (item.status === 'sending') return fail('busy', 'Wait for the dispatch receipt before discarding.');
        await save(entries.filter(e => e.id !== id), () => current(s)&&keep()===true); return { ok: true, status: 'discarded' };
      } catch { return unavailable(); }
    });},
    // Main invokes this only under its existing foreground/document authority.
    // resolve must freshly authorize the pinned route and return send(fresh).
    // A status-only report is never sufficient to authorize a provider turn.
    advance: resolve => {const s=scope();return serial(async () => {
      try {
        if (!current(s)) return;
        await load();
        await expire(s);
        const attempted = new Set();
        for (const item of [...entries]) {
          if (!current(s)) return;
          if (item.scope !== s || !['queued', 'blocked'].includes(item.status) || attempted.has(item.target.key)) continue;
          attempted.add(item.target.key);
          // Preserve exact-session order. Sleeping/closed/unfocused time does
          // not accumulate runs; the same saved one-shot becomes eligible.
          if (item.schedule?.atMs > now()) continue;
          let target;
          try { target = await resolve(copy(item.target)); } catch { target = null; }
          let release = null;
          try {
          if (!current(s)) return;
          if (!target?.ok || target.current?.() !== true || typeof target.send !== 'function') {
            const reason = typeof target?.error === 'string' ? target.error.slice(0, 600) : 'The original session is unavailable. It will not be recreated or reattached.';
            const status = target?.terminal === true ? 'refused' : 'blocked';
            // A team item refused for identity or permission keeps no text on disk.
            const clear = status === 'refused' && item.target.kind === 'team';
            if (item.status !== status || item.reason !== reason || clear && item.text !== '') await update(item, clear ? { status, reason, text: '' } : { status, reason }, s);
            continue;
          }
          const evidenceCurrent = () => {
            if (item.schedule?.kind !== 'provider-reset') return true;
            const reset = target.reset?.();
            return reset?.id === item.schedule.evidence && reset?.atMs === item.schedule.atMs;
          };
          if (!evidenceCurrent()) {
            await update(item, { status: 'refused', reason: 'The original provider reset report changed or is unavailable. Review a new follow-up; this one will not retry.' }, s);
            continue;
          }
          if (!target.ready) { if (item.status !== 'queued') await update(item, { status: 'queued', reason: 'Waiting for the original session to finish its current turn.' }, s); continue; }
          // Another action on this session holds its lock: stay queued, never refused.
          if (typeof target.acquire === 'function') { release = target.acquire(); if (typeof release !== 'function') continue; }
          const authorityCurrent = () => current(s) && now() < item.createdAt + MAX_AGE_MS && (!item.schedule?.atMs || now() >= item.schedule.atMs) && target.current() === true;
          const fresh = () => authorityCurrent() && evidenceCurrent();
          await update(item, { status: 'sending', reason: 'Dispatching; provider acknowledgement has not arrived.' }, s, fresh);
          // If authority changed after the durable sending marker, keep an
          // uncertain receipt, never convert it back to a retryable message.
          let result;
          try { result = fresh() ? await target.send(item.text, item.id, fresh) : null; } catch { result = null; }
          // Starting our requested turn may itself consume/replace reset
          // evidence. That does not erase its actual provider receipt.
          const acknowledged = authorityCurrent() && result?.ok === true && ['acknowledged', 'recorded', 'responding', 'completed'].includes(result.delivery?.state);
          const explicitlyRefused = authorityCurrent() && result?.ok === false && ['busy', 'stale', 'forbidden', 'unavailable', 'invalid'].includes(result.status);
          const receipt=acknowledged&&typeof result.delivery.id==='string'&&result.delivery.id.length<=100?{id:result.delivery.id,state:result.delivery.state}:null;
          const fields = acknowledged ? { status: 'acknowledged', receipt, reason: `Provider receipt: ${result.delivery.state}. View the session for its response.` }
            : explicitlyRefused ? { status: 'refused', reason: `Provider refused this attempt (${result.status}). Nothing will be retried automatically.` }
              : { status: 'unconfirmed', reason: 'Receipt unconfirmed. The provider may have acted; this message will not be resent automatically.' };
          // Save the receipt in its original account even if the UI switched.
          // No subsequent entry is dispatched under the new account.
          await update(item, fields, s, () => !closed);
          } finally { try { release?.(); } catch { /* lock already gone */ } }
        }
      } catch { /* Preserve ciphertext and pending intent; list reports vault errors. */ }
    });},
    close() { closed = true; epoch++; entries = []; },
  };
}

module.exports = { createSessionFollowups, MAX_PER_TARGET, MAX_ITEMS, MAX_AGE_MS, validTarget };
