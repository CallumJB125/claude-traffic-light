-- A connection's org_id, provider and external_id never change (CONTRACT D98
-- follow-up). 023's insert trigger checks an identity link against them once,
-- and every link, route, secret and webhook URL names the connection by id:
-- changing them in place would carry those to another team or workspace
-- unchecked. No code path writes them after the insert. Additive: one
-- trigger, no table rebuild. A later migration that rebuilds connections
-- must re-create it (with 022's and 023's).

CREATE TRIGGER connections_identity_fixed BEFORE UPDATE OF org_id, provider, external_id ON connections
  WHEN NEW.org_id IS NOT OLD.org_id OR NEW.provider IS NOT OLD.provider OR NEW.external_id IS NOT OLD.external_id
  BEGIN SELECT RAISE(ABORT, 'a connection identity never changes'); END;
