// Temp dirs created through here are removed when the test process ends,
// however it ends short of SIGKILL; dirs a SIGKILLed run left behind carry
// the dead pid in their name and are swept by the next run using the prefix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const owned = new Set();
const swept = new Set();
let hooked = false;

function remove(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ }
  owned.delete(dir);
}

function removeAll() { for (const dir of [...owned]) remove(dir); }

function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', removeAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { removeAll(); process.kill(process.pid, sig); });
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function sweep(base, prefix) {
  const key = `${base}\0${prefix}`;
  if (swept.has(key)) return;
  swept.add(key);
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}(\\d+)-[A-Za-z0-9]{6}$`);
  let names = [];
  try { names = fs.readdirSync(base); } catch { return; }
  for (const name of names) {
    const m = re.exec(name);
    if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) {
      try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); } catch { /* another sweeper won */ }
    }
  }
}

export function testTempDir(prefix, t) {
  const base = os.tmpdir();
  sweep(base, prefix);
  hook();
  const dir = fs.mkdtempSync(path.join(base, `${prefix}${process.pid}-`));
  owned.add(dir);
  if (t && typeof t.after === 'function') t.after(() => remove(dir));
  return dir;
}
