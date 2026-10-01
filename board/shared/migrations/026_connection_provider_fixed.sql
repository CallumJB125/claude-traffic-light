-- settings.provider (CONTRACT D42 addendum C1): what the provider said at
-- connect time (exchange/prepare/verifyToken settings, the pinned match, the
-- hub's own origin), written with the connections row and never again. A
-- reconnect is a new connection. json_type as well as json_extract, so a row
-- without provider can't gain one, not even as JSON null. Additive: no table
-- rebuild; 024 stays reserved (the runner fills gaps). A later migration that
-- rebuilds connections must re-create both (with 022's, 023's and 025's).

CREATE TRIGGER connections_provider_fixed BEFORE UPDATE OF settings ON connections
  WHEN json_type(NEW.settings, '$.provider') IS NOT json_type(OLD.settings, '$.provider')
    OR json_extract(NEW.settings, '$.provider') IS NOT json_extract(OLD.settings, '$.provider')
  BEGIN SELECT RAISE(ABORT, 'settings.provider never changes'); END;

-- INSERT OR REPLACE deletes the old row and fires no UPDATE trigger: an id
-- that already names a connection is never inserted again.
CREATE TRIGGER connections_id_never_reused BEFORE INSERT ON connections
  WHEN EXISTS (SELECT 1 FROM connections WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'a connection id is never reused'); END;
