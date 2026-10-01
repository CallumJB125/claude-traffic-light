-- settings.provider (CONTRACT D42 addendum C1): what the provider said at
-- connect time (exchange/prepare/verifyToken settings, the pinned match, the
-- hub's own origin), written with the connections row and never again. A
-- reconnect is a new connection. json_type as well as json_extract, so a row
-- without provider can't gain one, not even as JSON null. Additive: no table
-- rebuild; 024 stays reserved (the runner fills gaps). A later migration that
-- rebuilds connections or integration_pending must re-create every trigger
-- below (with 022's, 023's and 025's).

CREATE TRIGGER connections_provider_fixed BEFORE UPDATE OF settings ON connections
  WHEN json_type(NEW.settings, '$.provider') IS NOT json_type(OLD.settings, '$.provider')
    OR json_extract(NEW.settings, '$.provider') IS NOT json_extract(OLD.settings, '$.provider')
  BEGIN SELECT RAISE(ABORT, 'settings.provider never changes'); END;

-- INSERT OR REPLACE deletes the old row and fires no UPDATE trigger: an id
-- that already names a connection is never inserted again.
CREATE TRIGGER connections_id_never_reused BEFORE INSERT ON connections
  WHEN EXISTS (SELECT 1 FROM connections WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'a connection id is never reused'); END;

-- SQLite reads the first of two equal keys, JSON.parse the last, and SQLite
-- also takes JSON5 (and JSONB blobs): a raw write could show these triggers
-- one value and the registry another. So settings is RFC 8259 text, an
-- object, with no key twice in any one object at any depth (json_tree
-- decodes escaped keys, so "provider" counts as provider).
CREATE TRIGGER connections_settings_strict BEFORE UPDATE OF settings ON connections
  WHEN CASE WHEN json_valid(NEW.settings, 1) AND json_type(NEW.settings) = 'object'
    THEN EXISTS (SELECT 1 FROM json_tree(NEW.settings) GROUP BY parent, key HAVING count(*) > 1) ELSE 1 END
  BEGIN SELECT RAISE(ABORT, 'settings must be strict JSON without duplicate keys'); END;
CREATE TRIGGER connections_settings_strict_ins BEFORE INSERT ON connections
  WHEN CASE WHEN json_valid(NEW.settings, 1) AND json_type(NEW.settings) = 'object'
    THEN EXISTS (SELECT 1 FROM json_tree(NEW.settings) GROUP BY parent, key HAVING count(*) > 1) ELSE 1 END
  BEGIN SELECT RAISE(ABORT, 'settings must be strict JSON without duplicate keys'); END;
-- 022's pending JSON: promotion reads match and settings with JSON.parse.
CREATE TRIGGER integration_pending_json_strict BEFORE UPDATE OF match, settings ON integration_pending
  WHEN CASE WHEN json_valid(NEW.match, 1) AND json_type(NEW.match) = 'object' AND json_valid(NEW.settings, 1) AND json_type(NEW.settings) = 'object'
    THEN EXISTS (SELECT 1 FROM json_tree(NEW.match) GROUP BY parent, key HAVING count(*) > 1)
      OR EXISTS (SELECT 1 FROM json_tree(NEW.settings) GROUP BY parent, key HAVING count(*) > 1) ELSE 1 END
  BEGIN SELECT RAISE(ABORT, 'match and settings must be strict JSON without duplicate keys'); END;
CREATE TRIGGER integration_pending_json_strict_ins BEFORE INSERT ON integration_pending
  WHEN CASE WHEN json_valid(NEW.match, 1) AND json_type(NEW.match) = 'object' AND json_valid(NEW.settings, 1) AND json_type(NEW.settings) = 'object'
    THEN EXISTS (SELECT 1 FROM json_tree(NEW.match) GROUP BY parent, key HAVING count(*) > 1)
      OR EXISTS (SELECT 1 FROM json_tree(NEW.settings) GROUP BY parent, key HAVING count(*) > 1) ELSE 1 END
  BEGIN SELECT RAISE(ABORT, 'match and settings must be strict JSON without duplicate keys'); END;

-- Connections are never deleted (D41): a revoke keeps the row, and links,
-- routes, audit and webhook URLs name it by id, which never changes either.
-- REPLACE deletes a conflicting row without firing delete triggers (no
-- recursive_triggers), so a write that would collide with a live row's
-- (org_id, provider, external_id) is refused before it gets that far; the
-- registry checks that clash itself before every insert.
CREATE TRIGGER connections_never_deleted BEFORE DELETE ON connections
  BEGIN SELECT RAISE(ABORT, 'a connection is never deleted'); END;
CREATE TRIGGER connections_live_never_replaced BEFORE INSERT ON connections
  WHEN NEW.status IS NOT 'revoked' AND EXISTS (SELECT 1 FROM connections WHERE id IS NOT NEW.id AND org_id = NEW.org_id AND provider = NEW.provider AND external_id = NEW.external_id AND status != 'revoked')
  BEGIN SELECT RAISE(ABORT, 'a live connection is never replaced'); END;
CREATE TRIGGER connections_live_never_replaced_upd BEFORE UPDATE OF status ON connections
  WHEN NEW.status IS NOT 'revoked' AND EXISTS (SELECT 1 FROM connections WHERE id IS NOT NEW.id AND org_id = NEW.org_id AND provider = NEW.provider AND external_id = NEW.external_id AND status != 'revoked')
  BEGIN SELECT RAISE(ABORT, 'a live connection is never replaced'); END;
CREATE TRIGGER connections_id_fixed BEFORE UPDATE OF id ON connections
  WHEN NEW.id IS NOT OLD.id
  BEGIN SELECT RAISE(ABORT, 'a connection id never changes'); END;
