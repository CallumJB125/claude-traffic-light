-- Connector retries survive process restarts. Receipt and comment are committed
-- together; deleting the underlying comment or connection removes its receipt.
CREATE TABLE integration_comment_requests (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(connection_id, request_id)
);
CREATE TRIGGER xteam_integration_comment_requests_ins BEFORE INSERT ON integration_comment_requests
  WHEN (SELECT org_id FROM connections WHERE id=NEW.connection_id)
    IS NOT (SELECT b.org_id FROM comments m JOIN cards c ON c.id=m.card_id JOIN boards b ON b.id=c.board_id WHERE m.id=NEW.comment_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_integration_comment_requests_upd BEFORE UPDATE OF comment_id, connection_id ON integration_comment_requests
  WHEN (SELECT org_id FROM connections WHERE id=NEW.connection_id)
    IS NOT (SELECT b.org_id FROM comments m JOIN cards c ON c.id=m.card_id JOIN boards b ON b.id=c.board_id WHERE m.id=NEW.comment_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
