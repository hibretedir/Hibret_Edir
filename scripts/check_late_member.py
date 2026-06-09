"""Debug late invoice counts for a member."""
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(__file__))
from seed_from_exports import load_env_file, require_psycopg

load_env_file()
conn = require_psycopg().connect(os.environ["DATABASE_URL"], sslmode="require", connect_timeout=15)
cur = conn.cursor()

name = sys.argv[1] if len(sys.argv) > 1 else "asnakech"
cur.execute(
    """
    SELECT id, member_number, first_name, last_name, full_name, paypal_name, email
    FROM members
    WHERE full_name ILIKE %s OR paypal_name ILIKE %s OR first_name ILIKE %s
    """,
    (f"%{name}%", f"%{name}%", f"%{name}%"),
)
members = cur.fetchall()
print("Members:", len(members))
for m in members:
    print(" ", m)

today = date.today()

for m in members:
    mid = m[0]
    cur.execute(
        """
        SELECT DISTINCT ON (invoice_number)
          invoice_number, status, sent_date, amount_due, recipient_name, member_id
        FROM invoices
        WHERE member_id = %s AND invoice_number IS NOT NULL
        ORDER BY invoice_number,
          (CASE WHEN recipient_name IS NOT NULL AND TRIM(recipient_name) <> '' THEN 0 ELSE 1 END),
          updated_at DESC NULLS LAST, id DESC
        """,
        (mid,),
    )
    invs = cur.fetchall()
    print(f"\nMember #{m[1]} id={mid} — deduped invoices: {len(invs)}")
    late = []
    unpaid = []
    for inv in invs:
        st = (inv[1] or "").lower()
        if st == "paid":
            continue
        unpaid.append(inv)
        sd = inv[2]
        if sd:
            due = sd + timedelta(days=3)
            days = (today - due).days
            if days > 0:
                late.append((inv, days))
    print("Unpaid:", len(unpaid), "Late:", len(late))
    for inv, days in late:
        print(f"  LATE #{inv[0]} {inv[4]!r} sent={inv[2]} overdue={days}d status={inv[1]}")

# Name-based matching (how admin UI might over-count)
paypal = members[0][5] if members else ""
email = members[0][6] if members else ""
cur.execute(
    """
    SELECT invoice_number, status, sent_date, recipient_name, member_id, member_id
    FROM invoices i
    LEFT JOIN members m ON m.id = i.member_id
    WHERE LOWER(COALESCE(i.recipient_name, m.paypal_name, m.full_name, '')) LIKE %s
       OR LOWER(COALESCE(m.email, '')) = LOWER(%s)
    ORDER BY invoice_number
    """,
    (f"%{name.lower()}%", email or ""),
)
rows = cur.fetchall()
print(f"\nLoose name/email match rows (no dedupe): {len(rows)}")

cur.close()
conn.close()
