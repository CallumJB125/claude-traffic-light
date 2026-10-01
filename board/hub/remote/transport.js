import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { HubError } from '../db.js';
import { redact } from '../../shared/scope.js';
import { closed, invalid } from './validation.js';
import { toolResult, boundedRpcResult } from './result.js';

// The shipped SDK negotiates initialize and owns framing. HTTP versions that
// predate Streamable HTTP are not supported by this resource.
export const PROTOCOLS = Object.freeze(SUPPORTED_PROTOCOL_VERSIONS.filter(version => version >= '2025-03-26'));
const METHODS = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call']);
export function validateRpc(body, protocol) {
  closed(body, ['jsonrpc', 'id', 'method', 'params'], ['jsonrpc', 'method']);
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string' || !METHODS.has(body.method)
    || Object.hasOwn(body, 'id') && !(Number.isSafeInteger(body.id) || typeof body.id === 'string' && body.id.length <= 128
      && !/[\x00-\x1f\x7f]/.test(body.id) && redact(body.id, null) === body.id)) throw invalid();
  if (body.method !== 'initialize' && !PROTOCOLS.includes(protocol)) throw invalid();
  if (body.method === 'initialize' && protocol != null && !PROTOCOLS.includes(protocol)) throw invalid();
  if (body.method === 'notifications/initialized' ? Object.hasOwn(body, 'id') : !Object.hasOwn(body, 'id')) throw invalid();
}
export async function serveMcp({ req, res, body, token, actions, signal, state }) {
  // Never retain a transport/session or trust a previous initialize request.
  const server = new Server({ name: 'plexiform', version: '1.0.0' }, { capabilities: { tools: {} } });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
    allowedHosts: [req.headers.host], enableDnsRebindingProtection: true, maxRequestBodySize: 64 * 1024 });
  let closed = false;
  const close = () => {
    if (closed) return; closed = true; state.transports.delete(transport);
    signal.removeEventListener('abort', close);
    // SDK close cancels its pending responses; private action checks also
    // refuse after this request's disconnect/deadline, inside ordinary queues.
    server.close().catch(() => {});
  };
  server.setRequestHandler(ListToolsRequestSchema, () => boundedRpcResult({ tools: actions.catalog(token, 'mcp') }, body.id));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const result = await actions.call(token, 'mcp', request.params.name, request.params.arguments ?? {}, { signal, mcpResponseId: body.id });
      return toolResult(result);
    } catch (error) {
      if (!(error instanceof HubError)) throw new Error('Remote collaboration unavailable.');
      return { content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code, message: error.message } }) }], isError: true };
    }
  });
  state.transports.add(transport); signal.addEventListener('abort', close, { once: true });
  let abortWait;
  const aborted = new Promise((_, reject) => { abortWait = () => reject(new HubError('TIMEOUT', 'remote request ended')); signal.addEventListener('abort', abortWait, { once: true }); });
  try {
    if (signal.aborted) throw new HubError('TIMEOUT', 'request ended');
    await server.connect(transport);
    await Promise.race([transport.handleRequest(req, res, body), aborted]);
  } finally { signal.removeEventListener('abort', abortWait); close(); }
}
