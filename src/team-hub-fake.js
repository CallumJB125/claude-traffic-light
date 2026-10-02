'use strict';
// FAKE team hub for Overview "Team sessions". In-memory test data only, never
// a real hub: every team it lists is labelled as fake in the page. It
// implements the narrow interface documented in src/session-directory.js and
// filters like the real hub must (membership + explicit, live share), so the
// directory's own main-side filter is exercised as a second fence.
//
// Fixture: { viewer: "u-me", users: {id: name}, teams: [{id, name, members: [userId]}],
//   sessions: [{ref, owner, provider, device, card, task_title, state, input_needed,
//   observed_at | observed_ago_ms, self_reported, children, capabilities,
//   shares: [{team, scope, revoked?, expires_at?}]}] }
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

function createFakeTeamHub(fixture = {}, { now = Date.now } = {}) {
  const ee = new EventEmitter();
  const users = { ...(fixture.users ?? {}) };
  const teams = (fixture.teams ?? []).map((t) => ({ id: t.id, name: t.name, members: new Set(t.members ?? []) }));
  const sessions = (fixture.sessions ?? []).map((s) => ({ ...s, shares: (s.shares ?? []).map((x) => ({ ...x })), deliveries: [] }));
  const at = (s) => (Number.isFinite(s.observed_ago_ms) ? now() - s.observed_ago_ms : s.observed_at ?? null);
  const member = (viewer, teamId) => !!teams.find((t) => t.id === teamId)?.members.has(viewer?.id);
  const live = (x) => x && !x.revoked && (x.expires_at == null || Date.parse(x.expires_at) > now());
  const shareFor = (s, teamId) => s.shares.find((x) => x.team === teamId && live(x));
  const changed = () => ee.emit('change');
  return {
    label: 'Fake team hub (test data)', fake: true,
    viewer: () => ({ id: fixture.viewer ?? 'u-me', name: users[fixture.viewer] ?? 'You' }),
    async teams(viewer) { return teams.filter((t) => t.members.has(viewer?.id)).map((t) => ({ id: t.id, name: t.name })); },
    async sessions(viewer, teamId) {
      if (!member(viewer, teamId)) return [];
      const team = teams.find((t) => t.id === teamId);
      return sessions.filter((s) => s.owner !== viewer.id && member({ id: s.owner }, teamId) && shareFor(s, teamId)).map((s) => {
        const sh = shareFor(s, teamId);
        return {
          ref: s.ref, team: { id: team.id, name: team.name }, owner: { id: s.owner, name: users[s.owner] ?? 'Teammate' },
          share: { explicit: true, scope: sh.scope, expiresAt: sh.expires_at ?? null, revoked: false },
          provider: s.provider, device: s.device, card: s.card ?? null, task_title: s.task_title ?? null, state: s.state, input_needed: s.input_needed === true,
          observed_at: at(s), self_reported: s.self_reported ?? null, online: s.online !== false, capabilities: s.capabilities ?? {},
          handoffs: s.handoffs ?? [], children: (s.children ?? []).map((c) => ({ ...c, observed_at: Number.isFinite(c.observed_ago_ms) ? now() - c.observed_ago_ms : c.observed_at ?? null })),
          deliveries: s.deliveries.map((d) => ({ ...d })),
        };
      });
    },
    // A fake "delivery": accepted, then a canned acknowledgement + reply, so the
    // page's message → ack → response path can be exercised without a real hub.
    async send(viewer, teamId, ref, text) {
      const s = sessions.find((x) => x.ref === ref);
      const sh = s && member(viewer, teamId) && member({ id: s.owner }, teamId) ? shareFor(s, teamId) : null;
      if (!sh) return { ok: false, status: 'forbidden', error: 'This session is not shared with you.' };
      if (sh.scope !== 'interact') return { ok: false, status: 'forbidden', error: 'Shared with you to watch only.' };
      if (s.online === false || s.state === 'ended') return { ok: false, status: 'unavailable', error: 'The owner\'s computer is offline.' };
      const d = { id: crypto.randomUUID(), text, by: users[viewer.id] ?? 'You', state: 'acknowledged', response: '' };
      s.deliveries.push(d); while (s.deliveries.length > 10) s.deliveries.shift();
      setTimeout(() => { d.state = 'replied'; d.response = `(fake hub) ${users[s.owner] ?? 'Teammate'}'s session received: ${text.slice(0, 200)}`; changed(); }, 50).unref?.();
      changed();
      return { ok: true, status: 'queued', delivery: { ...d } };
    },
    onChange(fn) { ee.on('change', fn); return () => ee.off('change', fn); },
    // Test/demo controls.
    revoke(ref, teamId) { for (const s of sessions) if (s.ref === ref) for (const x of s.shares) if (x.team === teamId) x.revoked = true; changed(); },
    removeMember(teamId, userId) { teams.find((t) => t.id === teamId)?.members.delete(userId); changed(); },
    update(ref, patch) { const s = sessions.find((x) => x.ref === ref); if (s) Object.assign(s, patch); changed(); },
  };
}

module.exports = { createFakeTeamHub };
