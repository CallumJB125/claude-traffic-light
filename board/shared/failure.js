// Why a CLI run failed, in words that are safe to show. classifyFailure() picks one kind from the CLI's result
// text; reasonLine() makes the redacted first line that only the Tasks UI may show (failReason); KIND_SENTENCE is
// the fixed sentence every other surface gets (bus_wait, hub reports, overview, diagnostics, crash reports).
import os from 'node:os';
import { redactSecrets } from './secret-patterns.mjs';

export const KIND_SENTENCE = Object.freeze({
  auth: 'The AI needs you to sign in again.',
  limit: 'The AI hit its usage limit.',
  provider: "The AI provider didn't accept the request or couldn't be reached.",
  network: 'The connection to the AI was lost.',
  error: 'The AI stopped with an error.',
});

const LIMIT = /usage limit|rate[ _-]?limit|\b429\b|overloaded/i;
const AUTH = /\b401\b|unauthori[sz]ed|not logged in|log ?in again|please run \/login|invalid api key|authentication|missing environment variable/i;
const REFUSED = /ECONNREFUSED|connection refused/i;
const MODEL = /(?:model|deployment)\b.{0,60}(?:not found|does not exist|unknown|unrecogni[sz]ed|not supported|invalid)|model_not_found|not_found_error|invalid model/i;
const GATEWAY = /\bAPI Error:? ?[45]\d\d\b|\b(?:400|403|404|408|500|502|503|504)\b.{0,40}(?:error|bad|not found|gateway|unavailable|forbidden|no connected)|no connected db|bad gateway|service unavailable|internal server error/i;
const SANDBOX = /bwrap|bubblewrap.{0,40}(?:fail|denied|error|cannot)|sandbox.{0,40}(?:fail|denied|unavailable|could not)/i;
const NETWORK = /network|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|offline/i;

/** carried: the run used the user's own provider, so a failed connection is that provider's, not the internet's. */
export function classifyFailure(text, { carried = false } = {}) {
  const t = String(text ?? '');
  if (LIMIT.test(t)) return 'limit';
  if (AUTH.test(t)) return 'auth';
  if (REFUSED.test(t) || MODEL.test(t) || GATEWAY.test(t) || SANDBOX.test(t)) return 'provider';
  if (NETWORK.test(t)) return carried ? 'provider' : 'network';
  return 'error';
}

const MAX_REASON = 200;

/** The first line of `text`, redacted and at most 200 characters; '' when there is none. */
export function reasonLine(text, { home = os.homedir() } = {}) {
  let line = String(text ?? '').slice(0, 4000).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const msg = /"message"\s*:\s*"((?:[^"\\]|\\.){1,200})"/.exec(line);
  if (msg) line = msg[1];
  line = line
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\bx-api-key["']?\s*[:=]\s*\S+/gi, 'x-api-key: <redacted>');
  line = redactSecrets(line);
  if (typeof home === 'string' && home.length > 1) line = line.split(home).join('~');
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}
