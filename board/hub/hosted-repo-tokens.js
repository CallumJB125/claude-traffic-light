// GET /api/runner/v1/repo-token?repo_id= → {token, expires_at}
// (docs/CLOUD-RUNNER-RUNBOOK.md step 2, docs/GITHUB-APP-RUNBOOK.md).
//
// A hosted (cloud) runner has no git credentials of its own: it clones and
// pushes with a GitHub App installation token the hub mints for it here,
// narrowed by GitHub to that one repository and to contents + pull requests
// write. Only for:
//  - a hosted enrolment's own runner token (with Board-Team), like its socket;
//  - a repo of that enrolment's team, linked on one of the team's GitHub App
//    installation connections (integration_app_repos);
//  - while the runner holds work on that repo: a pending "Run in the cloud"
//    dispatch this runner is eligible for right now (its offer), or a run of
//    this runner on it that is live or ended within FINAL_PUSH_MS (the runner
//    pushes the run branch after the run reports its end). Never an idle runner.
// Everything out of that (another team's repo, an unknown repo, a desktop
// enrolment, no work) is the same 404. The token is returned once and never
// cached, logged, audited or stored by the hub; the audit row names who,
// which runner, which repo and when.

import { HubError } from './db.js';
import { bearer } from './auth.js';
import { isRunnerToken } from './identity/enrolments.js';
import { ipKey, limitOrThrow } from './ratelimit.js';
import { installationOf } from './integrations/github/index.js';

export const REPO_TOKEN_PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write' });
export const FINAL_PUSH_MS = 15 * 60_000;
const OFFER_SCAN = 20;
const REPO_ID = /^[A-Za-z0-9._:-]{1,100}$/;

const notFound = () => new HubError('NOT_FOUND', 'no repository token for this runner and repository');
const noInstallation = (message) => new HubError('NOT_FOUND', message, { reason: 'no_installation' });

export class HostedRepoTokens {
  constructor(hub, { app = null, integrations = null } = {}) {
    this.hub = hub;
    this.db = hub.db;
    this.app = app;
    this.integrations = integrations;
  }

  /** The route handler. Only HubErrors leave it: their text is fixed, never GitHub's answer or a token. */
  async mint(req, query, { ip = null } = {}) {
    const hub = this.hub;
    limitOrThrow(hub, 'runner_repo_token_ip', ipKey(ip));
    const token = bearer(req);
    // Not a runner credential at all (a person's sign-in): the route is not theirs to see.
    if (!isRunnerToken(token) || !hub.enrolments) throw new HubError('NOT_FOUND', 'no such route');
    const auth = hub.enrolments.authenticate(token, req.headers['board-team'], { ip });
    if (auth.close) throw new HubError('UNAUTHENTICATED', auth.reason);
    const e = this.db.get('SELECT * FROM runner_enrollments WHERE id = ?', auth.enrollmentId);
    if (e?.hosted !== 1) throw notFound();
    limitOrThrow(hub, 'runner_repo_token_runner', e.id);
    const repoId = query.get('repo_id');
    if (!REPO_ID.test(repoId ?? '')) throw notFound();
    const repo = hub.repo(repoId);
    if (!repo || repo.org_id !== e.org_id) throw notFound();
    const work = this.workFor(e, repoId);
    if (!work) throw notFound();
    // In the team, with work on it: an honest reason from here on.
    if (!this.app || !this.integrations) throw noInstallation('this hub has no GitHub App, so it cannot mint repository tokens');
    const link = this.integrations.appConnectionForRepo(e.org_id, 'github', repo.canonical_url);
    const c = link && this.db.get("SELECT external_id, settings FROM connections WHERE id = ? AND org_id = ? AND status = 'active'", link.connection_id, e.org_id);
    let settings = {};
    try { settings = JSON.parse(c?.settings ?? '{}'); } catch { settings = {}; }
    const installation = c ? installationOf({ external_id: c.external_id, settings }) : null;
    if (!installation) throw noInstallation('this repository is not linked to the team\'s GitHub App installation (Integrations → GitHub → Choose repositories)');
    let minted;
    try {
      minted = await this.app.repoToken(installation, { repositoryId: link.external_repo_id, permissions: REPO_TOKEN_PERMISSIONS });
    } catch (err) {
      const code = err?.code ?? 'provider_error';
      hub.log.warn('repo token not minted', { enrollment_id: e.id, repo_id: repoId, code });
      if (code === 'not_granted' || code === 'not_found') throw new HubError('POLICY_DENIED', 'the GitHub App installation does not grant contents and pull requests write on this repository: approve the app\'s permissions on GitHub, or add the repository to the installation', { reason: 'not_granted' });
      if (code === 'provider_unreachable') throw new HubError('PROVIDER_UNAVAILABLE', 'GitHub could not be reached; try again shortly');
      throw new HubError('PROVIDER_ERROR', 'GitHub did not mint a repository token; try again shortly');
    }
    hub.accounts.audit('runner.repo_token', {
      user: e.user_id, org: e.org_id, target: repoId, ip,
      detail: { enrollment_id: e.id, device_id: e.device_id, card_id: work.card_id, ...(work.run_id ? { run_id: work.run_id } : {}), installation_id: installation, expires_at: minted.expires_at },
    });
    hub.log.info('repo token minted', { enrollment_id: e.id, repo_id: repoId, card_id: work.card_id, expires_at: minted.expires_at });
    return { token: minted.token, expires_at: minted.expires_at };
  }

  /** The work that lets this hosted runner have a token for this repo: → {card_id, run_id} or null. */
  workFor(e, repoId) {
    const hub = this.hub;
    const since = new Date(hub.wallMs() - FINAL_PUSH_MS).toISOString();
    const run = this.db.get(`SELECT r.id, r.card_id FROM runs r JOIN cards c ON c.id = r.card_id JOIN boards b ON b.id = c.board_id
      WHERE r.device_id = ? AND r.repo_id = ? AND b.org_id = ? AND (r.ended_at IS NULL OR r.ended_at >= ?)
      ORDER BY r.ended_at IS NULL DESC, r.started_at DESC LIMIT 1`, e.device_id, repoId, e.org_id, since);
    if (run) return { card_id: run.card_id, run_id: run.id };
    // An offer is for the socket this enrolment has open now.
    if (hub.runners.get(e.device_id)?.enrollmentId !== e.id) return null;
    const cards = this.db.all(`SELECT c.id FROM cards c JOIN boards b ON b.id = c.board_id JOIN dispatches d ON d.card_id = c.id AND d.state = 'pending'
      WHERE b.org_id = ? AND c.repo_id = ? AND d.placement = 'hosted' AND c.run_state = 'queued' AND c.archived_at IS NULL
        AND COALESCE(d.target_member_id, d.dispatched_by) = ? ORDER BY d.created_at LIMIT ${OFFER_SCAN}`, e.org_id, repoId, e.member_id);
    for (const { id } of cards) {
      if (hub.offerFrame(id) && hub.eligibleDevices(id).some((conn) => conn.device_id === e.device_id)) return { card_id: id, run_id: null };
    }
    return null;
  }
}
