-- Additive only. Audit trail for status changes that are not visible in other tables.
CREATE TABLE IF NOT EXISTS reading_events(
 id TEXT PRIMARY KEY,
 book_id TEXT NOT NULL,
 actor_id TEXT,
 action TEXT NOT NULL CHECK(action IN ('submit','revision_requested')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(book_id) REFERENCES reading_books(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reading_events_book ON reading_events(book_id,created_at);
