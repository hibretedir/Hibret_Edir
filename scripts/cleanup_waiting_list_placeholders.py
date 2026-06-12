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
cur.execute("DELETE FROM waiting_list WHERE email LIKE '%@import.local'")
print("deleted placeholder rows:", cur.rowcount)
conn.commit()
cur.execute("SELECT COUNT(*)::int FROM waiting_list")
print("total rows:", cur.fetchone()[0])
conn.close()
