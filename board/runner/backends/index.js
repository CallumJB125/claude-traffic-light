// Backend registry (runner-adapters-contract.md §1): the board runner ("Tackle
// with AI") and the local Tasks engine ("Hand it off") share these adapters.
// The UI renders what describe()/detect() report; it never hard-codes a list.
import { ClaudeBackend } from './claude.js';
import { CodexBackend } from './codex.js';
import { HermesBackend, HermesDgxBackend } from './hermes.js';
import { GeminiBackend } from './gemini.js';

export const BACKENDS = Object.freeze({ claude: ClaudeBackend, codex: CodexBackend, hermes: HermesBackend, 'hermes-dgx': HermesDgxBackend, gemini: GeminiBackend });

// Every backend maps its CLI output to these and drops anything else (§4).
export const NORMALISED_EVENTS = Object.freeze(['init', 'tool_start', 'tool_end', 'assistant', 'usage', 'result', 'rate_limit', 'exit']);
// Backend-internal plumbing a backend may also emit (interrupt acks, compaction marks).
export const INTERNAL_EVENTS = Object.freeze(['control_response', 'compact']);

export const CAPABILITY_VALUES = Object.freeze({
  budget: ['native', 'metered', 'none'],
  budgetUnit: ['usd', 'tokens', null],
  resume: [true, false],
  interrupt: [true, false],
  structuredEvents: [true, false],
  permissions: ['hooks', 'sandbox-flags', 'none'],
  systemPrompt: [true, false],
  model: [true, false],
  maxTurns: [true, false],
});

export function describeAll() {
  return Object.values(BACKENDS).map((B) => B.describe());
}

export { NotAvailableError } from './codex.js';
