// The client pane may save only a hub-held exact artifact, after a native
// Save dialog. Re-fetch after the dialog so withdrawn access cannot save.
'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const MAX_BYTES = 8 * 1024 * 1024;
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CONTENT = new RegExp(`^/api/client/items/(${ID})/artifacts/(${ID})/content$`);
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' };
function clientArtifactTarget(url, origin) {
  try { const u = new URL(url); const m = CONTENT.exec(u.pathname); return u.origin === origin && !u.username && !u.password && !u.search && !u.hash && m ? { url: u.href, metadata: `${origin}${u.pathname.slice(0, -8)}`, itemId: m[1], versionId: m[2] } : null; } catch { return null; }
}
function clientExportTarget(url, origin) {
  try { const u = new URL(url); return u.origin === origin && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/api/account/client-export' ? u.href : null; } catch { return null; }
}
async function saveClientExport({ url, origin, tokenFor, current, choose, fetchImpl = fetch, write = (file, data) => fs.writeFileSync(file, data, { mode: 0o600 }) }) {
  const target = clientExportTarget(url, origin), token = tokenFor(origin), active = () => current() && token && tokenFor(origin) === token;
  if (!target || !active()) return { ok: false };
  const choice = await choose({ title: 'Export my client data', defaultPath: 'plexiform-client-data.json', buttonLabel: 'Save export' });
  if (choice.canceled || !choice.filePath || !active()) return { ok: false };
  const response = await fetchImpl(target, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(20000) }); // privacy-flow: team-hub-account
  if (!response.ok || !active()) return { ok: false, signedOut: response.status === 401 };
  if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') return { ok: false };
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (!active() || size > 16 * 1024 * 1024) return { ok: false }; chunks.push(Buffer.from(chunk)); }
  const bytes = Buffer.concat(chunks), data = JSON.parse(bytes.toString('utf8'));
  if (!active() || !Array.isArray(data.workspaces) || !Array.isArray(data.projects) || !Array.isArray(data.access)) return { ok: false };
  write(choice.filePath, bytes); return { ok: true };
}
async function saveClientArtifact({ url, origin, tokenFor, current, choose, fetchImpl = fetch, write = (file, data) => fs.writeFileSync(file, data, { mode: 0o600 }) }) {
  const target = clientArtifactTarget(url, origin), token = tokenFor(origin);
  const active = () => current() && token && tokenFor(origin) === token;
  if (!target || !active()) return { ok: false };
  const get = (u) => fetchImpl(u, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(20000) }); // privacy-flow: team-hub-account
  const info = await get(target.metadata); if (!info.ok || !active()) return { ok: false, signedOut: info.status === 401 };
  const v = (await info.json()).artifact;
  if (!EXT[v?.mime] || v.id !== target.versionId || v.item_id !== target.itemId || !Number.isSafeInteger(v.version_number) || v.version_number < 1 || !Number.isSafeInteger(v.byte_length) || v.byte_length < 1 || v.byte_length > MAX_BYTES || !/^[a-f0-9]{64}$/.test(v.sha256)) return { ok: false };
  const choice = await choose({ title: 'Save shared deliverable', defaultPath: `deliverable-v${v.version_number}.${EXT[v.mime]}`, buttonLabel: 'Save deliverable' });
  if (choice.canceled || !choice.filePath || !active()) return { ok: false };
  const response = await get(target.url); if (!response.ok || !active()) return { ok: false, signedOut: response.status === 401 };
  if (response.headers.get('content-type')?.split(';')[0] !== v.mime || !response.headers.get('content-disposition')?.startsWith('attachment;')) return { ok: false };
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (!active() || size > MAX_BYTES || size > v.byte_length) return { ok: false };
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (!active() || size !== v.byte_length || createHash('sha256').update(bytes).digest('hex') !== v.sha256) return { ok: false };
  const final = await get(target.metadata); if (!final.ok || !active()) return { ok: false, signedOut: final.status === 401 };
  if ((await final.json()).artifact?.sha256 !== v.sha256 || !active()) return { ok: false };
  write(choice.filePath, bytes); return { ok: true };
}
module.exports = { clientArtifactTarget, clientExportTarget, saveClientArtifact, saveClientExport };
