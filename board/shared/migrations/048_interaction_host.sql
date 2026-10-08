-- Remote interaction (board/hub/interaction-relay.js): what a desktop device
-- may do with the relay. 'client' (default: every existing and new device)
-- may list and call hosts of its own account; 'host' may only offer its own
-- Plexiform-started sessions. Set only by the device itself, through an
-- explicit opt-in in that device's app; a device is never both, so a client
-- token cannot connect as a host and a host token cannot drive other hosts.
-- Additive: no table rebuild. 047 left free for parallel lanes.

ALTER TABLE user_devices ADD COLUMN interaction_role TEXT NOT NULL DEFAULT 'client' CHECK (interaction_role IN ('client','host'));
