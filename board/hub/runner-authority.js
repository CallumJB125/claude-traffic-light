// Socket authority is live, including after waiting on a board queue. A
// retained device row cannot authorize a revoked or replaced connection.
import { WS_CLOSE } from '../shared/protocol.js';

export function runnerConnectionProblem(hub, connection, { registered = true } = {}) {
  if (!connection || connection.closed) return { close: WS_CLOSE.REVOKED, reason: 'runner connection closed' };
  if (registered && (!connection.ready || hub.runners.get(connection.device_id) !== connection)) return { close: WS_CLOSE.REPLACED, reason: 'runner connection no longer current' };
  const device = hub.device(connection.device_id), member = device && hub.activeMember(device.member_id);
  if (!device || device.revoked_at || device.member_id !== connection.member_id || !member || !hub.canWrite(member)) return { close: WS_CLOSE.REVOKED, reason: 'runner device or membership revoked' };
  if (hub.config.auth === 'accounts' && !connection.enrollmentId) return { close: WS_CLOSE.UNAUTHENTICATED, reason: 'runner enrolment required' };
  if (connection.enrollmentId) {
    const enrollment = hub.db.get('SELECT * FROM runner_enrollments WHERE id = ?', connection.enrollmentId);
    if (!enrollment || enrollment.device_id !== device.id || enrollment.member_id !== member.id || enrollment.org_id !== member.org_id || !hub.enrolments) return { close: WS_CLOSE.REVOKED, reason: 'runner enrolment revoked' };
    const problem = hub.enrolments.problem(enrollment);
    if (problem) return problem;
  }
  return null;
}
