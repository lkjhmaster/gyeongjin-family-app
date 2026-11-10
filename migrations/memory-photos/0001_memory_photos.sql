-- Additive only; existing family_state memories and their inline photos remain unchanged.
-- Each photo is one row (JPEG data URL text), so no single D1 cell holds the whole album.
CREATE TABLE IF NOT EXISTS memory_photos(
 id TEXT PRIMARY KEY,
 family_id TEXT NOT NULL,
 data TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size>0),
 created_by TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE,
 FOREIGN KEY(created_by) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_photos_family ON memory_photos(family_id);
CREATE INDEX IF NOT EXISTS idx_memory_photos_creator_time ON memory_photos(created_by,created_at);
