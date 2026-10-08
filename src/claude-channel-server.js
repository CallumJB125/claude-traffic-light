'use strict';
// Claude Code starts this stdio MCP server after the user opts this exact
// development channel into their terminal. It never starts or controls Claude.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

function endpoint(env) {
  let u; try { u = new URL(env.PLEXIFORM_CLAUDE_CHANNEL_ORIGIN); } catch { throw new Error('Channel configuration is unavailable'); }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash || !/^[0-9a-f]{64}$/.test(env.PLEXIFORM_CLAUDE_CHANNEL_TOKEN || '')) throw new Error('Channel configuration is unavailable');
  return u.origin;
}
async function run({ env = process.env, transport = new StdioServerTransport() } = {}) {
  const origin = endpoint(env), token = env.PLEXIFORM_CLAUDE_CHANNEL_TOKEN;
  let link = null, stopped = false;
  async function call(route, value) {
    const response = await fetch(origin + route, { // privacy-flow: claude-terminal-channel
      method: value === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, ...(link ? { 'x-plexiform-link': link } : {}), ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    if (!response.ok) throw new Error('Channel connection was refused');
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 20_000) throw new Error('Channel response is too large');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server = new Server({ name: 'plexiform', version: '1.0.0' }, {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: 'Plexiform channel events carry message_id. Before acting, call plexiform_accept with that message_id and the exact event content. After answering, call plexiform_reply with that same message_id and the response text. Never invent ids, accept altered content, approve permissions or send unrelated text. Your terminal retains its normal permissions.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'plexiform_accept', description: 'Confirm this exact Plexiform channel message was received before acting on it.', inputSchema: { type: 'object', additionalProperties: false, properties: { message_id: { type: 'string' }, text: { type: 'string' } }, required: ['message_id', 'text'] } },
    { name: 'plexiform_reply', description: 'Return the answer for a previously accepted Plexiform channel message.', inputSchema: { type: 'object', additionalProperties: false, properties: { message_id: { type: 'string' }, text: { type: 'string' } }, required: ['message_id', 'text'] } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const route = { plexiform_accept: '/accept', plexiform_reply: '/reply' }[request.params.name];
    if (!route) return { isError: true, content: [{ type: 'text', text: 'Unknown channel tool.' }] };
    try { await call(route, request.params.arguments); return { content: [{ type: 'text', text: 'Recorded by Plexiform.' }] }; }
    catch { return { isError: true, content: [{ type: 'text', text: 'The channel message is stale or the connection was refused.' }] }; }
  });
  const close = async () => { stopped = true; await server.close(); };
  server.onclose = () => { stopped = true; };
  await server.connect(transport); // privacy-flow: claude-terminal-channel
  ({ link } = await call('/connect', { protocol: 1 }));
  const poll = (async () => {
    try {
      while (!stopped) {
        const value = await call('/next');
        if (value !== null) await server.notification({ method: 'notifications/claude/channel', params: { content: value.content, meta: { message_id: value.message_id } } }); // privacy-flow: claude-terminal-channel
      }
    } catch { await close(); }
  })();
  return { close, poll };
}
if (require.main === module) run().catch(() => { process.stderr.write('Plexiform Claude channel is unavailable.\n'); process.exitCode = 1; });
module.exports = { run, endpoint };
