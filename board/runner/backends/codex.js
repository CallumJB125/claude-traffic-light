// Codex backend: Phase 1.5 (D21). Interface only, so the supervisor's Backend
// seam is fixed now. Plan (spike 6): CODEX_HOME=~/.board/codex with the
// member's own `codex login`; `codex exec --json -C <wt> -s workspace-write
// --ignore-user-config --ignore-rules`; `codex exec resume <id> "<msg>"`; no
// mid-turn injection, so comments go by resume. Hooks fail open, so gate G
// is enforced with signals.
import { EventEmitter } from 'node:events';

export class CodexBackend extends EventEmitter {
  constructor() {
    super();
    this.pid = null;
    this.lstart = null;
    this.exited = true;
    this.turnActive = false;
  }

  start() { throw notYet('start'); }
  send() { throw notYet('send'); }
  interrupt() { return Promise.reject(notYet('interrupt')); }
  endInput() {}
  stop() { return Promise.resolve(true); }
  kill() {}
  alive() { return false; }
}

function notYet(what) {
  const e = new Error(`codex backend ${what}: not implemented until Phase 1.5`);
  e.code = 'POLICY_DENIED';
  return e;
}
