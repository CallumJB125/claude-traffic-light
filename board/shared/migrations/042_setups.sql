-- Reviewed team Setups bytes are sealed separately from all board content.
CREATE TABLE setup_profiles (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 owner_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 published INTEGER NOT NULL DEFAULT 0 CHECK(published IN(0,1)), current_version_id TEXT,
 sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0), created_at TEXT NOT NULL,
 UNIQUE(org_id,owner_user_id)
);
CREATE TABLE setup_versions (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES setup_profiles(id) ON DELETE CASCADE,
 number INTEGER NOT NULL CHECK(number>0), content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 2097152), file_count INTEGER NOT NULL CHECK(file_count BETWEEN 0 AND 128),
 item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 1000), sources TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES members(id), created_at TEXT NOT NULL, review_attestation TEXT NOT NULL CHECK(length(review_attestation)<=65536),
 key_id TEXT NOT NULL, nonce BLOB NOT NULL CHECK(length(nonce)=12), ciphertext BLOB NOT NULL CHECK(length(ciphertext)=bytes+16),
 UNIQUE(profile_id,number)
);
CREATE INDEX setup_versions_profile ON setup_versions(profile_id,number);
CREATE TABLE setup_requests (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 member_id TEXT REFERENCES members(id) ON DELETE SET NULL, request_id TEXT NOT NULL,
 operation TEXT NOT NULL, scope_id TEXT NOT NULL, binding TEXT NOT NULL,
 result_profile_id TEXT, result_version_id TEXT REFERENCES setup_versions(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(user_id,org_id,request_id)
);
CREATE TABLE setup_activity (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES setup_profiles(id) ON DELETE CASCADE,
 actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, kind TEXT NOT NULL,
 version_number INTEGER, selection_count INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE setup_baselines (
 org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
 profile_id TEXT NOT NULL REFERENCES setup_profiles(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES setup_versions(id) ON DELETE CASCADE,
 selection TEXT NOT NULL, required INTEGER NOT NULL CHECK(required IN(0,1)), updated_at TEXT NOT NULL
);
CREATE TABLE setup_receipts (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES setup_profiles(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES setup_versions(id) ON DELETE CASCADE,
 actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 selection TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN('reviewed','reported_applied','reported_undone')),
 created_at TEXT NOT NULL
);
CREATE TRIGGER setup_versions_immutable BEFORE UPDATE ON setup_versions
 WHEN NEW.id!=OLD.id OR NEW.profile_id!=OLD.profile_id OR NEW.number!=OLD.number OR NEW.content_hash!=OLD.content_hash
 OR NEW.bytes!=OLD.bytes OR NEW.file_count!=OLD.file_count OR NEW.item_count!=OLD.item_count OR NEW.sources!=OLD.sources
 OR NEW.created_by!=OLD.created_by OR NEW.created_at!=OLD.created_at OR NEW.review_attestation!=OLD.review_attestation
 BEGIN SELECT RAISE(ABORT,'setup version metadata is immutable'); END;
CREATE TRIGGER setup_unpublish AFTER UPDATE OF published ON setup_profiles WHEN NEW.published=0 BEGIN
 DELETE FROM setup_versions WHERE profile_id=NEW.id;
 DELETE FROM setup_activity WHERE profile_id=NEW.id AND kind!='unpublished';
 DELETE FROM setup_baselines WHERE profile_id=NEW.id;
 UPDATE setup_profiles SET current_version_id=NULL WHERE id=NEW.id;
END;
CREATE TRIGGER setup_member_removed AFTER UPDATE OF removed_at,user_id,org_id ON members
 WHEN NEW.removed_at IS NOT NULL OR NEW.user_id IS NOT OLD.user_id OR NEW.org_id!=OLD.org_id BEGIN
 UPDATE setup_profiles SET published=0 WHERE owner_member_id=OLD.id;
 DELETE FROM setup_receipts WHERE actor_user_id=OLD.user_id AND profile_id IN(SELECT id FROM setup_profiles WHERE org_id=OLD.org_id);
 UPDATE setup_activity SET actor_user_id=NULL WHERE actor_user_id=OLD.user_id AND profile_id IN(SELECT id FROM setup_profiles WHERE org_id=OLD.org_id);
END;
CREATE TRIGGER setup_user_deleted AFTER UPDATE OF deleted_at ON users WHEN NEW.deleted_at IS NOT NULL BEGIN
 UPDATE setup_profiles SET published=0 WHERE owner_user_id=NEW.id;
 DELETE FROM setup_receipts WHERE actor_user_id=NEW.id;
 UPDATE setup_activity SET actor_user_id=NULL WHERE actor_user_id=NEW.id;
END;
CREATE TRIGGER setup_team_deleted AFTER UPDATE OF deleted_at ON orgs WHEN NEW.deleted_at IS NOT NULL BEGIN
 UPDATE setup_profiles SET published=0 WHERE org_id=NEW.id;
 DELETE FROM setup_activity WHERE profile_id IN(SELECT id FROM setup_profiles WHERE org_id=NEW.id);
END;
