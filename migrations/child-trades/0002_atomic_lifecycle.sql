-- Additive lifecycle state, append-only audit and batch compare-and-swap assertions.
CREATE TABLE IF NOT EXISTS child_trade_guards(id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
CREATE TABLE IF NOT EXISTS child_trade_details(
 transaction_id TEXT PRIMARY KEY REFERENCES child_trade_transactions(id),
 loan_id TEXT REFERENCES child_trade_loans(id), title TEXT NOT NULL DEFAULT '',
 destination_debt_id TEXT, consent_required_id TEXT, delivery_epoch INTEGER NOT NULL DEFAULT 0, refunded_gross INTEGER NOT NULL DEFAULT 0 CHECK(refunded_gross>=0)
);
CREATE TABLE IF NOT EXISTS child_trade_delivery(
 transaction_id TEXT NOT NULL REFERENCES child_trade_transactions(id), actor_id TEXT NOT NULL,
 revision INTEGER NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(transaction_id,actor_id,revision)
);
CREATE TABLE IF NOT EXISTS child_trade_actions(
 id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES child_trade_transactions(id),
 kind TEXT NOT NULL CHECK(kind IN ('refund','cancel','revise','resolve')),
 requester_id TEXT NOT NULL, counterparty_id TEXT NOT NULL,
 payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('requested','consented','approved','rejected','cancelled')),
 revision INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS child_trade_one_open_action ON child_trade_actions(transaction_id) WHERE status IN ('requested','consented');
CREATE TRIGGER IF NOT EXISTS child_trade_postings_immutable_update BEFORE UPDATE ON child_trade_postings BEGIN SELECT RAISE(ABORT,'immutable posting'); END;
CREATE TRIGGER IF NOT EXISTS child_trade_postings_immutable_delete BEFORE DELETE ON child_trade_postings BEGIN SELECT RAISE(ABORT,'immutable posting'); END;
CREATE TRIGGER IF NOT EXISTS child_trade_audit_immutable_update BEFORE UPDATE ON child_trade_audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
CREATE TRIGGER IF NOT EXISTS child_trade_audit_immutable_delete BEFORE DELETE ON child_trade_audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
-- Every writer, including old allowance endpoints and scheduled jobs, preserves trade rows.
CREATE TRIGGER IF NOT EXISTS child_trade_ledger_preserve BEFORE UPDATE OF value_json ON family_state
WHEN OLD.state_key='allowance_ledger'
BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(OLD.value_json) child, json_each(child.value) oldrow
  WHERE json_extract(oldrow.value,'$.childTradeId') IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM json_each(NEW.value_json) nc,json_each(nc.value) nr
   WHERE nc.key=child.key AND nr.value=oldrow.value
  )
 ) THEN RAISE(ABORT,'trade ledger rows are immutable') END;
END;
CREATE TRIGGER IF NOT EXISTS child_trade_hold_limit BEFORE UPDATE OF value_json ON family_state
WHEN NEW.state_key='allowance_limits'
BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM child_trade_holds h JOIN child_trade_transactions t ON t.id=h.transaction_id
  JOIN members m ON m.id=h.owner_id WHERE t.family_id=NEW.family_id AND h.status='active' AND h.wallet='minus'
  GROUP BY h.owner_id
  HAVING SUM(h.gross_amount)>COALESCE(CAST(json_extract(NEW.value_json,'$."'||m.name||'"') AS INTEGER),0)
   +COALESCE((SELECT SUM(CASE json_extract(r.value,'$.type') WHEN 'income' THEN json_extract(r.value,'$.amount') WHEN 'expense' THEN -json_extract(r.value,'$.amount') ELSE 0 END)
    FROM family_state s,json_each(s.value_json) c,json_each(c.value) r WHERE s.family_id=NEW.family_id AND s.state_key='allowance_ledger' AND c.key=m.name AND json_extract(r.value,'$.wallet')='minus' AND COALESCE(json_extract(r.value,'$.status'),'approved')='approved'),0)
 ) THEN RAISE(ABORT,'reserved minus limit cannot be reduced') END;
END;
-- Reservation invariant applies to ALL allowance writers, not only trade settlement.
CREATE TRIGGER IF NOT EXISTS child_trade_hold_balance BEFORE UPDATE OF value_json ON family_state
WHEN NEW.state_key='allowance_ledger'
BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM child_trade_holds h JOIN child_trade_transactions t ON t.id=h.transaction_id
  JOIN members m ON m.id=h.owner_id AND m.family_id=t.family_id
  WHERE t.family_id=NEW.family_id AND h.status='active'
  GROUP BY h.owner_id,h.wallet
  HAVING SUM(h.gross_amount) >
   COALESCE((SELECT SUM(CASE json_extract(r.value,'$.type') WHEN 'income' THEN json_extract(r.value,'$.amount') WHEN 'expense' THEN -json_extract(r.value,'$.amount') ELSE 0 END)
     FROM json_each(NEW.value_json) c,json_each(c.value) r WHERE c.key=m.name AND json_extract(r.value,'$.wallet')=h.wallet AND COALESCE(json_extract(r.value,'$.status'),'approved')='approved'),0)
   + CASE WHEN h.wallet='minus' THEN COALESCE((SELECT CAST(json_extract(s.value_json,'$."'||m.name||'"') AS INTEGER) FROM family_state s WHERE s.family_id=NEW.family_id AND s.state_key='allowance_limits'),0) ELSE 0 END
 ) THEN RAISE(ABORT,'reserved funds cannot be spent') END;
END;

-- Existing deployed loans gain lifecycle metadata without changing balances.
INSERT OR IGNORE INTO child_trade_details(transaction_id) SELECT id FROM child_trade_transactions;
