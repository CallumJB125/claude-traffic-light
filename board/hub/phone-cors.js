// Only the configured static phone origin; no cookies or credentialed CORS.
const PUBLIC = new Set(['GET /api/auth/methods', 'POST /api/auth/phone/start', 'POST /api/auth/phone/exchange', 'POST /api/auth/email/start', 'POST /api/auth/email/verify']);
export function phoneRoute(method, path, relayRoutes) {
  const key = `${method} ${path}`;
  return PUBLIC.has(key) || [...relayRoutes].some((r) => new RegExp(`^${r.replace(/:[a-z_]+/g, '[A-Za-z0-9_-]+')}$`).test(key));
}
export function phoneCors(req, res, config, pathname, relayRoutes) {
  const origin = req.headers.origin;
  if (!origin || origin === config.publicUrl || origin !== config.phoneOrigin) return false;
  const method = req.method === 'OPTIONS' ? req.headers['access-control-request-method'] : req.method;
  if (req.headers.cookie || !phoneRoute(method, pathname, relayRoutes)) return false;
  const headers = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean);
  if (headers.some((h) => !['authorization', 'content-type', 'accept'].includes(h))) return false;
  res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', method);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    res.setHeader('Access-Control-Max-Age', '300');
  }
  return true;
}
