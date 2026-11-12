-- Additive only. Each child's school grade as set by a parent (1-6 = elementary, 7-9 = middle, 10-12 = high) and the school year it was set in.
-- The app adds one grade per school year (Korean school year starts in March), so grades advance on their own.
CREATE TABLE IF NOT EXISTS reading_levels(
 member_id TEXT PRIMARY KEY,
 grade INTEGER NOT NULL CHECK(grade BETWEEN 1 AND 12),
 school_year INTEGER NOT NULL,
 updated_by TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE,
 FOREIGN KEY(updated_by) REFERENCES members(id) ON DELETE SET NULL
);
