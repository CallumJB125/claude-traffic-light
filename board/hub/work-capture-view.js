// An observation is reported metadata, never a registered runner heartbeat.
export const CAPTURE_FRESH_MS = 60_000;
export function workCaptureView(hub, cardId) {
  const row = hub.db.get('SELECT * FROM work_capture_cards WHERE card_id=?', cardId);
  if (!row) return null;
  const live = hub.workCaptureSeen?.get(row.id);
  const age = live?.epoch === hub.epoch ? hub.mono() - live.mono : null;
  const fresh = row.tracking === 'active' && age != null && age >= 0 && age < CAPTURE_FRESH_MS;
  return { id: row.id, source: 'local_observation', provider: row.provider, provider_verified: false,
    reported_status: row.reported_status, status: fresh ? row.reported_status : 'unknown', fresh,
    received_at: row.received_at, age_ms: age == null ? null : Math.max(0, Math.round(age)), tracking: row.tracking,
    managed: { title: !!row.title_managed, body: !!row.body_managed, column: !!row.column_managed },
    grants_execution: false, verified_run: false };
}
