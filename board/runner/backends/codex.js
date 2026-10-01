// Codex backend. Detection and the capability record are real; the
// `codex exec --json` spawn is slice E2 (verify flags against the installed
// CLI and record a fixture first). Plan (spike 6): CODEX_HOME=~/.board/codex
// with the member's own `codex login`; `codex exec --json -C <wt> -s
// workspace-write --ignore-user-config --ignore-rules`; `codex exec resume
// <id> "<msg>"`; no mid-turn injection, so comments go by resume. Hooks fail
// open, so gate G is enforced with signals.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { detectCli } from './detect.js';

export class NotAvailableError extends Error {
  constructor() {
    super('this AI backend is not available yet');
    this.code = 'NOT_AVAILABLE';
  }
}

export class CodexBackend extends EventEmitter {
  static describe() {
    return {
      id: 'codex',
      label: 'Codex',
      startable: false,
      // From the Codex CLI docs; flags still to verify against the installed CLI (TASKS-CONTRACT §18).
      capabilities: {
        budget: 'none', budgetUnit: null,          // no spend cap flag; metered budgets need a price table (order of work step 4)
        resume: true,                              // codex exec resume <id>
        interrupt: false,                          // no mid-turn input or interrupt in exec mode
        structuredEvents: true,                    // exec --json
        permissions: 'sandbox-flags',              // -s read-only | workspace-write, approvals never
        systemPrompt: false,
        model: true,                               // -m
        maxTurns: false,
      },
    };
  }

  /** `codex login status` exit 0, or its documented auth file existing, means signed in. */
  static detect(opts = {}) {
    return detectCli('codex', {
      ...opts,
      statusArgs: ['login', 'status'],
      authFiles: (env) => [env.CODEX_HOME ? path.join(env.CODEX_HOME, 'auth.json') : env.HOME && path.join(env.HOME, '.codex', 'auth.json')].filter(Boolean),
    });
  }

  constructor() {
    super();
    this.pid = null;
    this.lstart = null;
    this.pgid = null;
    this.exited = true;
    this.turnActive = false;
  }

  argv() { return []; }
  start() { throw new NotAvailableError(); }
  send() { return false; }
  interrupt() { return Promise.resolve(false); }
  endInput() {}
  stop() { return Promise.resolve(true); }
  kill() {}
  alive() { return false; }
}
