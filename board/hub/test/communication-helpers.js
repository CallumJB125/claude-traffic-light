import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';
import { FakeRunner, until, runMsg, runHb } from './helpers.js';

// Real accounts, enrollments and authenticated WS; protocol clients only.
export async function communicationRig(t, options = {}) {
  const f = await tenancy(options), clients = [];
  t.after(async () => { clients.forEach((c) => c.terminate()); await f.h.close(); });
  async function participant(user, team = f.A, { board = team.board, title = 'Communication task' } = {}) {
    const enrollment = await f.as(user, 'POST', `/api/teams/${team.team}/enrol`, {}); assert.equal(enrollment.status, 200, enrollment.text);
    async function open(runs = []) {
      const r = new FakeRunner(f.h.base, { device_id: '', device_token: enrollment.body.runner_token, team: team.team }); clients.push(r);
      await r.open(); await r.hello(runs);
      r.send({ type: 'advertise', repos: [{ repo_id: team.repo }], ai: [{ id: 'codex', label: 'Codex', installed: true, signedIn: true, startable: true, capabilities: { budget: 'none', resume: true } }] });
      await until(() => f.h.hub.runners.get(r.welcome.device_id)?.ai?.[0]?.id === 'codex'); return r;
    }
    const client = await open(), card = await f.as(user, 'POST', `/api/boards/${board}/cards`, { request_id: randomUUID(), title, repo_id: team.repo }); assert.equal(card.status, 200, card.text);
    const dispatch = await f.as(user, 'POST', `/api/cards/${card.body.card.id}/actions/dispatch`, { request_id: randomUUID(), ai: 'codex', budget_usd: null }); assert.equal(dispatch.status, 200, dispatch.text);
    const offer = await client.next('offer', (o) => o.card_id === card.body.card.id), claim = await client.claim(offer); assert.equal(claim.ok, true);
    const run = { ...claim, card_id: offer.card_id, repo_id: team.repo, key: offer.key };
    await client.out({ ...runMsg(run), kind: 'activity', source: 'fixture' }); await client.hb([runHb(run, { cost_usd: null })]);
    return { client, run, user, enrollment: enrollment.body.enrollment_id, open, connection: () => f.h.hub.runners.get(client.welcome.device_id) };
  }
  const sender = await participant(f.users.amember), recipient = await participant(f.users.aadmin);
  return { ...f, participant, sender, recipient };
}
export const taskMessage = (recipient, over = {}) => ({ request_id: randomUUID(), kind: 'coordination', body: 'I changed the route; please review the caller.', recipient_run_ids: [recipient.run.run_id], ...over });
export const receiptOf = (message) => ({ receipt_id: message.delivery.receipt_id, receipt_token: message.delivery.receipt_token });
