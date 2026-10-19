// Hosted (cloud) runners and the team provider credentials they use
// (docs/CLOUD-RUNNER-RUNBOOK.md, migration 067).
//
// A hosted runner is an enrolment (`hosted = 1`) an admin creates from the
// desktop app for a server they run (the team's Pi). It belongs to that admin's
// membership, so "Run in the cloud" spends that admin's hosted runner and the
// team's stored provider credentials. Unlike a desktop enrolment it does not end
// when the install that created it signs out (enrolments.js problem()).
//
// Provider credentials are sealed with the hub's encryption key (vault.js) and
// leave the hub only inside the runner_provider_config RPC answer to a hosted
// runner's own socket, for that run's AI. No HTTP route returns them.

import { randomUUID } from 'node:crypto';
import { HubError } from './db.js';
import { sha256hex } from './auth.js';
import { can } from './permissions.js';
import { limitOrThrow } from './ratelimit.js';
import { providerConfigAad } from './vault.js';
import { newRunnerToken, MAX_PER_USER_TEAM } from './identity/enrolments.js';
import { ipPrefix } from './identity/accounts.js';
import { AI_LABELS, runnerAis, readiness } from '../shared/ai.js';

export const HOSTED_PROVIDERS = Object.freeze(['claude', 'codex', 'hermes-dgx']);
const RECENT_RUNS = 5;
const KEY_MAX = 512;

const bad = (message) => new HubError('VALIDATION', message);

/** An optional plain string field: undefined = unchanged, null = clear. */
function optional(v, name, max, re = null) {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string') throw bad(`${name} must be a string or null`);
  const t = v.trim();
  if (!t || t.length > max || /[\p{C}\s]/u.test(t) || (re && !re.test(t))) throw bad(`${name} is not valid`);
  return t;
}

// Hermes resolves the host itself, so only a literal IP passes here; the runner
// also requires it to be loopback, LAN or tailnet (src/local-models.js addressAllowed).
function baseUrlOf(v) {
  const s = optional(v, 'base_url', 300);
  if (s == null) return s;
  let u;
  try { u = new URL(s); } catch { throw bad('base_url is not a URL'); }
  const literal = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(u.hostname) || /^\[[0-9a-f:.]+\]$/i.test(u.hostname);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !literal) {
    throw bad('base_url must be http(s)://<literal IP>[:port][/path] (a tailnet or LAN model server)');
  }
  return s;
}

export class HostedRunners {
  constructor(hub, { accounts, enrolments }) {
    this.hub = hub;
    this.db = hub.db;
    this.accounts = accounts;
    this.enrolments = enrolments;
  }

  requireAdmin(member) {
    if (!can(member, 'repo.manage')) throw new HubError('FORBIDDEN', 'only team admins can manage the cloud runner and its provider keys');
  }

  /**
   * POST /api/teams/:team_id/hosted-runners {name?} → {enrollment_id, team_id, runner_token}.
   * From the desktop app (its device token): the token is shown once, for the server's runner.env.
   */
  create(member, ident, body, { ip }) {
    this.requireAdmin(member);
    if (ident?.cred.kind !== 'device' || ident.cred.scope) throw new HubError('FORBIDDEN', 'create a cloud runner from the Plexiform app');
    let name = body.name;
    if (name != null && (typeof name !== 'string' || name.length > 100 || /[\p{C}]/u.test(name))) throw bad('name must be a string ≤ 100, no control characters');
    name = (name ?? '').trim() || 'Cloud runner';
    limitOrThrow(this.hub, 'runner_enrol_user', ident.user.id);
    const n = this.db.get('SELECT COUNT(*) AS n FROM runner_enrollments WHERE user_id = ? AND org_id = ? AND revoked_at IS NULL', ident.user.id, member.org_id).n;
    if (n >= MAX_PER_USER_TEAM) throw new HubError('QUOTA_EXCEEDED', `at most ${MAX_PER_USER_TEAM} runners per person in a team: remove one first`, { resource: 'runner_enrollments', limit: MAX_PER_USER_TEAM });
    const now = this.hub.iso();
    const token = newRunnerToken();
    const id = randomUUID();
    const deviceId = randomUUID();
    this.hub.txn(() => {
      this.db.insert('devices', { id: deviceId, member_id: member.id, name, kind: 'runner', token_hash: `enrolment:${randomUUID()}`, created_at: now });
      this.db.insert('runner_enrollments', {
        id, org_id: member.org_id, user_id: ident.user.id, user_device_id: ident.cred.id, member_id: member.id, device_id: deviceId, name,
        token_hash: sha256hex(token), session_epoch: this.accounts.epoch(), created_at: now, last_ip_prefix: ipPrefix(ip), hosted: 1,
      });
      this.accounts.audit('runner.enrol', { user: ident.user.id, org: member.org_id, target: id, detail: { device_id: deviceId, hosted: true }, ip });
    });
    return { enrollment_id: id, team_id: member.org_id, runner_token: token };
  }

  /**
   * GET /api/teams/:team_id/hosted-runners: the team's cloud runners, honest
   * about none or offline, plus the caller's recent cloud runs and their cost.
   */
  list(member) {
    const rows = this.db.all(`SELECT e.*, u.display_name FROM runner_enrollments e JOIN users u ON u.id = e.user_id
      WHERE e.org_id = ? AND e.hosted = 1 AND e.revoked_at IS NULL ORDER BY e.created_at, e.id`, member.org_id);
    const runners = rows.map((e) => this.view(e, member));
    return {
      runners,
      mine: runners.some((r) => r.mine),
      online: runners.some((r) => r.mine && r.online),
      recent_runs: this.recentRuns(member),
      providers: this.providerList(member).providers,
    };
  }

  view(e, member) {
    const conn = this.hub.runners.get(e.device_id);
    const online = conn?.enrollmentId === e.id && conn.ready === true;
    return {
      id: e.id, name: e.name, owner: { member_id: e.member_id, name: e.display_name }, mine: e.member_id === member.id,
      online, last_seen_at: e.last_seen_at,
      active_runs: online ? this.db.get('SELECT COUNT(*) AS n FROM runs WHERE device_id = ? AND ended_at IS NULL', e.device_id).n : 0,
      ai: online ? (conn.ai ?? runnerAis(undefined)).map((a) => ({ id: a.id, label: AI_LABELS[a.id] ?? a.label, available: [null, 'may_need_sign_in'].includes(readiness(a)), reason: readiness(a), budget: a.capabilities.budget })) : [],
    };
  }

  // Cost is what the runner reported; null where the provider reports none (Codex, Hermes).
  recentRuns(member) {
    return this.db.all(`SELECT r.id, r.ai, r.cost_cents, r.started_at, r.ended_at, r.end_reason, c.key FROM runs r
      JOIN runner_enrollments e ON e.device_id = r.device_id AND e.hosted = 1
      JOIN cards c ON c.id = r.card_id JOIN boards b ON b.id = c.board_id
      WHERE e.org_id = ? AND b.org_id = ? AND r.on_behalf_of = ? ORDER BY r.started_at DESC, r.id LIMIT ${RECENT_RUNS}`, member.org_id, member.org_id, member.id)
      .map((r) => ({ run_id: r.id, card_key: r.key, ai: r.ai ?? 'claude', cost_usd: r.ai == null || r.ai === 'claude' ? r.cost_cents / 100 : null,
        started_at: r.started_at, ended_at: r.ended_at, end_reason: r.end_reason }));
  }

  // The caller's own cloud runners for the Send to AI preview; serves_repo = it advertised this repo.
  previewFor(member, repoId) {
    const status = this.list(member);
    const mine = status.runners.filter((r) => r.mine).map((r) => {
      const e = this.db.get('SELECT device_id FROM runner_enrollments WHERE id = ?', r.id);
      return { ...r, serves_repo: r.online && !!repoId && this.hub.runners.get(e.device_id)?.repos.has(repoId) === true };
    });
    return { enrolled: mine.length > 0, online: mine.some((r) => r.online), runners: mine, recent_runs: status.recent_runs };
  }

  // ── provider credentials ─────────────────────────────────────────────────

  /** GET /api/teams/:team_id/provider-configs: which providers have a key; never the key. */
  providerList(member) {
    const rows = this.db.all('SELECT provider, base_url, model, key_id, updated_at FROM team_provider_configs WHERE org_id = ? ORDER BY provider', member.org_id);
    return { encryption: this.hub.vault.available, providers: rows.map((r) => ({ provider: r.provider, label: AI_LABELS[r.provider], has_key: r.key_id != null, base_url: r.base_url, model: r.model, updated_at: r.updated_at })) };
  }

  /** PUT /api/teams/:team_id/provider-configs/:provider {api_key?, base_url?, model?}: admins; null clears a field. */
  setProvider(member, provider, body, { ip }) {
    this.requireAdmin(member);
    if (!HOSTED_PROVIDERS.includes(provider)) throw new HubError('NOT_FOUND', 'unknown provider');
    const apiKey = optional(body.api_key, 'api_key', KEY_MAX);
    const baseUrl = provider === 'hermes-dgx' ? baseUrlOf(body.base_url) : body.base_url == null ? body.base_url : (() => { throw bad('base_url applies only to hermes-dgx'); })();
    const model = optional(body.model, 'model', 100, /^[A-Za-z0-9._:/@-]+$/);
    if (apiKey && !this.hub.vault.available) throw new HubError('POLICY_DENIED', 'storing provider keys needs an encryption key (BOARD_ENC_KEY) on this hub');
    const now = this.hub.iso();
    const old = this.db.get('SELECT * FROM team_provider_configs WHERE org_id = ? AND provider = ?', member.org_id, provider);
    const sealed = apiKey ? this.hub.vault.seal(providerConfigAad(member.org_id), provider, apiKey) : null;
    const next = {
      base_url: baseUrl === undefined ? old?.base_url ?? null : baseUrl,
      model: model === undefined ? old?.model ?? null : model,
      key_id: apiKey === undefined ? old?.key_id ?? null : sealed?.key_id ?? null,
      nonce: apiKey === undefined ? old?.nonce ?? null : sealed?.nonce ?? null,
      ciphertext: apiKey === undefined ? old?.ciphertext ?? null : sealed?.ciphertext ?? null,
    };
    if (provider === 'hermes-dgx' && !next.base_url) throw bad('hermes-dgx needs base_url (the model server on your tailnet)');
    this.hub.txn(() => {
      if (old) {
        this.db.run('UPDATE team_provider_configs SET base_url = ?, model = ?, key_id = ?, nonce = ?, ciphertext = ?, updated_by = ?, updated_at = ? WHERE org_id = ? AND provider = ?',
          next.base_url, next.model, next.key_id, next.nonce, next.ciphertext, member.id, now, member.org_id, provider);
      } else {
        this.db.insert('team_provider_configs', { org_id: member.org_id, provider, ...next, updated_by: member.id, created_at: now, updated_at: now });
      }
      this.accounts.audit('provider_config.set', { user: member.user_id, org: member.org_id, target: provider, detail: { key: apiKey === undefined ? 'unchanged' : apiKey ? 'set' : 'cleared' }, ip });
    });
    return this.providerList(member);
  }

  /** DELETE /api/teams/:team_id/provider-configs/:provider: admins. */
  removeProvider(member, provider, { ip }) {
    this.requireAdmin(member);
    if (!HOSTED_PROVIDERS.includes(provider)) throw new HubError('NOT_FOUND', 'unknown provider');
    this.hub.txn(() => {
      const r = this.db.run('DELETE FROM team_provider_configs WHERE org_id = ? AND provider = ?', member.org_id, provider);
      if (Number(r.changes) === 0) throw new HubError('NOT_FOUND', 'no stored configuration for this provider');
      this.accounts.audit('provider_config.remove', { user: member.user_id, org: member.org_id, target: provider, ip });
    });
    return this.providerList(member);
  }

  /**
   * The runner_provider_config RPC: the stored credential for this run's own AI,
   * to a hosted runner's own socket only (verifyRun already bound run, fence,
   * device and connection). → {provider, configured, api_key?, base_url?, model?}
   */
  credentialsFor(connection, run, row) {
    if (connection?.hosted !== true) throw new HubError('FORBIDDEN', 'provider credentials go only to a hosted runner');
    const orgId = this.hub.board(row.board_id)?.org_id;
    const provider = run.ai ?? 'claude';
    const r = orgId && this.db.get('SELECT * FROM team_provider_configs WHERE org_id = ? AND provider = ?', orgId, provider);
    if (!r) return { provider, configured: false };
    const apiKey = r.key_id ? this.hub.vault.open(providerConfigAad(orgId), provider, r) : null;
    return { provider, configured: true, ...(apiKey ? { api_key: apiKey } : {}), ...(r.base_url ? { base_url: r.base_url } : {}), ...(r.model ? { model: r.model } : {}) }; // privacy-flow: hosted-provider-credentials
  }
}
