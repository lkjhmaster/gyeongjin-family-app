import sqlite3
from pathlib import Path

schema = Path('migrations/child-trades/0001_additive_schema.sql').read_text()
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
db.execute('CREATE TABLE families(id TEXT PRIMARY KEY)')
db.execute("INSERT INTO families VALUES ('f')")
db.executescript(schema)
fields = ('id','family_id','kind','requester_id','counterparty_id','payer_id','payee_id','source_wallet','destination_wallet','gross_amount','fee_amount','net_amount','status','revision','due_date','created_at','updated_at')
def add(tid, borrower, status):
    vals=(tid,'f','loan',borrower,'lender','lender',borrower,'card','free',1000,500,500,status,0,None,'2026-10-18','2026-10-18')
    db.execute('INSERT INTO child_trade_transactions ('+','.join(fields)+') VALUES ('+','.join('?' for _ in fields)+')',vals)
add('a','child','requested')
try:
    add('b','child','requested')
    raise AssertionError('duplicate pending loan allowed')
except sqlite3.IntegrityError:
    pass
add('c','other','requested')
db.execute("UPDATE child_trade_transactions SET status='cancelled' WHERE id='a'")
add('d','child','requested')
print('PASS: schema loads; same-child duplicate rejected; different child allowed; cancelled request releases slot')
