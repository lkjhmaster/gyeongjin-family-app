-- Migration draft: persistent chore approvals (not yet deployed)
-- Existing family_state records remain untouched.
CREATE TABLE IF NOT EXISTS chore_requests (
 id TEXT PRIMARY KEY,
 family_id TEXT NOT NULL,
 member_id TEXT NOT NULL,
 chore_id TEXT NOT NULL,
 occurrence_date TEXT NOT NULL,
 request_kind TEXT NOT NULL CHECK(request_kind IN ('done','exemption','missed')),
 note TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','reopened')),
 reward_amount INTEGER NOT NULL DEFAULT 0 CHECK(reward_amount >= 0),
 penalty_amount INTEGER NOT NULL DEFAULT 0 CHECK(penalty_amount >= 0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reviewed_at TEXT,
 reviewed_by TEXT,
 FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE,
 FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE,
 FOREIGN KEY(reviewed_by) REFERENCES members(id) ON DELETE SET NULL,
 UNIQUE(family_id,member_id,chore_id,occurrence_date)
);
CREATE INDEX IF NOT EXISTS idx_chore_requests_inbox ON chore_requests(family_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_chore_requests_occurrence ON chore_requests(family_id,member_id,occurrence_date);

-- Idempotency for rewards and deductions; financial postings must be transactional.
CREATE TABLE IF NOT EXISTS chore_financial_postings (
 request_id TEXT PRIMARY KEY,
 family_id TEXT NOT NULL,
 member_id TEXT NOT NULL,
 amount INTEGER NOT NULL,
 posting_kind TEXT NOT NULL CHECK(posting_kind IN ('reward','penalty')),
 posted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(request_id) REFERENCES chore_requests(id) ON DELETE RESTRICT
);
