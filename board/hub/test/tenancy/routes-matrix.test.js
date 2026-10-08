// T-ROUTES (ACCOUNTS-DESIGN.md §7.3, CONTRACT D63): every HTTP route of an
// accounts-mode hub, called by a user of team A (and by a user in no team)
// with team B's ids, answers 404 with none of B's data, and leaves B's rows
// untouched. The route table is read from the hub itself: a route missing
// from MATRIX below fails the coverage test, so a new route can't skip it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { canonical } from '../../../shared/workflow-execution.js';
import { tenancy, MARK } from './fixture.js';
import { sign } from '../../integrations/fake/index.js';
import { validatePayload } from '../../../shared/setups.js';

// kind:
//   cross    – names B's resources in the path; expect 404
//   team     – no resource in the path; sent with X-Board-Team: <B>; expect 404
//   self     – acts only on the caller's own account (no foreign id possible)
//   public   – no auth (health, sign-in, invite preview): proven in their own tests;
//              `reason` says why no sign-in is needed
//   (a cross entry may name another expected `status` when 404 isn't the generic answer)
//   (bare: true – body is sent as given, without the harness's request_id, for strictBody routes that reject it)
//   create   – makes a new team for the caller (teams.test.js)
// For cross routes `path(fx)` fills B's ids; `alt` adds calls that mix A's
// team with B's sub-resource ids (also 404); `headers(fx)` names team B where
// the path's id is not a tenant resource (an integration provider).
const MATRIX = {
  'GET /.well-known/oauth-protected-resource': { kind: 'public', reason: 'fixed public resource metadata; remote-http.test.js' },
  'GET /.well-known/oauth-protected-resource/api/mcp': { kind: 'public', reason: 'fixed public resource metadata; remote-http.test.js' },
  'GET /.well-known/oauth-authorization-server': { kind: 'public', reason: 'fixed public authorization metadata; remote-http.test.js' },
  'GET /oauth/authorize': { kind: 'public', reason: 'bounded registered public client intent; never issues a grant' },
  'POST /oauth/register': { kind: 'public', reason: 'bounded public DCR; never issues a grant' },
  'POST /oauth/token': { kind: 'public', reason: 'one-use PKCE code or rotating family is the credential; remote-http.test.js' },
  'POST /oauth/revoke': { kind: 'public', reason: 'client-bound token revocation; remote-http.test.js' },
  'GET /oauth/consent': { kind: 'public', reason: 'browser-bound preview; dedicated SESSION binding tests' },
  'POST /oauth/consent': { kind: 'public', reason: 'dedicated current SESSION, CSRF and bound-browser consent tests; ordinary bearer refused' },
  'POST /api/mcp': { kind: 'public', reason: 'distinct audience-bound bearer plus selected-board/current authority; remote-http.test.js' },
  'GET /api/mcp': { kind: 'public', reason: 'authenticated stateless405; dedicated tests' },
  'DELETE /api/mcp': { kind: 'public', reason: 'authenticated stateless405; dedicated tests' },
  'GET /api/integration/v1': {kind:'public',reason:'distinct personal integration bearer audience; remote-integration.test.js'},
  'POST /api/integration/v1': {kind:'public',reason:'closed ordinary actions, selected boards/current authority/durable receipts; remote-integration.test.js'},
  'GET /api/teams/:team_id/remote-grants': { kind: 'cross', path: f => `/api/teams/${f.B.team}/remote-grants` },
  'POST /api/teams/:team_id/remote-grants/gesture': { kind: 'cross', path: f => `/api/teams/${f.B.team}/remote-grants/gesture`, body: { purpose: 'create' } },
  'POST /api/teams/:team_id/remote-grants': { kind: 'cross', path: f => `/api/teams/${f.B.team}/remote-grants`, body: f => ({ gesture_id: randomUUID(), name: 'pwned', board_ids: [f.B.board], mode: 'read', expires_days: 1 }) },
  'DELETE /api/teams/:team_id/remote-grants/:grant_id': { kind: 'cross', path: f => `/api/teams/${f.B.team}/remote-grants/${randomUUID()}`, body: { gesture_id: randomUUID() } },
  'GET /api/health': { kind: 'public', reason: 'liveness probe; no team data' },
  'GET /api/auth/methods': { kind: 'public', reason: 'the sign-in page asks before anyone is signed in' },
  'POST /api/auth/email/start': { kind: 'public', reason: 'starts a sign-in' },
  'POST /api/auth/email/verify': { kind: 'public', reason: 'finishes a sign-in' },
  'POST /api/auth/oauth/start': { kind: 'public', reason: 'starts a Google/GitHub sign-in (a step-up needs the caller\'s own Bearer; oauth.test.js)' },
  'POST /api/auth/oauth/exchange': { kind: 'public', reason: 'finishes a Google/GitHub sign-in; the flow, state and PKCE verifier are the credential (oauth.test.js)' },
  'POST /api/auth/oauth/web/start': { kind: 'public', reason: 'explicit browser sign-in; strict-origin and bound cookie tests in oauth-web.test.js' },
  'GET /api/auth/oauth/web/google/callback': { kind: 'public', reason: 'fixed Google callback requires authenticated browser cookie/state/PKCE; no tenant selector' },
  'GET /api/auth/oauth/web/github/callback': { kind: 'public', reason: 'fixed GitHub callback requires authenticated browser cookie/state/PKCE; no tenant selector' },
  'POST /api/auth/oauth/web/result': { kind: 'public', reason: 'browser-bound result; success exact live self session plus CSRF, failures no account credential' },
  'POST /api/auth/signout': { kind: 'self' },
  'PUT /api/interaction/v1/role': { kind: 'self' },
  'GET /api/interaction/v1/hosts': { kind: 'self' },
  'POST /api/interaction/v1/hosts/:host_id/call': { kind: 'cross', path: f => `/api/interaction/v1/hosts/${f.users.ub.device_id}/call`, body: { op: 'list', args: {} } },
  'GET /api/interaction/v1/shares': { kind: 'self' },
  // Only a host-role device creates shares (403 for every other caller); naming a foreign team is 404 (interaction-shares.test.js).
  'POST /api/interaction/v1/shares': { kind: 'cross', status: 403, path: () => '/api/interaction/v1/shares', body: f => ({ session: randomUUID(), team: f.B.team, scope: 'interact' }) },
  'DELETE /api/interaction/v1/shares/:share_id': { kind: 'cross', path: f => `/api/interaction/v1/shares/${f.B.share}` },
  'DELETE /api/teams/:team_id/interaction-shares/:share_id': { kind: 'cross', path: f => `/api/teams/${f.B.team}/interaction-shares/${f.B.share}` },
  'GET /api/interaction/v1/shared': { kind: 'self' },
  // Phone approvals (W2-B): a foreign computer is "not available"; ping and push are the caller's own.
  'POST /api/approvals/v1/hosts/:host_id/call': { kind: 'cross', path: f => `/api/approvals/v1/hosts/${f.users.ub.device_id}/call`, body: { op: 'pair.poll', args: { pid: 'x' } } },
  'POST /api/approvals/v1/ping': { kind: 'self' },
  'GET /api/push/v1/key': { kind: 'self' },
  'PUT /api/push/v1/subscription': { kind: 'self' },
  'DELETE /api/push/v1/subscription': { kind: 'self' },
  'POST /api/interaction/v1/shared/:share_id/call': { kind: 'cross', path: f => `/api/interaction/v1/shared/${f.B.share}/call`, body: f => ({ op: 'state', args: { session: f.B.shareSession } }) },
  // Messaging (MESSAGING.md): a message is visible only to its sender and recipient; B's message ids, targets and team are unknown to A.
  'GET /api/messaging/v1/targets': { kind: 'self' },
  'POST /api/messaging/v1/messages': { kind: 'cross', path: () => '/api/messaging/v1/messages', body: f => ({ to: { user_id: f.users.ub.id, org_id: f.B.team }, body: MARK, card_id: f.B.card }),
    also: f => [{ to: { target: f.B.msgTarget }, body: MARK }, { to: { user_id: f.users.s.id, org_id: f.B.team }, body: MARK, reply_to: f.B.message }] },
  'GET /api/messaging/v1/messages': { kind: 'self' },
  // B's real message (S ← B owner, in team B) and B's real session target, seeded in sweep().
  'GET /api/messaging/v1/messages/:id': { kind: 'cross', path: f => `/api/messaging/v1/messages/${f.B.message}`, alt: () => [`/api/messaging/v1/messages/${randomUUID()}`] },
  'POST /api/messaging/v1/messages/:id/receipt': { kind: 'cross', path: f => `/api/messaging/v1/messages/${f.B.message}/receipt`, bare: true, body: { state: 'delivered' } },
  'POST /api/messaging/v1/messages/:id/handoff': { kind: 'cross', path: f => `/api/messaging/v1/messages/${f.B.handoff}/handoff`, bare: true, body: { decision: 'accept' } },
  // Host routes need a host-role device: the sweep's callers are not hosts, so 403 (messaging tests cover host success and cross-user 404).
  'PUT /api/messaging/v1/host/targets': { kind: 'cross', status: 403, path: () => '/api/messaging/v1/host/targets', body: { targets: [] } },
  'POST /api/messaging/v1/host/pull': { kind: 'cross', status: 403, path: () => '/api/messaging/v1/host/pull', body: {} },
  'POST /api/messaging/v1/host/messages/:id/report': { kind: 'cross', status: 403, path: () => `/api/messaging/v1/host/messages/${randomUUID()}/report`, body: { state: 'delivered' } },
  'POST /api/messaging/v1/host/send': { kind: 'cross', status: 403, path: f => '/api/messaging/v1/host/send', body: f => ({ from: { session: randomUUID(), generation: 1 }, to: { user_id: f.users.ub.id, org_id: f.B.team }, body: MARK }) },
  // Team activity (activity/): a foreign repo is rejected per record (200, nothing stored); reads naming it are 404.
  'POST /api/activity/v1/events': { kind: 'cross', status: 200, bare: true, path: () => '/api/activity/v1/events', body: (fx) => { const install = randomUUID(); const at = fx.h.hub.iso();
    return { install_id: install, records: [{ v: 1, record_id: `${install}:claude:s1`, adapter: 'claude', session_id: 's1', install_id: install, repo_id: fx.B.repo, title: 'x', status: 'working', started_at: at, updated_at: at, rev: 1 }] }; } },
  'GET /api/activity/v1/feed': { kind: 'cross', path: (fx) => `/api/activity/v1/feed?repo_id=${fx.B.repo}` },
  'GET /api/activity/v1/current': { kind: 'cross', path: (fx) => `/api/activity/v1/current?repo_id=${fx.B.repo}` },
  'POST /api/teams/:team_id/activity/v1/records/:record_id/handoff': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/activity/v1/records/${encodeURIComponent('x:claude:y')}/handoff`, body: {} },
  'POST /api/teams/:team_id/activity/v1/records/:record_id/continue': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/activity/v1/records/${encodeURIComponent('x:claude:y')}/continue`, body: {} },
  'GET /api/cards/:card_id/continue-seed': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/continue-seed?record_id=${encodeURIComponent('x:claude:y')}` },
  'GET /api/activity/v1/stream': { kind: 'cross', path: (fx) => `/api/activity/v1/stream?repo_id=${fx.B.repo}` },
  'GET /api/account': { kind: 'self' },
  'GET /api/work-capture/routes': { kind: 'self' },
  'GET /api/my-day': { kind: 'self' },
  'GET /api/teams/:team_id/setups': {kind:'cross',path:fx=>`/api/teams/${fx.B.team}/setups`},
  'POST /api/teams/:team_id/setups': {kind:'cross',path:fx=>`/api/teams/${fx.B.team}/setups`},
  'PUT /api/teams/:team_id/setup-baseline': {kind:'cross',path:fx=>`/api/teams/${fx.B.team}/setup-baseline`},
  'GET /api/setup-profiles/:profile_id': {kind:'cross',path:fx=>`/api/setup-profiles/${fx.B.setupProfile}`},
  'GET /api/setup-profiles/:profile_id/versions/:version_id': {kind:'cross',path:fx=>`/api/setup-profiles/${fx.B.setupProfile}/versions/${fx.B.setupVersion}`},
  'GET /api/setup-profiles/:profile_id/export': {kind:'cross',path:fx=>`/api/setup-profiles/${fx.B.setupProfile}/export`},
  'DELETE /api/setup-profiles/:profile_id': {kind:'cross',path:fx=>`/api/setup-profiles/${fx.B.setupProfile}`},
  'GET /api/setup-profiles/:profile_id/activity': {kind:'cross',path:fx=>`/api/setup-profiles/${fx.B.setupProfile}/activity`},
  'POST /api/setup-profiles/:profile_id/borrow-receipts': {kind:'cross',path:fx=>`/api/setup-profiles/${fx.B.setupProfile}/borrow-receipts`},
  'POST /api/account/setup': { kind: 'self' },
  'DELETE /api/account': { kind: 'self' },
  'GET /api/account/devices': { kind: 'self' },
  'DELETE /api/account/devices/:id': { kind: 'cross', path: (fx) => `/api/account/devices/${fx.users.ub.device_id}` },
  'PATCH /api/cards/:card_id/planning': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/planning`, body: (fx) => ({ request_id: randomUUID(), version: fx.h.hub.card(fx.B.card).version, due_date: '2026-10-02' }) },
  'GET /api/me': { kind: 'team' },
  'POST /api/teams': { kind: 'create' },
  'POST /api/client-workspaces': { kind: 'create' },
  'GET /api/teams/:team_id/client-workspace': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/client-workspace` },
  'POST /api/teams/:team_id/client-invites': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/client-invites`, body: (fx) => ({ email: 'pwned@none.test', grants: [{ project_id: fx.B.clientProject, scopes: ['status.read'] }] }) },
  'POST /api/teams/:team_id/client-invites/:invite_id/resend': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/client-invites/${fx.B.clientInvite}/resend` },
  'DELETE /api/teams/:team_id/client-invites/:invite_id': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/client-invites/${fx.B.clientInvite}` },
  'PATCH /api/teams/:team_id/client-guests/:guest_id': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/client-guests/${fx.B.clientGuest}`, body: (fx) => ({ grants: [{ project_id: fx.B.clientProject, scopes: ['status.read'] }] }) },
  'DELETE /api/teams/:team_id/client-guests/:guest_id': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/client-guests/${fx.B.clientGuest}` },
  'POST /api/boards/:board_id/client-project': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/client-project` },
  'POST /api/boards/:board_id/client-items': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/client-items`, body: (fx) => ({ card_id: fx.B.card, title: 'Pwned', status: 'done' }) },
  'DELETE /api/client-items/:item_id': { kind: 'cross', path: (fx) => `/api/client-items/${fx.B.clientItem}` },
  'POST /api/client-invites/preview': { kind: 'public', reason: 'email-bound client invitation preview; fixed names/scopes/expiry only, own adversarial tests' },
  'POST /api/client-invites/accept': { kind: 'self' },
  'GET /api/client/workspaces': { kind: 'self' },
  'GET /api/client/workspaces/:workspace_id/projects': { kind: 'cross', path: (fx) => `/api/client/workspaces/${fx.B.team}/projects` },
  'GET /api/client/projects/:project_id': { kind: 'cross', path: (fx) => `/api/client/projects/${fx.B.clientProject}` },
  'GET /api/account/client-export': { kind: 'self' },
  'POST /api/client-items/:item_id/artifacts': { kind: 'cross', path: (fx) => `/api/client-items/${fx.B.clientItem}/artifacts`, body: { request_id: 'foreign-upload', name: 'pwned.txt', mime: 'text/plain', data_base64: 'aGk=' } },
  'POST /api/client-items/:item_id/approvals': { kind: 'cross', path: (fx) => `/api/client-items/${fx.B.clientItem}/approvals`, body: (fx) => ({ artifact_version_id: fx.B.clientArtifact, guest_ids: [fx.B.clientGuest] }) },
  'DELETE /api/client-approval-requests/:approval_id': { kind: 'cross', path: (fx) => `/api/client-approval-requests/${fx.B.clientApproval}` },
  'GET /api/client/items/:item_id/artifacts': { kind: 'cross', path: (fx) => `/api/client/items/${fx.B.clientItem}/artifacts` },
  'GET /api/client/items/:item_id/artifacts/:version_id': { kind: 'cross', path: (fx) => `/api/client/items/${fx.B.clientItem}/artifacts/${fx.B.clientArtifact}` },
  'GET /api/client/items/:item_id/artifacts/:version_id/content': { kind: 'cross', path: (fx) => `/api/client/items/${fx.B.clientItem}/artifacts/${fx.B.clientArtifact}/content` },
  'GET /api/client/approvals/:approval_id': { kind: 'cross', path: (fx) => `/api/client/approvals/${fx.B.clientApproval}` },
  'POST /api/client/approvals/:approval_id/decision': { kind: 'cross', path: (fx) => `/api/client/approvals/${fx.B.clientApproval}/decision`, body: (fx) => ({ decision: 'approve', artifact_version_id: fx.B.clientArtifact, sha256: 'a'.repeat(64) }) },
  'GET /api/boards/:board_id/client-feedback-intake': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/client-feedback-intake` },
  'PATCH /api/boards/:board_id/client-feedback-intake': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/client-feedback-intake`, body: { enabled: true } },
  'GET /api/client/items/:item_id/feedback': { kind: 'cross', path: (fx) => `/api/client/items/${fx.B.clientItem}/feedback` },
  'POST /api/client/items/:item_id/feedback': { kind: 'cross', path: (fx) => `/api/client/items/${fx.B.clientItem}/feedback`, body: { request_id: 'pwned-feedback', message: 'Pwned' } },
  'GET /api/teams/:team_id': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}` },
  'PATCH /api/teams/:team_id': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}`, body: { name: 'pwned' } },
  'DELETE /api/teams/:team_id': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}`, body: { confirm_slug: 'x' } },
  'POST /api/teams/:team_id/boards': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/boards`, body: { name: 'pwned' } },
  'GET /api/teams/:team_id/boards': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/boards`, alt: (fx) => [`/api/teams/${fx.B.team}/boards?include_archived=1`] },
  'GET /api/teams/:team_id/members': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/members` },
  'PATCH /api/teams/:team_id/members/:member_id': {
    kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/members/${fx.B.s}`, body: { role: 'admin' },
    alt: (fx) => [`/api/teams/${fx.A.team}/members/${fx.B.owner}`],
  },
  'DELETE /api/teams/:team_id/members/:member_id': {
    kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/members/${fx.B.s}`,
    alt: (fx) => [`/api/teams/${fx.A.team}/members/${fx.B.owner}`],
  },
  'GET /api/teams/:team_id/invites': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/invites` },
  'POST /api/teams/:team_id/invites': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/invites`, body: { email: 'x@pwned.test', role: 'member' } },
  'DELETE /api/teams/:team_id/invites/:invite_id': {
    kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/invites/${fx.B.invite}`,
    alt: (fx) => [`/api/teams/${fx.A.team}/invites/${fx.B.invite}`],
  },
  'POST /api/teams/:team_id/invites/:invite_id/resend': {
    kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/invites/${fx.B.invite}/resend`,
    alt: (fx) => [`/api/teams/${fx.A.team}/invites/${fx.B.invite}/resend`],
  },
  'POST /api/invites/preview': { kind: 'public', reason: 'the invite token is the credential (invites.test.js)' },
  // Token / own-address acceptance: invites.test.js proves the email binding.
  'POST /api/invites/accept': { kind: 'self' },
  // An invite addressed to someone else is as unknown as a made-up id: the one
  // generic INVALID_TOKEN (not 404), and nothing about it in the answer.
  'POST /api/account/invites/:invite_id/accept': { kind: 'cross', status: 400, path: (fx) => `/api/account/invites/${fx.B.invite}/accept` },
  // Runner enrolment (P4, D79–D81): an install as a runner in the team in the URL.
  'POST /api/teams/:team_id/enrol': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/enrol` },
  'DELETE /api/teams/:team_id/enrol': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/enrol` },
  'GET /api/billing': { kind: 'self' },
  'POST /api/billing/checkout': { kind: 'self' },
  'POST /api/billing/portal': { kind: 'self' },
  'GET /api/entitlement': { kind: 'self' },
  // Encrypted sync (sync.js): the caller's own devices and blobs only; sync.test.js covers another user's ids with a store set up.
  'GET /api/sync/state': { kind: 'self' },
  'POST /api/sync/devices': { kind: 'self' },
  'POST /api/sync/init': { kind: 'self' },
  'PUT /api/sync/wraps': { kind: 'self' },
  'POST /api/sync/devices/:device_id/revoke': { kind: 'cross', path: (fx) => `/api/sync/devices/${fx.users.ub.device_id}/revoke` },
  'POST /api/sync/uploads': { kind: 'self' },
  'PUT /api/sync/blobs': { kind: 'self' },
  'GET /api/sync/blobs': { kind: 'self' },
  'GET /api/sync/blobs/:blob_id': { kind: 'cross', path: () => '/api/sync/blobs/1' },
  'PUT /api/sync/cursor': { kind: 'self' },
  'GET /api/teams/:team_id/billing': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/billing` },
  'POST /api/teams/:team_id/billing/checkout': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/billing/checkout`, body: { seats: 5, interval: 'month' } },
  'POST /api/teams/:team_id/billing/portal': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/billing/portal` },
  'GET /api/teams/:team_id/enrolments': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/enrolments` },
  'DELETE /api/teams/:team_id/enrolments/:enrollment_id': {
    kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/enrolments/${fx.B.enrollment}`,
    alt: (fx) => [`/api/teams/${fx.A.team}/enrolments/${fx.B.enrollment}`],
  },
  'GET /api/boards/:board_id': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}`, alt: (fx) => [`/api/boards/${fx.B.board}?include_archived=1`] },
  'GET /api/boards': { kind: 'team' },
  'GET /api/search': { kind: 'cross', path: (fx) => `/api/search?q=secret&board_id=${fx.B.board}`, alt: (fx) => [`/api/search?q=secret&team=${fx.B.team}`] },
  'GET /api/workflows': { kind: 'team' },
  'GET /api/team-overview': { kind: 'team' },
  // Staff-only directory selects a team by header/query; both selectors must
  // be swept for foreign callers, even when no eligible run is currently live.
  'GET /api/team-session-directory': { kind: 'team' },
  'POST /api/workflows': { kind: 'team', body: { definition: { name: 'pwned', steps: [{ title: 'pwned', plan_approval: true }] } } },
  'GET /api/workflows/:workflow_id': { kind: 'cross', path: (fx) => `/api/workflows/${fx.B.workflow}` },
  'POST /api/workflows/:workflow_id/versions': { kind: 'cross', path: (fx) => `/api/workflows/${fx.B.workflow}/versions`, body: { expected_version: 1, definition: { name: 'pwned', steps: [{ title: 'pwned', plan_approval: true }] } } },
  'POST /api/workflows/:workflow_id/archive': { kind: 'cross', path: (fx) => `/api/workflows/${fx.B.workflow}/archive`, body: { archived: true } },
  'POST /api/boards/:board_id/workflows/:workflow_id/apply': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/workflows/${fx.B.workflow}/apply`, alt: (fx) => [`/api/boards/${fx.A.board}/workflows/${fx.B.workflow}/apply`], body: (fx) => ({ version: 1, content_hash: fx.B.workflowHash }) },
  'POST /api/workflow-instances/:instance_id/preview': {kind:'cross',path:fx=>`/api/workflow-instances/${fx.B.workflowInstance}/preview`,body:fx=>fx.B.workflowPreview},
  'GET /api/workflow-instances/:instance_id/execution-context': {kind:'cross',path:fx=>`/api/workflow-instances/${fx.B.workflowInstance}/execution-context`},
  'GET /api/workflow-plans/:plan_id': {kind:'cross',path:fx=>`/api/workflow-plans/${fx.B.workflowPlan}`},
  'POST /api/workflow-plans/:plan_id/execution-preview': {kind:'cross',path:fx=>`/api/workflow-plans/${fx.B.workflowPlan}/execution-preview`,body:fx=>fx.B.executionPreviewInput},
  'POST /api/workflow-executions/:execution_id/preview': {kind:'cross',path:fx=>`/api/workflow-executions/${fx.B.execution}/preview`,body:fx=>({...fx.B.executionPreviewInput,source_plan_id:fx.B.workflowPlan,purpose:'resume',expected_revision:0})},
  'GET /api/workflow-execution-previews/:execution_preview_id': {kind:'cross',path:fx=>`/api/workflow-execution-previews/${fx.B.executionPreview}`},
  'POST /api/workflow-plans/:plan_id/start': {kind:'cross',path:fx=>`/api/workflow-plans/${fx.B.workflowPlan}/start`,body:fx=>fx.B.workflowStart},
  'GET /api/workflow-executions/:execution_id': {kind:'cross',path:fx=>`/api/workflow-executions/${fx.B.execution}`},
  'POST /api/workflow-executions/:execution_id/resume': {kind:'cross',path:fx=>`/api/workflow-executions/${fx.B.execution}/resume`,body:fx=>fx.B.workflowResume},
  'POST /api/workflow-executions/:execution_id/pause': {kind:'cross',path:fx=>`/api/workflow-executions/${fx.B.execution}/pause`,body:{expected_revision:0}},
  'POST /api/workflow-executions/:execution_id/cancel': {kind:'cross',path:fx=>`/api/workflow-executions/${fx.B.execution}/cancel`,body:{expected_revision:0}},
  'POST /api/workflow-executions/:execution_id/steps/:position/retry': {kind:'cross',path:fx=>`/api/workflow-executions/${fx.B.execution}/steps/0/retry`,body:fx=>({...fx.B.workflowResume,previous_attempt_id:randomUUID()})},
  'POST /api/boards': { kind: 'team', body: { name: 'pwned' } },
  'PATCH /api/boards/:board_id': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}`, body: { name: 'pwned' } },
  'POST /api/boards/:board_id/archive': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/archive` },
  'POST /api/boards/:board_id/restore': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/restore` },
  'GET /api/boards/:board_id/alerts': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/alerts` },
  'GET /api/boards/:board_id/journal': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/journal` },
  'GET /api/boards/:board_id/runs': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/runs` },
  'GET /api/boards/:board_id/presence': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/presence` },
  'POST /api/boards/:board_id/cards': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/cards`, body: { title: 'pwned' } },
  'POST /api/boards/:board_id/work-capture': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/work-capture`, body: (fx) => ({ install_id: randomUUID(), provider: 'codex', session_id: 'foreign-session', repo_id: fx.B.repo, title: 'Foreign capture', status: 'working' }) },
  // Label registry and archive (D91, D94): B's board, label name and card, also named from A's board.
  'GET /api/boards/:board_id/labels': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/labels` },
  'POST /api/boards/:board_id/labels': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/labels`, body: { name: 'pwned', color: 'red' } },
  'PATCH /api/boards/:board_id/labels/:name': {
    kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/labels/${encodeURIComponent(fx.B.label)}`, body: { name: 'pwned', color: 'blue' },
    alt: (fx) => [`/api/boards/${fx.A.board}/labels/${encodeURIComponent(fx.B.label)}`],
  },
  'DELETE /api/boards/:board_id/labels/:name': {
    kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/labels/${encodeURIComponent(fx.B.label)}?strip=1`, body: { strip: true },
    alt: (fx) => [`/api/boards/${fx.A.board}/labels/${encodeURIComponent(fx.B.label)}?strip=1`],
  },
  'POST /api/cards/:card_id/archive': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/archive` },
  'POST /api/cards/:card_id/restore': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/restore` },
  'POST /api/boards/:board_id/repos': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/repos`, body: (fx) => ({ repo_id: fx.B.repo }) },
  'GET /api/cards/:card_id': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}` },
  'POST /api/cards/:card_id/work-capture/stop': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/work-capture/stop`, body: {} },
  'PATCH /api/cards/:card_id': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}`, body: { title: 'pwned', version: 0 } },
  'POST /api/cards/:card_id/actions/:action': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/actions/stop`, body: {} },
  'POST /api/cards/:card_id/handover/salvage': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/handover/salvage`, body: { text: 'pwned' } },
  'POST /api/cards/:card_id/comments': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/comments`, body: { body: 'pwned' } },
  'GET /api/cards/:card_id/messages': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/messages` },
  'GET /api/cards/:card_id/ownership': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/ownership` },
  'GET /api/boards/:board_id/work-context': {kind:'cross',path:fx=>`/api/boards/${fx.B.board}/work-context`},
  'POST /api/cards/:card_id/messages': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/messages`, body: { expected_fence: 0 } },
  'GET /api/cards/:card_id/packet': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/packet` },
  'POST /api/cards/:card_id/packet': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/packet`, body: { expected_fence: 0 } },
  'GET /api/cards/:card_id/handover': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/handover` },
  'GET /api/cards/:card_id/overlap-preview': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/overlap-preview` },
  'POST /api/permission-requests/:id/answer': { kind: 'cross', path: (fx) => `/api/permission-requests/${fx.B.permission}/answer`, body: { decision: 'allow' } },
  'GET /api/devices': { kind: 'team' },
  'DELETE /api/devices/:id': { kind: 'cross', path: (fx) => `/api/devices/${fx.B.device}` },
  'GET /api/repos': { kind: 'team' },
  'POST /api/repos': { kind: 'team', body: { url: 'git@github.com:pwned/app.git' } },
  // Integrations (D40–D42): connections belong to a team.
  'GET /api/integrations': { kind: 'team' },
  'POST /api/integrations/:provider/token': { kind: 'cross', path: () => '/api/integrations/fake/token', headers: (fx) => ({ 'x-board-team': fx.B.team }), body: { token: 'fake_pwned12345' } },
  'POST /api/integrations/:provider/start': { kind: 'cross', path: () => '/api/integrations/fake/start', headers: (fx) => ({ 'x-board-team': fx.B.team }) },
  // Pending connections (D97): a provider with B's team header, or B's pending id.
  'POST /api/integrations/:target/prepare': {
    kind: 'cross', path: () => '/api/integrations/fake/prepare', headers: (fx) => ({ 'x-board-team': fx.B.team }), body: { input: {} },
    alt: (fx) => [`/api/integrations/${fx.B.pending}/prepare`],
  },
  'POST /api/integrations/:id/authorize': { kind: 'cross', path: (fx) => `/api/integrations/${fx.B.pending}/authorize` },
  'PATCH /api/integrations/:id': { kind: 'cross', path: (fx) => `/api/integrations/${fx.B.connection}`, body: (fx) => ({ autonomy: {}, target_board_id: fx.B.board }), alt: (fx) => [`/api/integrations/${fx.B.pending}`] },
  'DELETE /api/integrations/:id': { kind: 'cross', path: (fx) => `/api/integrations/${fx.B.connection}`, alt: (fx) => [`/api/integrations/${fx.B.pending}`] },
  'GET /api/integrations/:id/audit': { kind: 'cross', path: (fx) => `/api/integrations/${fx.B.connection}/audit` },
  // Identity links (D98): B's connection (and B's member) from team A or no team.
  'POST /api/integrations/:id/identity/start': { kind: 'cross', path: (fx) => `/api/integrations/${fx.B.connection}/identity/start` },
  'GET /api/integrations/:id/identity': { kind: 'cross', path: (fx) => `/api/integrations/${fx.B.connection}/identity` },
  'DELETE /api/integrations/:id/identity': { kind: 'cross', path: (fx) => `/api/integrations/${fx.B.connection}/identity` },
  'GET /api/integrations/:id/identities': { kind: 'cross', path: (fx) => `/api/integrations/${fx.B.connection}/identities` },
  'DELETE /api/integrations/:id/identities/:member_id': {
    kind: 'cross', path: (fx) => `/api/integrations/${fx.B.connection}/identities/${fx.B.s}`,
    alt: (fx) => [`/api/integrations/${fx.B.pending}/identities/${fx.B.owner}`],
  },
};

// Not registered in accounts mode at all (a plain 404 "no such route"), with why.
const REFUSED = {
  'POST /api/devices': 'legacy runner device tokens: accounts mode mints runner credentials only by enrolment (D79, H1); GET/DELETE stay for cleanup',
};

// Handled before the route table (and before accounts auth): not in
// app.routes, so listed here with why they need no sign-in.
const PRE_ROUTE = {
  'POST /integrations/:id/webhook': 'the provider signs every delivery; the signature (the connection\'s own secret) is the auth',
  'POST /api/billing/webhook': 'the payment provider signs every delivery (HMAC over timestamp and body with the hub\'s webhook secret); billing.test.js',
  'GET /integrations/:provider/callback': 'the provider redirects here; the signed OAuth state plus the bind cookie are the auth',
  'GET /integrations/:provider/identity/callback': 'the provider redirects a linking member here (D98); the signed identity state plus the bind cookie are the auth, and the member and credential it names are re-checked',
};

const key = (r) => `${r.method} ${r.pattern}`;

test('T-ROUTES coverage: every hub route is in the tenancy matrix, and the matrix names no dead route', async () => {
  const fx = await tenancy();
  try {
    // Positive control: this route is reachable for its actual team owner.
    // A deny-all implementation must not make cross-team checks vacuous.
    const ownDirectory = await fx.as(fx.users.ub, 'GET', '/api/team-session-directory', undefined, { 'x-board-team': fx.B.team });
    assert.equal(ownDirectory.status, 200, ownDirectory.text);
    assert.equal(ownDirectory.body.team.id, fx.B.team);
    assert.equal(ownDirectory.body.message_contract, 'task-inbox');
    const live = fx.h.app.routes.map(key);
    const missing = live.filter((k) => !MATRIX[k]);
    assert.deepEqual(missing, [], `routes without a tenancy entry: ${missing.join(', ')}`);
    const stale = Object.keys(MATRIX).filter((k) => !live.includes(k));
    assert.deepEqual(stale, [], `matrix entries for routes that no longer exist: ${stale.join(', ')}`);
    // Every route that takes an id from the URL is exercised cross-team.
    for (const r of fx.h.app.routes) {
      if (r.pattern.includes('/:')) assert.equal(MATRIX[key(r)].kind, 'cross', `${key(r)} takes an id: it must be a cross entry`);
      if (MATRIX[key(r)].kind === 'public') assert.ok(MATRIX[key(r)].reason, `${key(r)} is public: give the reason`);
    }
    for (const [k, why] of Object.entries(PRE_ROUTE)) assert.ok(!live.includes(k) && why, k);
    for (const [k, why] of Object.entries(REFUSED)) assert.ok(!live.includes(k) && why, `${k} must not be registered in accounts mode`);
  } finally {
    await fx.h.close();
  }
});

async function sweep(fx, caller) {
  const applied=await fx.as(fx.users.ub,'POST',`/api/boards/${fx.B.board}/workflows/${fx.B.workflow}/apply`,{request_id:randomUUID(),version:1,content_hash:fx.B.workflowHash});
  assert.equal(applied.status,200,applied.text);fx.B.workflowInstance=applied.body.instance.id;
  const step=applied.body.instance.steps[0],card=fx.h.hub.card(step.id);
  const patched=await fx.as(fx.users.ub,'PATCH',`/api/cards/${card.id}`,{request_id:randomUUID(),version:card.version,repo_id:fx.B.repo});assert.equal(patched.status,200,patched.text);
  const current=fx.h.hub.card(card.id);
  fx.B.workflowPreview={request_id:randomUUID(),board_id:fx.B.board,repo_id:fx.B.repo,recipe_version:1,content_hash:fx.B.workflowHash,concurrency:1,
   steps:[{position:0,card_id:current.id,version:current.version,fence:current.fence,ai:'codex',target_member_id:fx.B.owner,budget_usd:null,plan_approval:true}]};
  const preview=await fx.as(fx.users.ub,'POST',`/api/workflow-instances/${fx.B.workflowInstance}/preview`,fx.B.workflowPreview);assert.equal(preview.status,200,preview.text);fx.B.workflowPlan=preview.body.plan.id;
  fx.B.executionPreviewInput={request_id:randomUUID(),plan_hash:preview.body.plan.hash,purpose:'start',declared_paths:[{position:0,paths:[]}]};
  const control=await fx.as(fx.users.ub,'POST',`/api/workflow-plans/${fx.B.workflowPlan}/execution-preview`,fx.B.executionPreviewInput);assert.equal(control.status,200,control.text);fx.B.executionPreview=control.body.execution_preview.id;
  fx.B.workflowStart={expected_revision:0,plan_hash:preview.body.plan.hash,execution_preview_id:fx.B.executionPreview,execution_preview_hash:control.body.execution_preview.hash,path_intent_hash:control.body.execution_preview.path_intent_hash,confirm:true};
  fx.B.workflowResume={...fx.B.workflowStart};delete fx.B.workflowResume.plan_hash;
  const planSnapshot=JSON.parse(fx.db.get('SELECT snapshot FROM workflow_execution_plans WHERE id=?',fx.B.workflowPlan).snapshot);
  const fixed={schema:1,content_hash:planSnapshot.options.content_hash,repository_hmac:planSnapshot.repository_hmac,dependencies:planSnapshot.options.dependencies,card_ids:planSnapshot.steps.map(s=>s.card_id)};
  const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');fx.B.execution=randomUUID();
  fx.db.insert('workflow_executions',{id:fx.B.execution,org_id:fx.B.team,instance_id:fx.B.workflowInstance,board_id:fx.B.board,repo_id:fx.B.repo,source_plan_id:fx.B.workflowPlan,source_hash:digest(fixed),revision:0,state:'planned',created_epoch:fx.h.hub.epoch,created_ms:fx.h.hub.wallMs(),snapshot:canonical(fixed)});
  fx.db.insert('workflow_execution_steps',{execution_id:fx.B.execution,position:0,card_id:current.id,source_hash:digest(planSnapshot.steps[0]),version:current.version,fence:current.fence,state:'pending'});
  const planBefore=fx.db.get('SELECT plan FROM orgs WHERE id=?',fx.B.team).plan;fx.db.run("UPDATE orgs SET plan='pro' WHERE id=?",fx.B.team); // Team setups need the Team plan
  const payload={schema:1,files:[{id:randomUUID(),source_id:'git',relative_path:'.gitconfig',format:'gitconfig',content:'[alias]\n st = status\n',note:''}],items:[],note:MARK};
  const checked=validatePayload(payload);
  const setup=await fx.as(fx.users.ub,'POST',`/api/teams/${fx.B.team}/setups`,{request_id:randomUUID(),expected_version_id:null,payload,review:{schema:1,approved:true,content_hash:checked.content_hash,file_hashes:checked.file_hashes}},{'x-plexiform-account':fx.users.ub.id,'x-plexiform-member':fx.B.owner});
  assert.equal(setup.status,200,setup.text);fx.B.setupProfile=setup.body.profile.id;fx.B.setupVersion=setup.body.version.id;fx.db.run('UPDATE orgs SET plan=? WHERE id=?',planBefore,fx.B.team);
  const setupsBefore=JSON.stringify(fx.db.all('SELECT * FROM setup_versions WHERE profile_id=?',fx.B.setupProfile));
  // A live share of a B member's session with team B.
  fx.B.share = randomUUID(); fx.B.shareSession = randomUUID();
  fx.db.insert('interaction_shares', { id: fx.B.share, owner_user_id: fx.users.ub.id, host_device_id: fx.users.ub.device_id, session_id: fx.B.shareSession, org_id: fx.B.team, scope: 'interact', created_at: fx.h.hub.iso() });
  // B's messaging: a live session target of B's owner shared with B, a message and a handoff to S (both in B).
  fx.B.msgTarget = randomUUID();
  fx.db.run("UPDATE user_devices SET interaction_role = 'host' WHERE id = ?", fx.users.ub.device_id);
  fx.db.insert('msg_targets', { id: fx.B.msgTarget, user_id: fx.users.ub.id, host_device_id: fx.users.ub.device_id, session: randomUUID(), generation: 1, provider: 'codex', label: `${MARK} session`, scope: 'team', org_id: fx.B.team, registered_at: fx.h.hub.iso(), seen_at: fx.h.hub.iso() });
  for (const [k, kind] of [['message', 'message'], ['handoff', 'handoff']]) {
    const sent = await fx.as(fx.users.ub, 'POST', '/api/messaging/v1/messages', { request_id: randomUUID(), to: { user_id: fx.users.s.id, org_id: fx.B.team }, body: `${MARK} ${kind}`, kind });
    assert.equal(sent.status, 200, sent.text);
    fx.B[k] = sent.body.message.id;
  }
  assert.equal(fx.h.hub.messaging.targetProblem(fx.db.get('SELECT * FROM msg_targets WHERE id = ?', fx.B.msgTarget)), null, "B's target is live: only tenancy hides it");
  const messagesBefore = JSON.stringify([fx.db.all('SELECT * FROM msg_messages ORDER BY seq'), fx.db.all('SELECT * FROM msg_targets ORDER BY id')]);
  const before = fx.snapshotB();
  const leaks = [];
  let calls = 0;
  const check = async (label, method, path, body, headers = {}, status = 404, bare = false) => {
    calls++;
    const r = await fx.as(caller, method, path, method === 'GET' ? undefined : bare ? body : { request_id: randomUUID(), ...body }, headers);
    if (r.status !== status) leaks.push(`${label} ${path} → ${r.status} ${r.text.slice(0, 120)}`);
    else if (r.text.includes(MARK) || r.text.includes(fx.B.team) || r.text.includes(fx.B.board) || /beta\.test/.test(r.text)) leaks.push(`${label} ${path}: ${status} body mentions B`);
  };
  for (const r of fx.h.app.routes) {
    const e = MATRIX[key(r)];
    const body = typeof e.body === 'function' ? e.body(fx) : e.body ?? {};
    if (e.kind === 'cross') {
      await check(key(r), r.method, e.path(fx), body, e.headers?.(fx) ?? {}, e.status, e.bare);
      for (const p of e.alt?.(fx) ?? []) await check(`${key(r)} (alt)`, r.method, p, body);
      for (const b of e.also?.(fx) ?? []) await check(`${key(r)} (also)`, r.method, e.path(fx), b);
    } else if (e.kind === 'team') {
      await check(key(r), r.method, r.pattern, body, { 'x-board-team': fx.B.team });
      await check(`${key(r)} ?team=`, r.method, `${r.pattern}?team=${fx.B.team}`, body);
    }
  }
  assert.deepEqual(leaks, []);
  assert.ok(calls >= 30, `only ${calls} cross-team calls made`);
  assert.equal(fx.snapshotB(), before, "team B's rows changed");
  assert.equal(JSON.stringify([fx.db.all('SELECT * FROM msg_messages ORDER BY seq'), fx.db.all('SELECT * FROM msg_targets ORDER BY id')]), messagesBefore, 'no message or target was added or changed');
  assert.equal(JSON.stringify(fx.db.all('SELECT * FROM setup_versions WHERE profile_id=?',fx.B.setupProfile)),setupsBefore,'foreign sealed setups are unchanged');
}

test('T-ROUTES: a team-A owner gets 404 and no B data from every route, with B ids or the B team header', async () => {
  const fx = await tenancy();
  try {
    await sweep(fx, fx.users.ua);
  } finally {
    await fx.h.close();
  }
});

test('T-ROUTES: a signed-in user in no team gets 404 from every route that names a resource or team', async () => {
  const fx = await tenancy();
  try {
    await sweep(fx, fx.users.n);
  } finally {
    await fx.h.close();
  }
});

test('T-SETUP: foreign team headers and claimed user ids cannot redirect first account setup', async () => {
  const fx = await tenancy();
  try {
    const before = fx.snapshotB();
    const r = await fx.as(fx.users.n, 'POST', '/api/account/setup', {
      user_id: fx.users.ub.id, team_id: fx.B.team, org_id: fx.B.team, name: MARK,
    }, { 'x-board-team': fx.B.team });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.setup, 'created');
    assert.equal(r.body.user.id, fx.users.n.id);
    assert.equal(r.body.teams.length, 1);
    assert.notEqual(r.body.teams[0].id, fx.B.team);
    assert.equal(fx.db.get('SELECT user_id FROM members WHERE org_id = ? AND role = ?', r.body.teams[0].id, 'owner').user_id, fx.users.n.id);
    assert.ok(!r.text.includes(MARK) && !r.text.includes(fx.B.team) && !/beta\.test/.test(r.text));
    assert.equal(fx.snapshotB(), before, 'foreign team is unchanged');
  } finally { await fx.h.close(); }
});

test('T-ROUTES: the webhook ignores a signed-in caller: B\'s connection answers 401 to an unsigned post, with no B data', async () => {
  const fx = await tenancy();
  try {
    for (const u of [fx.users.ua, fx.users.n]) {
      const r = await fx.as(u, 'POST', `/integrations/${fx.B.connection}/webhook`, { event: 'issue.opened', issue: { id: 'x', title: 'pwned' } });
      assert.equal(r.status, 401, r.text);
      assert.ok(!r.text.includes(MARK) && !r.text.includes(fx.B.team));
    }
    const snap = fx.snapshotB();
    assert.equal((await fx.as(fx.users.ua, 'POST', `/integrations/${randomUUID()}/webhook`, {})).status, 404);
    assert.equal(fx.snapshotB(), snap);
  } finally {
    await fx.h.close();
  }
});

test('accounts mode: a signed delivery acts as the connecting member in its own team, on the connection\'s buckets', async () => {
  const fx = await tenancy();
  try {
    const { h, B, A } = fx;
    const own = () => h.hub.limiter.buckets.get(`mutate_member|${B.owner}`)?.tokens;
    const before = own();
    const raw = Buffer.from(JSON.stringify({ event: 'issue.opened', issue: { id: 'ISS-1', title: 'From the tracker' } }));
    const r = await fetch(`${h.base}/integrations/${B.connection}/webhook`, {
      method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-fake-signature': sign('whsec_abcdef123456', raw), 'x-fake-delivery': randomUUID() },
    });
    assert.equal(r.status, 200, await r.text());
    const card = h.db.get("SELECT board_id, created_by FROM cards WHERE title = 'From the tracker'");
    assert.deepEqual({ ...card }, { board_id: B.board, created_by: B.owner });
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM cards WHERE board_id = ? AND title = 'From the tracker'", A.board).n, 0);
    for (const rule of ['integration_conn', 'integration_card_conn']) assert.ok(h.hub.limiter.buckets.has(`${rule}|${B.connection}`), rule);
    assert.equal(own(), before, 'never the member\'s own bucket');
  } finally {
    await fx.h.close();
  }
});

test('T-ROUTES: the shared user S reaches B only through B ids; A ids never answer with B data', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, B } = fx;
    // S names B's board with the A team header: header and resource disagree → 404.
    assert.equal((await as(users.s, 'GET', `/api/boards/${B.board}`, undefined, { 'x-board-team': A.team })).status, 404);
    assert.equal((await as(users.s, 'GET', `/api/boards/${B.board}`, undefined, { 'board-org': A.team })).status, 404);
    const own = await as(users.s, 'GET', `/api/boards/${B.board}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.board.id, B.board);
    const a = await as(users.s, 'GET', `/api/boards/${A.board}`);
    assert.ok(!a.text.includes(MARK), 'the A snapshot holds no B data');
    // Without a resource, S must choose; the header picks only S's own teams.
    assert.equal((await as(users.s, 'GET', '/api/me')).status, 409);
    assert.equal((await as(users.s, 'GET', '/api/me', undefined, { 'x-board-team': A.team })).body.org.id, A.team);
    assert.equal((await as(users.s, 'GET', `/api/me?team=${B.team}`)).body.org.id, B.team);
    assert.equal((await as(users.ua, 'GET', '/api/me', undefined, { 'x-board-team': B.team })).status, 404);
    assert.equal((await as(users.ua, 'GET', '/api/me', undefined, { 'x-board-team': randomUUID() })).status, 404);
  } finally {
    await fx.h.close();
  }
});
