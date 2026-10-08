const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const enabled = process.platform === 'win32';
const modulePath = pathToFileURL(path.resolve(__dirname, '../board/runner/windows-job.js')).href;
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) assert.fail('bounded native process observation timed out'); await new Promise(r => setTimeout(r, 20)); }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const env = () => Object.fromEntries(['SystemRoot', 'PATH', 'USERPROFILE', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
test('native Windows Job launch has real identity, framed output and stdin, no terminal, confirmed descendant stop', { skip: !enabled, timeout: 20000 }, async () => {
  const { WindowsJob, windowsIdentity } = await import(modulePath);
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true}); console.log(JSON.stringify({pid:process.pid,child:child.pid}));process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000);`;
  const job = new WindowsJob(process.execPath, ['-e', script], { cwd: process.cwd(), env: env() });
  let output = ''; job.stdout.on('data', b => { output += b; }); job.stderr.resume();
  try {
    await job.ready; assert.equal(job.lstart, windowsIdentity(job.pid));
    await until(() => output.includes('\n')); const ids = JSON.parse(output.split('\n')[0]); assert.equal(job.pid, ids.pid); assert.notEqual(job.pid, job.helper.pid);
    job.stdin.write('private stdin sentinel'); await until(() => output.includes('private stdin sentinel'));
    assert.equal(await job.stop(), true); assert.equal(job.stopped, true); await until(() => !alive(ids.pid) && !alive(ids.child));
  } finally { await job.stop(); }
});
test('native Job kills remaining descendants on natural provider exit', { skip: !enabled, timeout: 15000 }, async () => {
  const { WindowsJob } = await import(modulePath); let output = '';
  const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});console.log(c.pid);c.unref();`;
  const job = new WindowsJob(process.execPath, ['-e', script], { cwd: process.cwd(), env: env() }); job.stdout.on('data', b => { output += b; }); job.stderr.resume();
  await job.ready; assert.equal(await job.completion, true); const childPid = Number(output.trim()); assert.ok(childPid > 1); await until(() => !alive(childPid));
});
test('native Job kills provider when owning parent dies without sending stop', { skip: !enabled, timeout: 20000 }, async () => {
  const script = `const {WindowsJob}=await import(${JSON.stringify(modulePath)});const job=new WindowsJob(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),env:JSON.parse(process.argv[1])});job.stdout.resume();job.stderr.resume();await job.ready;console.log(job.pid);setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(env())], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = ''; parent.stdout.on('data', b => { output += b; });
  try { await until(() => output.includes('\n')); const pid = Number(output.trim()); assert.ok(pid > 1); assert.ok(alive(pid)); const exited = once(parent, 'close'); parent.kill(); await exited; await until(() => !alive(pid)); }
  finally { parent.kill(); }
});
test('native helper crash cannot forge stop confirmation and kills its retained Job', { skip: !enabled, timeout: 15000 }, async () => {
  const { WindowsJob } = await import(modulePath);
  const job = new WindowsJob(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), env: env() }); job.stdout.resume(); job.stderr.resume();
  await job.ready; const pid = job.pid; job.helper.kill(); assert.equal(await job.completion, false); await until(() => !alive(pid));
});
test('native launch refuses an executable writable by another principal before any child runs', { skip: !enabled, timeout: 15000 }, async () => {
  const fs = require('node:fs'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
  const { WindowsJob, jobHelperPath } = await import(modulePath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-untrusted-exe-')), bin = path.join(dir, 'node.exe'), marker = path.join(dir, 'must-not-exist');
  try {
    fs.copyFileSync(process.execPath, bin);
    execFileSync(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'), [bin, '/grant', '*S-1-1-0:(M)'], { stdio: 'ignore', windowsHide: true });
    assert.throws(() => execFileSync(jobHelperPath(), ['trusted', bin], { stdio: 'ignore', windowsHide: true }));
    const job = new WindowsJob(bin, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`], { cwd: dir, env: env() }); job.stdout.resume(); job.stderr.resume();
    await assert.rejects(job.ready, /ownership helper unavailable/); assert.equal(await job.completion, false); assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
