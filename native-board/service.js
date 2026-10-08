'use strict';
const path = require('node:path');
const { createBroker, TARGETS } = require('./broker');
const Install = require('./install');

function createService({ dir, seal, unseal, resolveWorkspace, workspaces, launchOptions, home, platform, installer = Install }) {
  const broker = createBroker({ dir, seal, unseal, resolveWorkspace });
  const opts = (target) => {
    const grantPath = broker.grantPath(target);
    return { target, home, platform, grantPath, entry: installer.launch({ ...launchOptions, grantPath }) };
  };
  return {
    start: () => broker.start(), stop: () => broker.stop(),
    async status() {
      const r = await Promise.allSettled(TARGETS.map((target) => installer.status(opts(target))));
      return { ok: true, workspaces: workspaces(), connections: broker.status(), apps: r.map((x, i) => x.status === 'fulfilled' ? x.value : { target: TARGETS[i], installed: false, error: 'This app is unavailable.' }) };
    },
    async boards(workspaceId) {
      const ctx = await resolveWorkspace(workspaceId);
      if (!ctx) return { ok: false, error: 'Choose a signed-in team workspace.' };
      const r = await ctx.client.me();
      if (!r.ok) return r;
      return { ok: true, boards: (r.teams?.find((t) => t.id === ctx.workspace.teamId)?.boards ?? []).filter((b) => !b.archived_at).map((b) => ({ id: b.id, name: b.name })) };
    },
    async connect(input) {
      const o = opts(input.target);
      await installer.check(o);
      await broker.start();
      await broker.connect(input);
      try { await installer.install(o); }
      catch (err) { broker.revoke(input.target); throw err; }
      return { ok: true, target: input.target, restartNeeded: true };
    },
    async disconnect(target) {
      const o = opts(target);
      // Revoke first: a malformed or changed client config cannot retain access.
      broker.revoke(target);
      try { await installer.uninstall(o); return { ok: true }; }
      catch { return { ok: true, warning: 'Board access was removed. The app configuration could not be cleaned up; remove its plexiform-board entry in that app.' }; }
    },
  };
}
module.exports = { createService };
