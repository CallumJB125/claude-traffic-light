import { HubError } from '../db.js';

// The capability is a private object identity. JSON, caller-supplied functions
// and fabricated ordinary credentials cannot cross this boundary.
const contexts = new WeakMap();
const denied = () => new HubError('FORBIDDEN', 'invalid remote authority context');
export function createRemoteContext({ authorize, replay, record, project }) {
  if ([authorize, replay, record, project].some(fn => typeof fn !== 'function')) throw denied();
  const context = Object.freeze(Object.create(null));
  contexts.set(context, { authorize, replay, record, project });
  return context;
}
function callbacks(context) {
  const value = context && contexts.get(context);
  if (!value) throw denied();
  return value;
}
export function remoteScope(context, member, write) {
  const scope = callbacks(context).authorize(write);
  if (!scope || scope.then || scope.member?.id !== member?.id
    || scope.member?.user_id !== member?.user_id || scope.member?.org_id !== member?.org_id
    || !Array.isArray(scope.boardIds) || !scope.boardIds.length) throw denied();
  return scope;
}
export function remoteMutation(context, member, mutate) {
  const scope = remoteScope(context, member, true), fns = callbacks(context);
  const prior = fns.replay(scope);
  if (prior !== null) return fns.project(prior, remoteScope(context, member, true));
  const result = mutate();
  if (result?.then) throw denied(); // never hold a SQLite transaction across awaits
  fns.record(result, remoteScope(context, member, true));
  return fns.project(result, remoteScope(context, member, true));
}
