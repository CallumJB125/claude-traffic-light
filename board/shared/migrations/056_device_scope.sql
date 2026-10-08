-- Scoped device sign-ins (W2-A, docs/relay-e2e-threat-model.md; PHONE.md
-- "Scoped phone token"). 'full' (default: every desktop sign-in) is a whole
-- account device credential. 'relay' is what a phone gets: hub/http.js accepts
-- it only on the interaction relay's call routes and on sign-out, and refuses
-- it (403) everywhere else, including every WebSocket. Issued when the sign-in
-- asks for scope 'relay' or names the phone platform ('phone-web'). Existing
-- phone sign-ins are narrowed in place. Additive: no table rebuild. 054/055
-- left free for parallel lanes.

ALTER TABLE user_devices ADD COLUMN scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full','relay'));
UPDATE user_devices SET scope = 'relay' WHERE platform = 'phone-web';
