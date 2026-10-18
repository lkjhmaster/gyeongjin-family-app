-- Additive only; legacy trades and their holds remain unchanged.
CREATE TABLE IF NOT EXISTS child_trade_funding(
 transaction_id TEXT NOT NULL REFERENCES child_trade_transactions(id),
 wallet TEXT NOT NULL CHECK(wallet IN ('free','card','minus')),
 gross_amount INTEGER NOT NULL CHECK(gross_amount>0),
 fee_amount INTEGER NOT NULL CHECK(fee_amount>=0 AND fee_amount<=gross_amount),
 hold_status TEXT NOT NULL CHECK(hold_status IN ('planned','active','released','cancelled')),
 PRIMARY KEY(transaction_id,wallet)
);
CREATE VIEW IF NOT EXISTS child_trade_all_holds AS
 SELECT h.transaction_id,h.owner_id,h.wallet,h.gross_amount FROM child_trade_holds h WHERE h.status='active'
 UNION ALL
 SELECT f.transaction_id,t.payer_id,f.wallet,f.gross_amount FROM child_trade_funding f JOIN child_trade_transactions t ON t.id=f.transaction_id WHERE f.hold_status='active';
CREATE TRIGGER IF NOT EXISTS child_trade_split_hold_balance BEFORE UPDATE OF value_json ON family_state
WHEN NEW.state_key='allowance_ledger'
BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM child_trade_all_holds h JOIN child_trade_transactions t ON t.id=h.transaction_id JOIN members m ON m.id=h.owner_id
  WHERE t.family_id=NEW.family_id GROUP BY h.owner_id,h.wallet
  HAVING SUM(h.gross_amount)>
   COALESCE((SELECT SUM(CASE json_extract(r.value,'$.type') WHEN 'income' THEN json_extract(r.value,'$.amount') WHEN 'expense' THEN -json_extract(r.value,'$.amount') ELSE 0 END) FROM json_each(NEW.value_json) c,json_each(c.value) r WHERE c.key=m.name AND json_extract(r.value,'$.wallet')=h.wallet AND COALESCE(json_extract(r.value,'$.status'),'approved')='approved'),0)
   +CASE WHEN h.wallet='minus' THEN COALESCE((SELECT CAST(json_extract(s.value_json,'$."'||m.name||'"') AS INTEGER) FROM family_state s WHERE s.family_id=NEW.family_id AND s.state_key='allowance_limits'),0) ELSE 0 END
 ) THEN RAISE(ABORT,'reserved split funds cannot be spent') END;
END;
CREATE TRIGGER IF NOT EXISTS child_trade_split_hold_limit BEFORE UPDATE OF value_json ON family_state
WHEN NEW.state_key='allowance_limits'
BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM child_trade_all_holds h JOIN child_trade_transactions t ON t.id=h.transaction_id JOIN members m ON m.id=h.owner_id
  WHERE t.family_id=NEW.family_id AND h.wallet='minus' GROUP BY h.owner_id
  HAVING SUM(h.gross_amount)>COALESCE(CAST(json_extract(NEW.value_json,'$."'||m.name||'"') AS INTEGER),0)
   +COALESCE((SELECT SUM(CASE json_extract(r.value,'$.type') WHEN 'income' THEN json_extract(r.value,'$.amount') WHEN 'expense' THEN -json_extract(r.value,'$.amount') ELSE 0 END) FROM family_state s,json_each(s.value_json) c,json_each(c.value) r WHERE s.family_id=NEW.family_id AND s.state_key='allowance_ledger' AND c.key=m.name AND json_extract(r.value,'$.wallet')='minus' AND COALESCE(json_extract(r.value,'$.status'),'approved')='approved'),0)
 ) THEN RAISE(ABORT,'reserved split minus limit cannot be reduced') END;
END;
