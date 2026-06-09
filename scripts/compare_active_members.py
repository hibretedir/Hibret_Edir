"""Compare Excel active member count vs PostgreSQL."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import openpyxl
from seed_from_exports import load_env_file, load_members, require_psycopg

load_env_file()


def main():
    members = load_members(openpyxl)
    excel_active = [m for m in members if m.get("status") == "Active"]
    print(f"Excel active: {len(excel_active)}  total: {len(members)}")

    psycopg2 = require_psycopg()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL missing")
        return 1

    kwargs = {}
    if "render.com" in db_url:
        kwargs["sslmode"] = "require"

    conn = psycopg2.connect(db_url, **kwargs)
    cur = conn.cursor()
    cur.execute("SELECT status, COUNT(*) FROM members GROUP BY status ORDER BY status")
    print("DB by status:", cur.fetchall())
    cur.execute("SELECT COUNT(*) FROM members WHERE status = %s", ("Active",))
    print("DB active:", cur.fetchone()[0])
    cur.execute(
        "SELECT member_number, status, full_name FROM members ORDER BY member_number NULLS LAST"
    )
    db_rows = cur.fetchall()
    cur.close()
    conn.close()

    excel_by_num = {m["member_number"]: m for m in members if m.get("member_number") is not None}
    db_by_num = {r[0]: r for r in db_rows if r[0] is not None}

    missing = []
    for num, m in excel_by_num.items():
        if m.get("status") != "Active":
            continue
        db = db_by_num.get(num)
        if not db:
            missing.append(("not in db", num, m.get("full_name")))
        elif db[1] != "Active":
            missing.append(("wrong status", num, m.get("full_name"), db[1]))

    print(f"\nActive in Excel but missing/wrong in DB: {len(missing)}")
    for row in missing:
        print(" ", row)

    extra = [r for num, r in db_by_num.items() if num not in excel_by_num]
    print(f"\nIn DB but not in Excel by member_number: {len(extra)}")
    for row in extra[:15]:
        print(" ", row)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
