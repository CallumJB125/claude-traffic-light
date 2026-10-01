import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OffsiteError, fail, recipient } from './schema.mjs';
import { open, consume } from './files.mjs';

export class AgeCipher {
  constructor({ executable, publicRecipient = null, identity = null, timeoutMs = 120_000 }) {
    if (!path.isAbsolute(executable) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) fail('KEY');
    const stat = fs.lstatSync(executable);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) fail('KEY');
    this.executable = executable; this.timeoutMs = timeoutMs; this.active = new Set();
    this.publicRecipient = publicRecipient ? recipient(publicRecipient) : null; this.identity = identity;
    if (identity) {
      const { fd } = open(identity, 16384);
      try {
        const keys = fs.readFileSync(fd, 'utf8').split(/\r?\n/).filter(s => s && !s.startsWith('#'));
        if (!keys.length || keys.length > 8 || keys.some(s => !/^AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}$/.test(s))) fail('KEY');
      } finally { fs.closeSync(fd); }
    }
  }
  close() { for (const stop of this.active) stop(); }
  encrypt(input, target, max) {
    if (!this.publicRecipient) fail('KEY');
    return this.transform(['--encrypt', '--recipient', this.publicRecipient], input, target, max);
  }
  decrypt(input, target, max) {
    if (!this.identity) fail('KEY');
    return this.transform(['--decrypt', '--identity', this.identity], input, target, max);
  }
  async transform(args, input, target, max) {
    let iterator;
    try { iterator = input[Symbol.asyncIterator](); if (typeof iterator.next !== 'function') fail('ENCRYPTION'); }
    catch { fail('ENCRYPTION'); }
    const child = spawn(this.executable, args, { shell: false, env: { PATH: path.dirname(this.executable), LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] }); // privacy-flow: paired-offsite
    const controller = new AbortController(); let stopped = false, inputEnded = false, cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => reject(new OffsiteError('ENCRYPTION')); });
    cancelled.catch(() => {}); // also safe when next() throws before a race starts
    child.stdin.on('error', () => {});
    const stop = () => {
      if (stopped) return;
      stopped = true; controller.abort(); cancel(); child.kill('SIGKILL');
      try { input.destroy?.(); } catch {}
      child.stdin.destroy(); child.stdout.destroy();
    };
    this.active.add(stop);
    const timer = setTimeout(stop, this.timeoutMs); let stderr = 0, spawnFailed = false;
    child.stderr.on('data', b => { stderr += b.length; if (stderr > 16384) stop(); });
    // Always wait for actual child close, including a failed spawn. Never expose
    // stderr, source/key paths or provider/tool diagnostics.
    const done = new Promise((resolve, reject) => {
      child.once('error', () => { spawnFailed = true; });
      child.once('close', code => code === 0 && !spawnFailed ? resolve() : reject(new OffsiteError('ENCRYPTION')));
    });
    const closed = done.then(() => ({ childClosed: true }), () => ({ childClosed: true }));
    const drain = () => new Promise((resolve, reject) => {
      const clean = () => { child.stdin.removeListener('drain', ready); child.stdin.removeListener('error', failed); child.stdin.removeListener('close', failed); controller.signal.removeEventListener('abort', failed); };
      const ready = () => { clean(); resolve(); };
      const failed = () => { clean(); reject(new OffsiteError('ENCRYPTION')); };
      child.stdin.once('drain', ready); child.stdin.once('error', failed); child.stdin.once('close', failed); controller.signal.addEventListener('abort', failed, { once: true });
      if (stopped || child.stdin.destroyed) failed();
    });
    const send = (async () => {
      try {
        while (true) {
          if (stopped) fail('ENCRYPTION');
          const step = await Promise.race([iterator.next(), cancelled, closed]);
          if (stopped || !step || step.childClosed) fail('ENCRYPTION');
          if (step.done) { inputEnded = true; break; }
          const value = step.value;
          if (stopped || child.stdin.destroyed) fail('ENCRYPTION');
          if (!child.stdin.write(value)) await drain();
        }
        if (!child.stdin.destroyed) child.stdin.end();
      } finally {
        // Request source cleanup, but a noncooperative return() must not keep
        // the job/lock alive after cancellation. Late next() resolutions never
        // resume this stopped writer.
        if (!inputEnded && typeof iterator.return === 'function') {
          try { Promise.resolve(iterator.return()).catch(() => {}); } catch {}
        }
      }
    })();
    const receive = consume(child.stdout, target, { max, signal: controller.signal });
    try { const [, bytes] = await Promise.all([send, receive, done]); return bytes; }
    catch { stop(); await Promise.allSettled([send, receive, done]); fail('ENCRYPTION'); }
    finally { clearTimeout(timer); this.active.delete(stop); }
  }
}
