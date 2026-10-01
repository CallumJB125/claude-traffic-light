-- What let a new account in (CONTRACT D104): 'allowlist' (BOARD_SIGNUP_ALLOW),
-- 'member_row' (an unlinked member row an admin or BOARD_BOOTSTRAP made),
-- 'invite' (a pending invite only) or 'open' (BOARD_SIGNUP=open). Set when
-- the user is made, never changed. NULL: made before this column, treated
-- like 'allowlist'. While sign-up is allowlist an 'invite' account may join
-- teams but not create one. Additive: no table rebuild; 027 stays reserved
-- (the runner fills gaps).

ALTER TABLE users ADD COLUMN signup_via TEXT CHECK (signup_via IN ('allowlist','invite','member_row','open'));
