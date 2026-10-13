import { HubError } from '../db.js';

export const MAX_RESULT_BYTES = 64 * 1024;
const tooLarge = () => new HubError('PAYLOAD_TOO_LARGE',
  'Remote result exceeds 64 KiB. Narrow the query or open the task in Plexiform. For an uncertain write, reuse its request_id.');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
export const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export function boundedResult(value, mcpResponseId) {
  if (bytes(value) > MAX_RESULT_BYTES) throw tooLarge();
  // Include both copies of task content, JSON escaping and the actual request
  // id. Mutations call this before their transaction can commit or broadcast.
  if (mcpResponseId !== undefined) boundedRpcResult(toolResult(value), mcpResponseId);
  return value;
}
export function boundedRpcResult(result, id) {
  if (bytes({ jsonrpc: '2.0', id, result }) > MAX_RESULT_BYTES) throw tooLarge();
  return result;
}
