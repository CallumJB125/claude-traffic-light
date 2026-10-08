// Test-only `node --import` preload for a spawned hub: the hub's outbound
// calls to Google and GitHub go to a fake provider on loopback instead. The hub
// code itself is unchanged; only the network address of the provider moves.
// Never shipped (test/ is not packaged) and refuses any non-loopback target.

const target = process.env.PLEXIFORM_TEST_OAUTH_PROVIDER ?? '';
const t = new URL(target);
if (t.protocol !== 'http:' || t.hostname !== '127.0.0.1') throw new Error('PLEXIFORM_TEST_OAUTH_PROVIDER must be http://127.0.0.1:<port>');

const HOSTS = new Set(['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'github.com', 'api.github.com']);
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (u.protocol === 'https:' && HOSTS.has(u.hostname)) return real(`${t.origin}/${u.hostname}${u.pathname}${u.search}`, init);
  return real(input, init);
};
