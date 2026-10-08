-- Additive index for accepted comment row quota checks. No row changes.
CREATE INDEX IF NOT EXISTS comments_by_card ON comments(card_id);
