-- Additive only. Reading growth records are append-only: answers, essays and feedback gain new versions, never overwritten.
CREATE TABLE IF NOT EXISTS reading_books(
 id TEXT PRIMARY KEY,
 family_id TEXT NOT NULL,
 child_id TEXT NOT NULL,
 title TEXT NOT NULL,
 author TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'reading' CHECK(status IN ('reading','writing','review','done')),
 created_by TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE,
 FOREIGN KEY(child_id) REFERENCES members(id) ON DELETE CASCADE,
 FOREIGN KEY(created_by) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_reading_books_family_child ON reading_books(family_id,child_id,created_at);
CREATE TABLE IF NOT EXISTS reading_answers(
 id TEXT PRIMARY KEY,
 book_id TEXT NOT NULL,
 prompt_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),
 answer TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(book_id,prompt_id,version),
 FOREIGN KEY(book_id) REFERENCES reading_books(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reading_essays(
 id TEXT PRIMARY KEY,
 book_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),
 kind TEXT NOT NULL CHECK(kind IN ('draft','revision','final')),
 body TEXT NOT NULL,
 created_by TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(book_id,version),
 FOREIGN KEY(book_id) REFERENCES reading_books(id) ON DELETE CASCADE,
 FOREIGN KEY(created_by) REFERENCES members(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS reading_feedback(
 id TEXT PRIMARY KEY,
 book_id TEXT NOT NULL,
 essay_version INTEGER NOT NULL,
 parent_id TEXT,
 praise TEXT NOT NULL DEFAULT '',
 improve TEXT NOT NULL DEFAULT '',
 questions_json TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(book_id) REFERENCES reading_books(id) ON DELETE CASCADE,
 FOREIGN KEY(parent_id) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_reading_feedback_book ON reading_feedback(book_id,created_at);
