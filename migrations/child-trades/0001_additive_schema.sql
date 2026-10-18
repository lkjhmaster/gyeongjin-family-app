-- Additive schema only. Do NOT run against production until backend storage has been confirmed.
-- SQLite / Cloudflare D1. All monetary values are integer KRW; no deletes.
CREATE TABLE IF NOT EXISTS child_trade_transactions (
 id TEXT PRIMARY KEY,
 family_id TEXT NOT NULL REFERENCES families(id),
 kind TEXT NOT NULL CHECK(kind IN ('loan','goods','repayment')),
 requester_id TEXT NOT NULL,
 counterparty_id TEXT NOT NULL,
 payer_id TEXT NOT NULL,
 payee_id TEXT NOT NULL,
 source_wallet TEXT NOT NULL CHECK(source_wallet IN ('free','card','minus')),
 destination_wallet TEXT NOT NULL CHECK(destination_wallet IN ('free','card','minus')),
 gross_amount INTEGER NOT NULL CHECK(gross_amount>0),
 fee_amount INTEGER NOT NULL CHECK(fee_amount>=0),
 net_amount INTEGER NOT NULL CHECK(net_amount>0),
 status TEXT NOT NULL CHECK(status IN ('requested','consented','approved','held','active','delivery_pending','settled','rejected','cancelled','disputed')),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 due_date TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK(requester_id<>counterparty_id),
 CHECK(payer_id<>payee_id),
 CHECK(gross_amount=fee_amount+net_amount)
);
CREATE TABLE IF NOT EXISTS child_trade_approvals (
 id TEXT PRIMARY KEY,
 transaction_id TEXT NOT NULL REFERENCES child_trade_transactions(id),
 revision INTEGER NOT NULL CHECK(revision>=0),
 actor_id TEXT NOT NULL,
 actor_role TEXT NOT NULL CHECK(actor_role IN ('requester','counterparty','parent')),
 decision TEXT NOT NULL CHECK(decision IN ('consent','approve','reject','cancel','mediate')),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS child_trade_holds (
 id TEXT PRIMARY KEY,
 transaction_id TEXT NOT NULL UNIQUE REFERENCES child_trade_transactions(id),
 owner_id TEXT NOT NULL,
 wallet TEXT NOT NULL CHECK(wallet IN ('free','card','minus')),
 gross_amount INTEGER NOT NULL CHECK(gross_amount>0),
 status TEXT NOT NULL CHECK(status IN ('active','released','cancelled')),
 created_at TEXT NOT NULL,
 released_at TEXT
);
CREATE TABLE IF NOT EXISTS child_trade_postings (
 id TEXT PRIMARY KEY,
 transaction_id TEXT NOT NULL REFERENCES child_trade_transactions(id),
 owner_id TEXT NOT NULL,
 wallet TEXT NOT NULL CHECK(wallet IN ('free','card','minus')),
 amount INTEGER NOT NULL CHECK(amount<>0),
 kind TEXT NOT NULL CHECK(kind IN ('debit','credit','fee','refund','correction','minus_repayment')),
 original_posting_id TEXT REFERENCES child_trade_postings(id),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS child_trade_loans (
 id TEXT PRIMARY KEY,
 transaction_id TEXT NOT NULL UNIQUE REFERENCES child_trade_transactions(id),
 borrower_id TEXT NOT NULL,
 lender_id TEXT NOT NULL,
 principal_amount INTEGER NOT NULL CHECK(principal_amount>0),
 outstanding_amount INTEGER NOT NULL CHECK(outstanding_amount>=0 AND outstanding_amount<=principal_amount),
 due_date TEXT,
 status TEXT NOT NULL CHECK(status IN ('active','settled','disputed','cancelled'))
);
CREATE TABLE IF NOT EXISTS child_trade_repayments (
 id TEXT PRIMARY KEY,
 loan_id TEXT NOT NULL REFERENCES child_trade_loans(id),
 transaction_id TEXT NOT NULL UNIQUE REFERENCES child_trade_transactions(id),
 gross_amount INTEGER NOT NULL CHECK(gross_amount>0),
 fee_amount INTEGER NOT NULL CHECK(fee_amount>=0),
 principal_reduction INTEGER NOT NULL CHECK(principal_reduction>0),
 created_at TEXT NOT NULL,
 CHECK(gross_amount=fee_amount+principal_reduction)
);
CREATE TABLE IF NOT EXISTS child_trade_audit (
 id TEXT PRIMARY KEY,
 transaction_id TEXT NOT NULL REFERENCES child_trade_transactions(id),
 actor_id TEXT NOT NULL,
 action TEXT NOT NULL,
 previous_state TEXT,
 next_state TEXT,
 revision INTEGER NOT NULL CHECK(revision>=0),
 payload_json TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS child_trade_idempotency (
 operation_key TEXT PRIMARY KEY,
 transaction_id TEXT NOT NULL REFERENCES child_trade_transactions(id),
 result_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS child_trade_one_pending_loan_per_borrower ON child_trade_transactions(family_id,requester_id) WHERE kind='loan' AND status IN ('requested','consented','approved');
CREATE INDEX IF NOT EXISTS child_trade_by_requester ON child_trade_transactions(family_id,requester_id,status,created_at);
CREATE INDEX IF NOT EXISTS child_trade_by_counterparty ON child_trade_transactions(family_id,counterparty_id,status,created_at);
CREATE INDEX IF NOT EXISTS child_trade_active_holds ON child_trade_holds(owner_id,wallet,status);
CREATE INDEX IF NOT EXISTS child_trade_postings_by_wallet ON child_trade_postings(owner_id,wallet,created_at);
CREATE INDEX IF NOT EXISTS child_trade_open_loans ON child_trade_loans(borrower_id,status,outstanding_amount);
CREATE INDEX IF NOT EXISTS child_trade_audit_by_tx ON child_trade_audit(transaction_id,created_at);
