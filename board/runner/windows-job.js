// Private inherited stdio carries control; provider output is framed separately.
// No PID-only termination and no shell. The helper retains the process and Job.
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import WindowsPrivate from '../shared/windows-private-directory.cjs';

export const jobHelperPath = (moduleDir) => path.join(path.dirname(WindowsPrivate.helperPath(moduleDir)), 'windows-process-job.exe');
export function windowsQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid Windows argument');
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}
export function launchPayload(bin, args, { cwd, env, parentPid = process.pid }) {
  if (!path.win32.isAbsolute(bin) || !/\.exe$/i.test(bin) || !path.win32.isAbsolute(cwd)) throw new Error('Windows launch requires absolute executable and workspace paths');
  const entries = Object.entries(env).sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase()));
  const seen = new Set();
  for (const [k, v] of entries) {
    if (!k || /[=\0]/.test(k) || typeof v !== 'string' || v.includes('\0') || seen.has(k.toUpperCase())) throw new Error('Invalid Windows environment');
    seen.add(k.toUpperCase());
  }
  const values = [bin, cwd, [bin, ...args].map(windowsQuote).join(' '), entries.map(([k, v]) => `${k}=${v}`).join('\0') + '\0'];
  if (values.slice(0, 3).some((s) => s.includes('\0') || s.length > 32766)) throw new Error('Windows launch too large');
  const parts = values.map((s) => Buffer.from(s + '\0', 'utf16le'));
  if (parts[3].length > 262144) throw new Error('Windows environment too large');
  const header = Buffer.alloc(20); header.writeUInt32LE(parentPid);
  parts.forEach((b, i) => header.writeUInt32LE(b.length, 4 + i * 4));
  return Buffer.concat([header, ...parts]);
}
export function jobFrame(type, data = Buffer.alloc(0)) {
  const h = Buffer.alloc(5); h[0] = type; h.writeUInt32LE(data.length, 1); return Buffer.concat([h, data]);
}
export function windowsIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const value = execFileSync(jobHelperPath(), ['identity', String(pid)], { timeout: 1000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); // privacy-flow: runner-local
    return /^win32:[0-9a-f]{16}$/.test(value) ? value : null;
  } catch { return null; }
}
export class WindowsJob extends EventEmitter {
  constructor(bin, args, opts, { spawnHelper = spawn, helper = jobHelperPath(), timeoutMs = 5000 } = {}) {
    super();
    const payload = launchPayload(bin, args, opts);
    this.pid = null; this.lstart = null; this.stopped = false; this.closed = false;
    this.stdout = new PassThrough(); this.stderr = new PassThrough();
    let readyResolve, readyReject, buffer = Buffer.alloc(0), receipt = null, invalid = false;
    this.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    this.completion = new Promise((resolve) => { this.complete = resolve; });
    const child = this.helper = spawnHelper(helper, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); // privacy-flow: runner-windows-job
    const fail = () => { invalid = true; readyReject(new Error('Windows process ownership helper unavailable')); child.kill(); };
    const timer = setTimeout(fail, timeoutMs);
    this.stdin = new Writable({
      write(chunk, encoding, callback) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        if (b.length > 1024 * 1024) return callback(new Error('Windows input frame too large'));
        child.stdin.write(jobFrame(2, b), callback);
      },
      final(callback) { child.stdin.write(jobFrame(3), callback); },
    });
    this.stdin.on('error', () => {});
    child.stdin.on('error', fail); child.on('error', (error) => {
      // Node's failed spawn with no PID is positive evidence that no helper
      // existed. Errors after a helper started never get this exception.
      if (!child.pid && !this.pid && ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error?.code)) this.neverStarted = true;
      fail();
    });
    child.stderr.on('data', () => {}); // helper diagnostics never contain provider text
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const type = buffer[0], n = buffer.readUInt32LE(1);
        if (n > 1024 * 1024) return fail();
        if (buffer.length < n + 5) return;
        const data = buffer.subarray(5, n + 5); buffer = buffer.subarray(n + 5);
        if (receipt) return fail();
        if (type === 129 && n === 12 && this.pid === null) {
          const pid = data.readUInt32LE(0);
          if (pid <= 1) return fail();
          this.pid = pid; this.lstart = `win32:${data.readBigUInt64LE(4).toString(16).padStart(16, '0')}`;
          clearTimeout(timer); readyResolve(this);
        } else if ((type === 130 || type === 131) && this.pid !== null) {
          const stream = type === 130 ? this.stdout : this.stderr;
          // Bound pending provider bytes even when the consumer never attaches
          // or stops reading. Cleanup cannot depend on a blocked drain.
          if (stream.readableLength + stream.writableLength + n > 2 * 1024 * 1024) return fail();
          stream.write(data);
        } else if (type === 132 && n === 5 && this.pid !== null && data[4] <= 1) {
          receipt = { code: data.readUInt32LE(0), stopped: data[4] === 1 };
        } else return fail();
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer); this.closed = true;
      this.stopped = this.neverStarted === true || (!invalid && code === 0 && buffer.length === 0 && receipt?.stopped === true);
      readyReject(new Error('Windows process ownership helper unavailable'));
      this.stdout.end(); this.stderr.end(); this.complete(this.stopped);
      this.emit('exit', receipt?.code ?? null, null);
    });
    child.stdin.write(jobFrame(1, payload));
  }
  async stop(timeoutMs = 5000) {
    if (this.closed) return this.stopped;
    this.helper.stdin.write(jobFrame(4), () => {});
    let timer;
    const result = await Promise.race([this.completion, new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    clearTimeout(timer);
    if (!this.closed) this.helper.kill(); // Closing the last Job handle kills descendants; without a receipt we still report false.
    return result;
  }
}
