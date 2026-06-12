#!/usr/bin/env python3
import os
from pathlib import Path
import psycopg2

ROOT = Path(__file__).resolve().parents[1]
for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

conn = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=10)
cur = conn.cursor()
cur.execute(
    "SELECT id, full_name, email FROM waiting_list WHERE email LIKE '%@import.local'"
)
print("placeholder rows:", cur.fetchall())
cur.execute("SELECT COUNT(*)::int FROM waiting_list")
print("total rows:", cur.fetchone()[0])
cur.execute("SELECT COUNT(*)::int FROM waiting_list WHERE email LIKE '%@import.local'")
print("placeholder emails:", cur.fetchone()[0])
cur.execute(
    "SELECT full_name, email, status FROM waiting_list "
    "WHERE status IN ('Registered','Pending') ORDER BY applied_at ASC NULLS LAST, id ASC LIMIT 5"
)
print("top 5 queue:")
for row in cur.fetchall():
    print(" ", row)
cur.execute(
    "SELECT full_name, status FROM waiting_list "
    "WHERE LOWER(full_name) LIKE '%senait%' OR LOWER(full_name) LIKE '%kidus brook%'"
)
print("canceled check:", cur.fetchall())
conn.close()
