-- Durable idempotency for cards an integration creates (D42). The D8 replay
-- cache is memory only (10 minutes, lost on restart) and inbound_dedupe rows
-- are released on failure and swept after 30 days, so neither stops a
-- retried webhook or bus redelivery from creating a second card. A card an
-- integration creates is recorded here against (connection, request_id) in
-- the same transaction as the card (api.createCard); the same request again
-- returns that card. Private: no route selects it.
CREATE TABLE integration_requests (
  connection_id TEXT NOT NULL REFERENCES connections(id),
  request_id TEXT NOT NULL,           -- the connector's request_id (≤ 200 chars; longer is refused)
  card_id TEXT NOT NULL REFERENCES cards(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, request_id)
);

-- A connection acts only on cards of its own org (D42). The registry checks
-- this before every write; these triggers make a missed check abort instead of
-- linking, auditing or recording another team's card (D59 style, as 010).
CREATE TRIGGER xteam_external_links_ins BEFORE INSERT ON external_links
  WHEN (SELECT org_id FROM connections WHERE id = NEW.connection_id)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_external_links_upd BEFORE UPDATE OF card_id, connection_id ON external_links
  WHEN (SELECT org_id FROM connections WHERE id = NEW.connection_id)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_integration_audit_ins BEFORE INSERT ON integration_audit
  WHEN NEW.card_id IS NOT NULL AND (SELECT org_id FROM connections WHERE id = NEW.connection_id)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_integration_audit_upd BEFORE UPDATE OF card_id, connection_id ON integration_audit
  WHEN NEW.card_id IS NOT NULL AND (SELECT org_id FROM connections WHERE id = NEW.connection_id)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_integration_requests_ins BEFORE INSERT ON integration_requests
  WHEN (SELECT org_id FROM connections WHERE id = NEW.connection_id)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_integration_requests_upd BEFORE UPDATE OF card_id, connection_id ON integration_requests
  WHEN (SELECT org_id FROM connections WHERE id = NEW.connection_id)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
