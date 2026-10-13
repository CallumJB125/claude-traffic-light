-- What an observed local session cost so far (API-price equivalent), and how many
-- of its requests could not be priced. Written only by the embedded local hub.
ALTER TABLE work_capture_cards ADD COLUMN cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0);
ALTER TABLE work_capture_cards ADD COLUMN cost_unpriced INTEGER CHECK (cost_unpriced IS NULL OR cost_unpriced >= 0);
