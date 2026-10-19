// PKCE stays on the static phone origin; the hub only gets its hash until exchange.
const KEY = 'plexiform-phone-signin';
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function startBrowserSignIn({ api, storage, hubOrigin, pair = '', now = Date.now() }) {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const r = await api.request('POST', '/api/auth/phone/start', { challenge }, { auth: false });
  if (r.status !== 200 || !/^[A-Za-z0-9_-]{32}$/.test(r.body?.id) || !/^\d{6}$/.test(r.body?.code)) throw Error('Could not start browser sign-in. Try again.');
  const dest = new URL(r.body.url);
  if (dest.origin !== hubOrigin || dest.pathname !== '/phone-connect' || dest.hash !== `#${r.body.id}`) throw Error('Invalid sign-in address.');
  storage.setItem(KEY, JSON.stringify({ id: r.body.id, verifier, pair, expires: now + 300000 }));
  return { url: dest.href, code: r.body.code };
}
export async function finishBrowserSignIn({ id, api, storage, vault, now = Date.now() }) {
  let saved;
  try { saved = JSON.parse(storage.getItem(KEY)); } catch { /* missing */ }
  if (!saved || saved.id !== id || saved.expires < now || !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier)) throw Error('Start sign-in again in this browser.');
  const r = await api.request('POST', '/api/auth/phone/exchange', { id, verifier: saved.verifier }, { auth: false });
  if (r.status !== 200 || typeof r.body?.device_token !== 'string' || !/^bdt_[A-Za-z0-9_-]+$/.test(r.body.device_token)) throw Error('Phone sign-in did not finish. Start again.');
  try { await vault.save(r.body.device_token); }
  catch { api.setToken(r.body.device_token); await api.signOut().catch(() => {}); api.setToken(null); throw Error('This browser could not save the sign-in. Turn off private browsing and try again.'); }
  storage.removeItem(KEY);
  return saved.pair;
}
