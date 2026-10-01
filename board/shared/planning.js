// All-day planning dates are calendar days, never instants or runner grants.
export const MAX_PREDECESSORS = 20;
export const MAX_GRAPH_CARDS = 2000;
export const MAX_GRAPH_EDGES = 5000;
export const MAX_RANGE_DAYS = 3660;
const DAY = 86400000;
export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export const dayNumber = value => validDay(value) ? Date.parse(`${value}T00:00:00.000Z`) / DAY : null;
export function shiftDay(value, by) {
  if (!validDay(value) || !Number.isSafeInteger(by) || Math.abs(by) > MAX_RANGE_DAYS) return null;
  const next = new Date((dayNumber(value) + by) * DAY).toISOString().slice(0, 10);
  return validDay(next) ? next : null;
}
export function validRange(start, due) {
  return (start === null || validDay(start)) && (due === null || validDay(due)) &&
    (start === null || due === null || (start <= due && dayNumber(due) - dayNumber(start) <= MAX_RANGE_DAYS));
}
export function validZone(zone) {
  if (typeof zone !== 'string' || zone.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(0); return true; } catch { return false; }
}
export function todayIn(zone, now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: validZone(zone) ? zone : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = name => parts.find(p => p.type === name)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
// Iterative Kahn traversal caps work and avoids stack exhaustion on hostile DAGs.
export function orderGraph(ids, edges) {
  if (ids.length > MAX_GRAPH_CARDS || edges.length > MAX_GRAPH_EDGES) throw new Error('planning graph is too large');
  const unique = new Set(ids), incoming = new Map(ids.map(id => [id, 0])), next = new Map(ids.map(id => [id, []]));
  for (const { card_id, depends_on_card_id } of edges) {
    if (!unique.has(card_id) || !unique.has(depends_on_card_id)) throw new Error('dependency outside this board');
    if (card_id === depends_on_card_id) throw new Error('a card cannot depend on itself');
    incoming.set(card_id, incoming.get(card_id) + 1);
    next.get(depends_on_card_id).push(card_id);
  }
  const ready = ids.filter(id => incoming.get(id) === 0).sort(), order = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]; order.push(id);
    for (const child of next.get(id)) { incoming.set(child, incoming.get(child) - 1); if (incoming.get(child) === 0) ready.push(child); }
  }
  if (order.length !== unique.size) throw new Error('dependencies would form a cycle');
  return { order, next };
}
// CPM uses explicit planned durations only. Undated work is unknown, not a forecast.
export function criticalPath(cards, edges) {
  const open = cards.filter(c => !c.archived && c.column !== 'done'), ids = new Set(open.map(c => c.id));
  const activeEdges = edges.filter(e => ids.has(e.card_id) && ids.has(e.depends_on_card_id));
  if (!open.length) return { status: 'empty', path: [], slack_days: {} };
  if (open.some(c => !c.start_date || !c.due_date || !validRange(c.start_date, c.due_date))) return { status: 'unknown', reason: 'Add a start and due date to every open card to calculate planned slack.', path: [], slack_days: {} };
  let graph;
  try { graph = orderGraph([...ids], activeEdges); } catch { return { status: 'unknown', reason: 'The planning graph is unavailable.', path: [], slack_days: {} }; }
  const duration = new Map(open.map(c => [c.id, dayNumber(c.due_date) - dayNumber(c.start_date) + 1]));
  const early = new Map([...ids].map(id => [id, 0])), parent = new Map();
  for (const id of graph.order) for (const child of graph.next.get(id)) {
    const end = early.get(id) + duration.get(id);
    if (end > early.get(child)) { early.set(child, end); parent.set(child, id); }
  }
  const total = Math.max(...open.map(c => early.get(c.id) + duration.get(c.id)));
  const late = new Map([...ids].map(id => [id, total]));
  for (const id of [...graph.order].reverse()) for (const child of graph.next.get(id)) late.set(id, Math.min(late.get(id), late.get(child) - duration.get(child)));
  const slack_days = Object.fromEntries([...ids].map(id => [id, late.get(id) - duration.get(id) - early.get(id)]));
  let end = graph.order.find(id => early.get(id) + duration.get(id) === total), path = [];
  while (end) { path.unshift(end); end = parent.get(end); }
  return { status: 'available', path, slack_days, duration_days: total };
}
