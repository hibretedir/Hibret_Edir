#!/usr/bin/env python3
"""
Apply approved joined_date updates from data/joined_dates - review.xlsx.

Updates rows where your_ok = Y and db_member_number is set.
Skips QA test email rows.

Usage:
  python scripts/apply_joined_date_updates.py           # dry-run
  python scripts/apply_joined_date_updates.py --apply
"""
from __future__ import annotations

import csv
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
REVIEW_XLSX = DATA / "joined_dates - review.xlsx"

sys.path.insert(0, str(ROOT / "scripts"))
from seed_from_exports import load_env_file, require_openpyxl, require_psycopg

load_env_file()

QA_EMAIL = "hibretedirtest@gmail.com"
CONNECT_TIMEOUT_SEC = 15


def parse_date(value) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def load_updates(openpyxl) -> list[dict]:
    if not REVIEW_XLSX.exists():
        raise SystemExit(f"Missing {REVIEW_XLSX} — run annotate_joined_date_review.py first")
    wb = openpyxl.load_workbook(REVIEW_XLSX, read_only=True, data_only=True)
    if "Review" not in wb.sheetnames:
        wb.close()
        raise SystemExit("Review sheet missing")
    ws = wb["Review"]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if not rows:
        return []

    headers = [str(h or "").strip() for h in rows[0]]
    col = {h: i for i, h in enumerate(headers)}
    required = ["excel_joined", "db_member_number", "your_ok"]
    for r in required:
        if r not in col:
            raise SystemExit(f"Missing column {r} in Review sheet")

    updates = []
    for r in rows[1:]:
        if not r:
            continue
        ok = str(r[col["your_ok"]] or "").strip().upper()
        if ok != "Y":
            continue
        member_number = r[col["db_member_number"]]
        joined = parse_date(r[col["excel_joined"]])
        if member_number is None or member_number == "" or not joined:
            continue
        updates.append(
            {
                "member_number": int(member_number),
                "excel_name": r[col.get("excel_name", 1)] if "excel_name" in col else "",
                "paypal_name": r[col["db_paypal_name"]] if "db_paypal_name" in col else "",
                "old_joined": r[col["db_joined_date"]] if "db_joined_date" in col else "",
                "new_joined": joined,
                "match_type": r[col["match_type"]] if "match_type" in col else "",
                "action": r[col["action"]] if "action" in col else "",
            }
        )
    return updates


def backup_members(cur, path: Path, member_numbers: list[int]) -> None:
    cur.execute(
        """
        SELECT id, member_number, paypal_name, full_name, status, joined_date, email
        FROM members
        WHERE member_number = ANY(%s)
        ORDER BY member_number
        """,
        (member_numbers,),
    )
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)


def main() -> int:
    apply = "--apply" in sys.argv
    openpyxl = require_openpyxl()
    updates = load_updates(openpyxl)
    if not updates:
        print("No updates to apply (your_ok=Y rows with date + member #).")
        return 0

    print(f"{'APPLY' if apply else 'DRY-RUN'}: {len(updates)} joined_date updates")
    for u in updates[:15]:
        print(
            f"  #{u['member_number']} {u['paypal_name'] or u['excel_name']}: "
            f"{u['old_joined'] or 'NULL'} -> {u['new_joined']}"
        )
    if len(updates) > 15:
        print(f"  ... +{len(updates) - 15} more")

    if not apply:
        print("Re-run with --apply to write to Render.")
        return 0

    psycopg2 = require_psycopg()
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL missing")
    kwargs = {"connect_timeout": CONNECT_TIMEOUT_SEC}
    if "render.com" in url:
        kwargs["sslmode"] = "require"

    conn = psycopg2.connect(url, **kwargs)
    conn.autocommit = False
    try:
        cur = conn.cursor()
        member_numbers = [u["member_number"] for u in updates]
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_path = DATA / f"joined_date_backup_{stamp}.csv"
        backup_members(cur, backup_path, member_numbers)
        print(f"Backup: {backup_path}")

        updated = 0
        skipped = 0
        for u in updates:
            cur.execute(
                """
                SELECT id, email, joined_date, paypal_name
                FROM members
                WHERE member_number = %s
                """,
                (u["member_number"],),
            )
            row = cur.fetchone()
            if not row:
                print(f"  skip missing member_number={u['member_number']}")
                skipped += 1
                continue
            member_id, email, _old, paypal = row
            if email and str(email).strip().lower() == QA_EMAIL:
                print(f"  skip QA #{u['member_number']}")
                skipped += 1
                continue
            cur.execute(
                """
                UPDATE members
                SET joined_date = %s, updated_at = NOW()
                WHERE id = %s
                """,
                (u["new_joined"], member_id),
            )
            updated += 1
            print(f"  updated #{u['member_number']} {paypal or u['excel_name']} -> {u['new_joined']}")

        conn.commit()
        cur.close()
        print(f"Done. updated={updated} skipped={skipped}")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
