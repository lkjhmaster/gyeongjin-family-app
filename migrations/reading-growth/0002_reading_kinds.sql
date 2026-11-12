-- Additive only. Which kind of record a reading_books row is. Rows without an entry are books, so existing data needs no change.
CREATE TABLE IF NOT EXISTS reading_book_kinds(
 book_id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('book','performance','exhibition')),
 FOREIGN KEY(book_id) REFERENCES reading_books(id) ON DELETE CASCADE
);
