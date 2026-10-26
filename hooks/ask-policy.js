// How long a blocking permission hook waits for the widget, what Plexiform tells the person about it, and how the hook
// cleans up after itself. Measured on Claude Code 2.1.310 (docs/waiting-inputs.md, work/dogfood-lab/cv-report.md): the
// terminal dialog is NOT held while a PermissionRequest hook runs (it is drawn within 0.3 s and answerable at once), and a
// late allow after a terminal answer is ignored, so the hook waits its full 55 s and nothing else needs to gate it.
'use strict';

const ASK_CEILING_MS = 55000;

// → the one line shown once on the first real request (C-N).
const NOTICE_TEXT = 'You can answer Claude’s permission prompts here or in the terminal.';
const noticeText = () => NOTICE_TEXT;

// G2: said at setup's Connect, where the blocking permission hook is consented to (onboarding.html carries the same words).
const CONSENT_TEXT = 'We also add a hook that lets Plexiform show Claude’s permission prompts and wait briefly for your answer. If you don’t answer, the terminal asks as usual. Settings › Widget turns it off.';

// A repo's .claude/settings.json can set environment variables for every hook, so the environment can only shorten a
// wait (0 = don't wait at all: the in-process caller and tests use it), never lengthen it.
function clampAskMs(raw, ceilingMs = ASK_CEILING_MS) {
  const n = Number(raw);
  return raw === undefined || raw === '' || !Number.isFinite(n) ? ceilingMs : Math.min(ceilingMs, Math.max(0, n));
}
function clampHookTimeoutMs(raw, installedMs) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(installedMs, n) : installedMs;
}

// A hook that Claude Code kills (a terminal No ends it with SIGTERM ~76 ms later; the 60 s timeout does too) can't run
// its own cleanup while it is blocked in a synchronous wait, so a tiny detached watcher removes the request once the
// hook's process is gone. It touches only the file whose JSON id is this hook's own, and it ends as soon as the file is
// gone after it was seen (the normal exit path removed it) or the cleanup is done. It is started before the request
// file is created, so a kill in between still leaves it to clean up. argv: request file, answer file, id, hook pid.
const REAPER_SOURCE = "const fs=require('fs');const [req,ans,id,pid]=process.argv.slice(1);"
  + "const alive=()=>{try{process.kill(Number(pid),0);return true}catch(e){return e.code==='EPERM'}};"
  + "const t0=Date.now();let seen=false;"
  + "const tick=()=>{if(fs.existsSync(req))seen=true;else if(seen||Date.now()-t0>3000)process.exit(0);if(alive())return;"
  + "try{if(JSON.parse(fs.readFileSync(req,'utf8')).id===id){fs.unlinkSync(req);try{fs.unlinkSync(ans)}catch(e){}}}catch(e){}process.exit(0)};"
  + "setInterval(tick,150);tick();setTimeout(()=>process.exit(0),120000);";

module.exports = { ASK_CEILING_MS, clampAskMs, clampHookTimeoutMs, noticeText, NOTICE_TEXT, CONSENT_TEXT, REAPER_SOURCE };
