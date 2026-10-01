-- Durable idempotency for cards an integration creates (D42). The D8 replay
-- cache is memory only (10 minutes, lost on restart) and inbound_dedupe rows
-- are released on failure and swept after 30 days, so neither stops a
-- retried webhook or bus redelivery from creating a second card. A card an
-- integration creates is recorded here against (connection, request_id) in
-- the same transaction as the card (api.createCard); the same request again
-- returns that card. Private: no route selects it.
CREATE TABLE integration_requests (
  connection_id TEXT NOT NULL REFERENCES connections(id),
  request_id TEXT NOT NULL,           -- the connector's request_id, first 200 chars
  card_id TEXT NOT NULL REFERENCES cards(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, request_id)
);
