// Scripts take their data as `on run argv` arguments, so an id is never part
// of the script's source and can't change what the script does.
async function runScript(exec, script, args) {
  const r = await exec('/usr/bin/osascript', ['-e', script, ...args]);
  const out = (r.stdout || '').trim();
  // -1743: the user hasn't allowed (or has refused) Automation of that app.
  if (!r.ok && /-1743/.test(r.stderr || '')) return { ok: false, denied: 'automation', reason: 'automation not allowed' };
  if (!r.ok) return { ok: false, reason: (r.stderr || 'osascript failed').trim().slice(0, 120) };
  if (out === 'ok') return { ok: true, exact: true };
  return { ok: false, reason: out || 'no match' };
}

module.exports = { runScript };
