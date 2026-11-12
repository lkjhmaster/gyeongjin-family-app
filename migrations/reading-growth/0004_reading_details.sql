-- Additive only. Optional details of a record: the format (e.g. 판소리, 오페라, 미술) and a cover/poster photo reference ('photo:<id>').
CREATE TABLE IF NOT EXISTS reading_book_details(
 book_id TEXT PRIMARY KEY,
 format TEXT,
 cover TEXT,
 FOREIGN KEY(book_id) REFERENCES reading_books(id) ON DELETE CASCADE
);
