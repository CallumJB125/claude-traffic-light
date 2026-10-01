import { dayNumber, shiftDay, criticalPath } from '../../shared/planning.js';
export function timelineModel(cards, anchor) {
  const days = Array.from({ length: 28 }, (_, i) => shiftDay(anchor, i)).filter(Boolean), left = dayNumber(anchor), right = left + days.length - 1;
  const edges = cards.flatMap(c => (c.depends_on ?? []).map(id => ({ card_id: c.id, depends_on_card_id: id })));
  const critical = criticalPath(cards, edges);
  const ranges = cards.map(card => {
    const start = dayNumber(card.start_date ?? card.due_date), end = dayNumber(card.due_date ?? card.start_date);
    const visible = start != null && end != null && start <= right && end >= left;
    const offset = visible ? Math.max(0, start - left) : null;
    const span = visible ? Math.min(right, end) - Math.max(left, start) + 1 : 0;
    return { card, offset, span, critical: critical.path.includes(card.id), slack: critical.slack_days[card.id] ?? null };
  });
  return { days, ranges, critical };
}
