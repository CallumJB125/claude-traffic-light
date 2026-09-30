// Cloudflare Pages Function: POST /api/waitlist. Stores an email and the agent
// the person says they use in the WAITLIST KV namespace (binding name
// WAITLIST), and nothing else. Needs that KV binding on the Pages project.
const USES = ['', 'Claude Code', 'Codex', 'Cursor', 'Gemini', 'More than one'];
const EMAIL = /^[^\s@<>"',;:()\[\]\\]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const MAX_BODY = 2048;
const WINDOW_S = 600;
const MAX_PER_WINDOW = 5;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function onRequestPost({ request, env }) {
  // same-site posts only: a form on another origin can't fill our list
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Not allowed.' }, 403);
  if (!env || !env.WAITLIST) return json({ error: 'The waitlist is not open yet. Email us instead.' }, 503);

  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ error: 'That was too much to send.' }, 413);
  let text;
  try { text = await request.text(); } catch { return json({ error: 'Could not read that.' }, 400); }
  if (text.length > MAX_BODY) return json({ error: 'That was too much to send.' }, 413);

  let data;
  const type = request.headers.get('content-type') || '';
  try {
    data = type.includes('application/json') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
  } catch { return json({ error: 'Could not read that.' }, 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'Could not read that.' }, 400);

  // a bot filled the hidden field: say yes, keep nothing
  if (typeof data.hp === 'string' && data.hp.trim()) return json({ ok: true });

  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email)) return json({ error: 'That email doesn\'t look right.' }, 400);
  const uses = typeof data.uses === 'string' && USES.includes(data.uses) ? data.uses : '';

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const rlKey = `rl:${ip}`;
  const seen = Number((await env.WAITLIST.get(rlKey)) || 0);
  if (seen >= MAX_PER_WINDOW) return json({ error: 'Too many tries. Wait a few minutes and try again.' }, 429);
  await env.WAITLIST.put(rlKey, String(seen + 1), { expirationTtl: WINDOW_S });

  // the same answer whether or not they were already on the list
  const key = `email:${email}`;
  if ((await env.WAITLIST.get(key)) == null) await env.WAITLIST.put(key, JSON.stringify({ email, uses, at: new Date().toISOString() }));
  return json({ ok: true });
}

export function onRequest() {
  return json({ error: 'Use POST.' }, 405);
}
