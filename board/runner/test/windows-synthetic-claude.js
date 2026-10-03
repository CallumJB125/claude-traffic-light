// Test-only stream-json fixture. This is not a Claude sandbox implementation:
// production ClaudeBackend.start continues to refuse native Windows launches.
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { interruptRequest } from '../launch.js';
import { ClaudeBackend } from '../backends/claude.js';
import { WindowsJob } from '../windows-job.js';

export class WindowsSyntheticClaude extends ClaudeBackend {
  static describe() {
    return ClaudeBackend.describe('linux');
  }
  constructor(options) {
    super({ ...options, platform: 'win32' });
    this.makeJob = options.makeJob ?? ((...args) => new WindowsJob(...args));
  }
  async start(prompt) {
    const fixture = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
    // bin is a synthetic scenario JSON, never a provider executable.
    this.child = this.makeJob(process.execPath, [fixture, this.bin, ...this.argv()], { cwd: this.cwd, env: this.env });
    this.attachChild(this.child);
    await this.child.ready;
    this.pid = this.child.pid; this.lstart = this.child.lstart; this.pgid = null;
    if (this.child.closed) throw new Error('Synthetic Windows fixture exited during startup');
    if (prompt) this.send(prompt);
    return this;
  }
  interrupt() {
    if (!this.alive()) return Promise.resolve(false);
    const id = `int-${crypto.randomUUID()}`;
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); this.off('control_response', response); resolve(value); };
      const response = value => { if (value.request_id === id) done(true); };
      const timer = setTimeout(() => done(false), this.interruptWaitMs);
      this.on('control_response', response);
      this.child.stdin.write(interruptRequest(id));
    });
  }
  refreshTree() {} // The retained Job Object tracks descendants from creation.
  reap() {} // Native root exit reaps descendants before it emits an exit receipt.
  kill() { void this.child?.stop(); }
  confirmStopped() { return this.child ? !!(this.child.closed && this.child.stopped) : this.pid === null; }
  async stop() {
    this.stopping = true;
    // Fixture interrupt always responds; retain this protocol coverage before
    // the Job stop boundary. No POSIX signal or negative PID authority.
    if (this.alive() && this.turnActive) await this.interrupt();
    return this.child ? this.child.stop() : this.pid === null;
  }
}
