// "Run my cards on this Mac": enrol this Mac as a runner device on a team hub
// and supervise the board runner under the app. Electron-free: index.js
// injects the hub fetch (the team partition's session), the vault
// (safeStorage) and the process fork, so tests drive it with fakes.
//
// Secrets (device token, Access service-token secret) live only in the
// safeStorage-encrypted file and reach the runner over parentPort, never
// argv or env (CONTRACT §4.2; 70's runner.config interface).
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS = 5;

/** "Callum's MacBook Air": what the team admin sees when making the token. */
function defaultDeviceName(userName, hostName) {
  const who = String(userName || 'My').trim();
  const mac = String(hostName || 'Mac').replace(/\.local$/i, '').replace(/[-_]+/g, ' ').trim() || 'Mac';
  return `${who}’s ${mac}`.slice(0, 100);
}

// Access service-token client ids look like `<32 hex>.access`.
const CLIENT_ID_RE = /^[a-f0-9]{32}\.access$/i;

function createDeviceController({ hub, credsFile, seal, unseal, fork, runnerEntry, dataDir, onStatus = () => {}, log = () => {}, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms) }) {
  // hub: {origin, fetch(path, init) → {status, json}} for the team partition.
  let creds = null;
  try { if (fs.existsSync(credsFile)) creds = JSON.parse(unseal(fs.readFileSync(credsFile))); } catch (e) { log('device creds unreadable; treat as not enrolled', e.message); creds = null; }
  if (creds && creds.hub !== hub.origin) creds = null;

  let child = null;
  let runner = { state: 'off', detail: null };
  let wanted = !!creds?.enabled;
  const restarts = [];

  const view = () => ({
    enrolled: !!creds,
    device_id: creds?.device_id ?? null,
    name: creds?.name ?? null,
    enabled: wanted,
    runner,
  });
  const emit = () => { try { onStatus(view()); } catch { /* UI gone */ } };

  function persist() {
    if (!creds) { fs.rmSync(credsFile, { force: true }); return; }
    const tmp = `${credsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, seal(JSON.stringify(creds)), { mode: 0o600 });
    fs.renameSync(tmp, credsFile);
  }

  function setRunner(state, detail = null) { runner = { state, detail }; emit(); }

  function start() {
    if (child || !creds || !wanted) return;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    const c = fork(runnerEntry, ['--parent-port'], { serviceName: 'Buddy Board Runner', stdio: 'pipe', env: { HOME: process.env.HOME, PATH: process.env.PATH, USER: process.env.USER, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR } });
    child = c;
    setRunner('starting');
    c.stderr?.on?.('data', (d) => log('runner', String(d).trimEnd()));
    c.on('message', (m) => {
      if (c !== child || !m || typeof m.type !== 'string') return;
      if (m.type === 'runner.ready') setRunner('connecting');
      else if (m.type === 'runner.status') setRunner(['connected', 'backoff', 'unauthenticated', 'revoked'].includes(m.state) ? m.state : 'unknown', typeof m.detail === 'string' ? m.detail.slice(0, 200) : null);
      else if (m.type === 'runner.fatal') setRunner('failed', String(m.message ?? 'runner failed').slice(0, 200));
    });
    c.once('exit', (code) => onExit(c, code));
    c.postMessage({
      type: 'runner.config', hub_url: hub.origin, device_id: creds.device_id, device_token: creds.device_token,
      cf_client_id: creds.cf_client_id, cf_client_secret: creds.cf_client_secret, data_dir: dataDir,
    });
  }

  function onExit(c, code) {
    if (c !== child) return;
    child = null;
    if (!wanted) { setRunner('off'); return; }
    if (runner.state === 'revoked' || runner.state === 'unauthenticated') return; // restarting won't help
    const t = now();
    while (restarts.length && t - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length >= MAX_RESTARTS) { setRunner('failed', `The runner keeps stopping (last exit code ${code}).`); return; }
    restarts.push(t);
    const delay = Math.min(30_000, 1000 * 2 ** (restarts.length - 1));
    setRunner('restarting', null);
    schedule(() => { if (wanted && !child) start(); }, delay);
  }

  function stop() {
    const c = child;
    if (!c) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { if (c.pid) process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } resolve(); }, 15_000);
      c.once('exit', () => { clearTimeout(t); resolve(); });
      // SIGTERM: the runner parks its runs per the handover rules first.
      try { c.kill(); } catch { clearTimeout(t); resolve(); }
    });
  }

  return {
    status: view,
    /**
     * Enrol with the Access service token the team admin made for this Mac.
     * The client id doubles as the device's cf_service_token_id (the hub
     * checks the service JWT's common_name against it).
     */
    async enroll({ name, cfClientId, cfClientSecret }) {
      if (creds) return { ok: false, error: 'This Mac is already set up for this team.' };
      const n = String(name ?? '').trim().slice(0, 100);
      if (!n) return { ok: false, error: 'Give this Mac a name.' };
      const id = String(cfClientId ?? '').trim();
      const secret = String(cfClientSecret ?? '').trim();
      if (!CLIENT_ID_RE.test(id)) return { ok: false, error: 'The Client ID looks like 32 letters and digits followed by “.access”.' };
      if (secret.length < 32) return { ok: false, error: 'Paste the whole Client Secret.' };
      let res;
      try {
        res = await hub.fetch('/api/devices', { method: 'POST', body: { request_id: crypto.randomUUID(), name: n, cf_service_token_id: id } });
      } catch (e) {
        return { ok: false, error: `Couldn’t reach the team hub (${e.message}).` };
      }
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'Sign in to the team board first, then try again.' };
      if (res.status !== 200 || !res.json?.device_id || !res.json?.device_token) return { ok: false, error: res.json?.error?.message ?? `The hub said no (${res.status}).` };
      creds = { hub: hub.origin, device_id: res.json.device_id, device_token: res.json.device_token, name: n, cf_client_id: id, cf_client_secret: secret, enabled: true };
      wanted = true;
      persist();
      emit();
      start();
      return { ok: true };
    },
    async setEnabled(on) {
      if (!creds) return { ok: false, error: 'Set this Mac up first.' };
      wanted = !!on;
      creds.enabled = wanted;
      persist();
      if (wanted) { restarts.length = 0; start(); } else await stop();
      emit();
      return { ok: true };
    },
    /** Stop, revoke on the hub (best effort) and forget every secret. */
    async remove() {
      wanted = false;
      await stop();
      const id = creds?.device_id;
      creds = null;
      persist();
      if (id) { try { await hub.fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE', body: { request_id: crypto.randomUUID() } }); } catch { /* already gone or offline */ } }
      setRunner('off');
      return { ok: true };
    },
    /** App start: resume the runner if the member left it on. */
    resume() { if (creds && wanted) start(); },
    stop: () => { wanted = false; return stop(); },
  };
}

module.exports = { createDeviceController, defaultDeviceName, CLIENT_ID_RE };
