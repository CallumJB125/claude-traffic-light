'use strict';
// Does this Bash call deploy to Vercel, Netlify or Cloudflare? The answer is
// the host's name only; the command itself is never kept (set-status.js
// records just `deployAt`, so the app checks that project's deploys sooner).
function deployCommandOf(payload) {
  const p = payload || {};
  if (p.tool_name !== 'Bash' || !p.tool_input || typeof p.tool_input.command !== 'string') return null;
  const c = p.tool_input.command.slice(0, 2000);
  if (/(?:^|[\s;&|(])(?:npx\s+|bunx\s+|pnpm\s+(?:dlx\s+)?)?vercel(?:\s+(?:deploy|--prod)\b|\s*$|\s*[;&|)])/.test(c)) return 'vercel';
  if (/\bnetlify\s+deploy\b/.test(c)) return 'netlify';
  if (/\bwrangler\s+(?:deploy|publish|pages\s+deploy)\b/.test(c)) return 'cloudflare';
  return null;
}
module.exports = { deployCommandOf };
