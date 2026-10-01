import { validDay, shiftDay, dayNumber } from '../../shared/planning.js';
export function calendarDays(anchor, period = 'month') {
  if (!validDay(anchor)) return [];
  const first = period === 'week' ? anchor : `${anchor.slice(0, 7)}-01`;
  const weekday = new Date(`${first}T00:00:00Z`).getUTCDay();
  const start = shiftDay(first, -(weekday + 6) % 7);
  return Array.from({ length: period === 'week' ? 7 : 42 }, (_, i) => shiftDay(start, i)).filter(Boolean);
}
export function nextAnchor(anchor, direction, period) {
  if (period === 'week' || period === 'timeline') return shiftDay(anchor, direction * (period === 'week' ? 7 : 28));
  const [year, month] = anchor.split('-').map(Number);
  const next = new Date(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + direction);
  const value = next.toISOString().slice(0, 10);
  return validDay(value) ? value : anchor;
}
export function scheduledOn(card) { return card.due_date ?? card.start_date ?? null; }
export function movedDates(card, destination) {
  const from = scheduledOn(card);
  if (!validDay(destination)) return null;
  if (!from) return { due_date: destination };
  const delta = dayNumber(destination) - dayNumber(from);
  const start = card.start_date ? shiftDay(card.start_date, delta) : null, due = card.due_date ? shiftDay(card.due_date, delta) : null;
  if ((card.start_date && !start) || (card.due_date && !due)) return null;
  return { start_date: start, due_date: due };
}
