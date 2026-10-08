// Event triggers (docs/event-triggers.md, migration 071): "when X happens, do
// Y" rules a team admin writes for a team. Pure and browser-safe: the closed
// event and action lists, rule validation, filter matching and the
// plain-language sentence. board/hub/triggers.js runs them.
//
// HARD RULE: no trigger action may start an editing AI run, dispatch, retry or
// move a card, answer a permission, approve work, merge or push code.
// TRIGGER_ACTIONS is closed; request_ai_review asks the existing read-only
// reviewer (hub/reviews.js), which reports findings on the card and never
// edits. Anything not on the list is refused when a rule is saved and again
// when it fires.

export const TRIGGER_EVENTS = Object.freeze(['github.pr.opened', 'github.pr.review_requested', 'github.checks.failed', 'card.moved_to_review', 'sentry.issue.new']);
export const TRIGGER_ACTIONS = Object.freeze(['create_card', 'add_comment', 'request_ai_review', 'notify_member', 'label_card']);
export const TRIGGER_MODES = Object.freeze(['off', 'dry_run', 'on']);
export const TRIGGER_RESULTS = Object.freeze(['done', 'would', 'skipped', 'failed', 'rate_limited']);
// Effects a trigger can never have, whatever a rule says (docs and tests check them).
export const TRIGGER_NEVER = Object.freeze(['dispatch', 'retry', 'take_over', 'request_changes', 'approve_done', 'move_card', 'answer_permission', 'merge', 'push']);

export const DRY_RUN_MS = 7 * 86_400_000;
export const RATE_DEFAULT = 10;
export const RATE_MAX = 60;
export const LOG_LIMIT = 100;
export const TRIGGERS_PER_TEAM = 50;
export const COMMENT_MAX = 1000;
export const LABEL_MAX = 50;

const GITHUB = new Set(['github.pr.opened', 'github.pr.review_requested', 'github.checks.failed']);
// Which filters an event can be narrowed by; anything else is refused when saved.
const FILTERS_FOR = Object.freeze({
  'github.pr.opened': ['repo', 'branch', 'label'],
  'github.pr.review_requested': ['repo', 'branch', 'label'],
  'github.checks.failed': ['repo', 'branch'],
  'card.moved_to_review': ['repo', 'branch', 'label'],
  'sentry.issue.new': [],
});
// create_card needs something outside the board to make a card from.
const CREATES_FROM = new Set([...GITHUB, 'sentry.issue.new']);

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/*-]{1,100}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const invalid = (message) => Object.assign(new Error(message), { code: 'VALIDATION' });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys, what) => {
  if (v == null) return {};
  if (!isObj(v) || Object.keys(v).some((k) => !keys.includes(k))) throw invalid(`${what} may only hold ${keys.length ? keys.join(', ') : 'nothing'}`);
  return v;
};
const line = (v, max, what) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max || CONTROL.test(v.trim().replace(/\n/g, ' '))) throw invalid(`${what} must be 1–${max} characters of plain text`);
  return v.trim();
};

/** {event, filters, action, params, max_per_hour} from a request body; throws {code: 'VALIDATION'}. */
export function validateRule(body) {
  if (!isObj(body)) throw invalid('a trigger needs an event and an action');
  const { event, action } = body;
  if (!TRIGGER_EVENTS.includes(event)) throw invalid(`event must be one of ${TRIGGER_EVENTS.join(', ')}`);
  if (!TRIGGER_ACTIONS.includes(action)) throw invalid(`action must be one of ${TRIGGER_ACTIONS.join(', ')}; nothing else is allowed`);
  const f = closed(body.filters, FILTERS_FOR[event], 'filters for this event');
  const filters = {};
  if (f.repo != null && f.repo !== '') {
    if (typeof f.repo !== 'string' || !REPO_RE.test(f.repo.trim())) throw invalid('repo must be owner/name');
    filters.repo = f.repo.trim();
  }
  if (f.branch != null && f.branch !== '') {
    if (typeof f.branch !== 'string' || !BRANCH_RE.test(f.branch.trim())) throw invalid('branch must be a branch name; * matches any characters');
    filters.branch = f.branch.trim();
  }
  if (f.label != null && f.label !== '') filters.label = line(f.label, LABEL_MAX, 'label');
  if (action === 'create_card' && !CREATES_FROM.has(event)) throw invalid('create_card needs a GitHub or Sentry event to make the card from');
  const params = {};
  if (action === 'create_card') {
    const p = closed(body.params, ['board_id'], 'params');
    if (typeof p.board_id !== 'string' || !ID_RE.test(p.board_id)) throw invalid('create_card needs the board_id the card goes to');
    params.board_id = p.board_id;
  } else if (action === 'add_comment') {
    const p = closed(body.params, ['text'], 'params');
    params.text = line(p.text, COMMENT_MAX, 'the comment');
  } else if (action === 'notify_member') {
    const p = closed(body.params, ['member_id'], 'params');
    if (typeof p.member_id !== 'string' || !ID_RE.test(p.member_id)) throw invalid('notify_member needs the member_id to notify');
    params.member_id = p.member_id;
  } else if (action === 'label_card') {
    const p = closed(body.params, ['label'], 'params');
    params.label = line(p.label, LABEL_MAX, 'the label');
    if (params.label.toLowerCase().startsWith('via:')) throw invalid('via: labels are kept for integrations');
  } else closed(body.params, [], 'params');
  let rate = RATE_DEFAULT;
  if (body.max_per_hour != null) {
    if (!Number.isSafeInteger(body.max_per_hour) || body.max_per_hour < 1 || body.max_per_hour > RATE_MAX) throw invalid(`max_per_hour must be 1–${RATE_MAX}`);
    rate = body.max_per_hour;
  }
  return { event, filters, action, params, max_per_hour: rate };
}

/** `*` in a branch pattern matches any run of characters (slashes too); everything else is literal. */
export function branchMatches(pattern, branch) {
  if (typeof branch !== 'string' || !branch) return false;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/-]/g, '\\$&')).join('.*')}$`);
  return re.test(branch);
}

/** Does an event (hub/trigger-events.js shape) pass a rule's filters? */
export function filtersMatch(filters, ev) {
  if (filters.repo && String(ev.repo ?? '').toLowerCase() !== filters.repo.toLowerCase()) return false;
  if (filters.branch && !branchMatches(filters.branch, ev.branch)) return false;
  if (filters.label && !(ev.labels ?? []).some((l) => String(l).toLowerCase() === filters.label.toLowerCase())) return false;
  return true;
}

const EVENT_TEXT = {
  'github.pr.opened': 'a pull request is opened',
  'github.pr.review_requested': 'a review is requested on a pull request',
  'github.checks.failed': 'checks fail on a pull request',
  'card.moved_to_review': 'a card moves to Review',
  'sentry.issue.new': 'Sentry reports a new issue',
};
const quote = (s, max = 60) => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;

/** What the rule's action does, as a phrase ("ask the AI to review it and comment"). */
export function actionPhrase(rule, { boardName = null, memberName = null } = {}) {
  const p = rule.params ?? {};
  switch (rule.action) {
    case 'create_card': return `create a card on ${boardName ?? 'a board'}`;
    case 'add_comment': return `comment ${quote(String(p.text ?? ''))} on its card`;
    case 'request_ai_review': return 'ask the AI to review it and comment';
    case 'notify_member': return `notify ${memberName ?? 'a teammate'}`;
    case 'label_card': return `label its card ${quote(String(p.label ?? ''), LABEL_MAX)}`;
    default: return 'do nothing (not an allowed action)';
  }
}

/** "When a pull request is opened in acme/api, ask the AI to review it and comment" */
export function ruleSentence(rule, names = {}) {
  const f = rule.filters ?? {};
  const where = [
    f.repo ? ` in ${f.repo}` : '',
    f.branch ? ` on a branch matching ${f.branch}` : '',
    f.label ? ` labelled ${quote(f.label, LABEL_MAX)}` : '',
  ].join('');
  return `When ${EVENT_TEXT[rule.event] ?? 'something happens'}${where}, ${actionPhrase(rule, names)}`;
}
