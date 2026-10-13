// One mapping from an observed (locally reported) session to a board lane, used
// by the board, the table and My day. Browser-safe, no clocks of its own beyond
// the `now` fallback for hubs that have lost their in-memory report ages.
export const OBSERVED_STALE_MS = 90_000;
export const OBSERVED_ARCHIVE_MS = 24 * 3_600_000;
export const COLUMN_LABELS = Object.freeze({ todo: 'To do', in_progress: 'In progress', in_review: 'Review', done: 'Done' });

// Titles of background/internal AI sessions (memory generation, summaries). The
// capture filter (src/work-capture.js) refuses these; cards created before it
// did are archived here. test/work-capture.test.js keeps the two in step.
export const BACKGROUND_TITLE = /^(?:\w+ · )?(?:memor(?:y|ies)|summar(?:y|ies)|title generation|session summary)$/i;
export const isBackgroundTitle = (title) => typeof title === 'string' && BACKGROUND_TITLE.test(title.trim());

export const isHumanOwned = (view) => (view.run_state ?? 'todo') === 'todo';
export const isObservedWork = (view) => !view.run && isHumanOwned(view) && view.capture?.source === 'local_observation';

export function captureAgeMs(capture, elapsed = 0, now = Date.now()) {
  if (Number.isFinite(capture?.age_ms) && capture.age_ms >= 0) return capture.age_ms + elapsed;
  const at = Date.parse(capture?.received_at);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

// 'active' | 'idle' | 'archived' | null (not observed work). A card a person
// placed by hand is never idled or hidden; finished reports wait in Review.
export function observedLane(view, elapsed = 0, now = Date.now()) {
  if (!isObservedWork(view)) return null;
  const c = view.capture;
  if (c.managed?.column === false) return 'active';
  if (isBackgroundTitle(view.title)) return 'archived';
  const age = captureAgeMs(c, elapsed, now);
  if (age != null && age > OBSERVED_ARCHIVE_MS) return 'archived';
  if ((age == null ? c.fresh === true : age < OBSERVED_STALE_MS) && c.tracking !== 'stopped' && c.tracking !== 'deleted') return 'active';
  return ['review', 'ended'].includes(c.reported_status) ? 'active' : 'idle';
}

// The state word for a card with no run behind it; run-owned cards keep run_state.
export function stateKey(view, elapsed = 0, now = Date.now()) {
  if (!isHumanOwned(view)) return view.run_state;
  return observedLane(view, elapsed, now) === 'idle' ? 'idle' : (view.column ?? 'todo');
}
