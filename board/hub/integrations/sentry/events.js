// Fixed facts from a verified payload. No actor, query, stack, or tool text.
// Issue status order is hub-observation order: lastSeen is an occurrence time,
// and the provider's unsigned timestamp header cannot order status changes.
import { own, ISSUE_ID_RE, SLUG_RE, LEVELS, parseIso, cardText, issueLink, incidentText, incidentLink } from './text.js';

const DAY = 86_400_000, AHEAD = 300_000;
const fresh = (t, now) => t !== null && t >= now - DAY && t <= now + AHEAD;
export const cooldownMinutes = config => Number.isSafeInteger(own(config, 'cooldown_minutes')) && config.cooldown_minutes >= 1 && config.cooldown_minutes <= 1440 ? config.cooldown_minutes : 60;

export function issueEvent(payload, { now, config = {} }) {
  const action = own(payload, 'action'), issue = own(own(payload, 'data'), 'issue');
  if (own(own(payload, 'data'), 'metric_alert') !== undefined) return null;
  if (!['created', 'resolved', 'archived', 'unresolved'].includes(action)) return null;
  const id = own(issue, 'id'), slug = own(own(issue, 'project'), 'slug');
  if (typeof id !== 'string' || !ISSUE_ID_RE.test(id) || typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  const first = parseIso(own(issue, 'firstSeen'));
  if (first === null || first > now + AHEAD) return null;
  if (action === 'created') {
    if (!fresh(first, now)) return null;
    const min = LEVELS.includes(own(config, 'min_level')) ? config.min_level : 'error';
    const level = LEVELS.includes(own(issue, 'level')) ? issue.level : 'error';
    if (LEVELS.indexOf(level) > LEVELS.indexOf(min)) return null;
    return { action, id, projects: [slug], url: issueLink(issue), ...cardText(issue, { includeMessage: own(config, 'include_message') === true }) };
  }
  const expected = action === 'resolved' ? 'resolved' : action === 'archived' ? 'ignored' : 'unresolved';
  if (own(issue, 'status') !== expected) return null;
  const state = action === 'unresolved' && own(issue, 'substatus') === 'regressed' ? 'regressed' : expected;
  const line = { resolved: 'Sentry reported this issue resolved.', ignored: 'Sentry reported this issue archived (ignored).', regressed: 'Sentry reported a regression for this issue.', unresolved: 'Sentry reported this issue unresolved.' }[state];
  const url = issueLink(issue);
  return { action, state, id, projects: [slug], url, body: `${line}\nThis is the last signed update observed by this hub; it does not move the card or start an AI.${url ? `\nSentry: ${url}` : ''}` };
}

export function metricEvent(payload, { now, config = {} }) {
  const action = own(payload, 'action'), alert = own(own(payload, 'data'), 'metric_alert');
  if (own(own(payload, 'data'), 'issue') !== undefined) return null;
  if (!['critical', 'warning', 'resolved'].includes(action)) return null;
  const id = own(alert, 'id'), rule = own(alert, 'alert_rule'), ruleId = own(rule, 'id');
  const org = own(alert, 'organization_id');
  if (![id, ruleId, org].every(v => typeof v === 'string' && ISSUE_ID_RE.test(v)) || own(rule, 'organization_id') !== org) return null;
  const projects = own(alert, 'projects');
  if (!Array.isArray(projects) || projects.length < 1 || projects.length > 32 || !projects.every(v => typeof v === 'string' && SLUG_RE.test(v)) || new Set(projects).size !== projects.length) return null;
  const start = parseIso(own(alert, 'date_started'));
  if (start === null || start > now + AHEAD) return null;
  // Stable signed episode, not arrival time. No arbitrary title/query is used.
  const episode = Math.floor(start / (cooldownMinutes(config) * 60_000));
  const url = incidentLink(alert, own(own(payload, 'data'), 'web_url'));
  return { action, state: action, id, ruleId, projects, ref: `sentry-incident-${ruleId}-${episode}`, url,
    ...incidentText(alert, { projects, start, url }),
    statusBody: `Sentry reported this incident ${action}.\nThis is the last signed update observed by this hub; it does not move the card or start an AI.${url ? `\nSentry: ${url}` : ''}` };
}
