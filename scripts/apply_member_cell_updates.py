#!/usr/bin/env python3
"""
Apply approved mobile updates from members cell number - review.xlsx.

Updates rows where match_type != no_match and phone_same = N.
Skips QA test rows only. Shared mobile numbers across members are allowed
(e.g. family member manages portal for a parent).

Usage:
  python scripts/apply_member_cell_updates.py           # dry-run
  python scripts/apply_member_cell_updates.py --apply
"""
from __future__ import annotations

import csv
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
REVIEW_XLSX = DATA / "members cell number - review.xlsx"

sys.path.insert(0, str(ROOT / "scripts"))
from seed_from_exports import load_env_file, normalize_phone, require_openpyxl, require_psycopg

load_env_file()

QA_EMAIL = "hibretedirtest@gmail.com"
CONNECT_TIMEOUT_SEC = 15


def phone_digits(value) -> str:
    if not value:
        return ""
    d = re.sub(r"\D", "", str(value))
    return d[-10:] if len(d) >= 10 else d


def load_updates(openpyxl) -> list[dict]:
    if not REVIEW_XLSX.exists():
        raise SystemExit(f"Missing {REVIEW_XLSX} — run annotate_member_cell_review.py first")
    wb = openpyxl.load_workbook(REVIEW_XLSX, read_only=True, data_only=True)
    ws = wb["Review"]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if not rows:
        return []

    updates = []
    for r in rows[1:]:
        if len(r) < 12:
            continue
        given, surname, excel_phone = r[0], r[1], r[2]
        member_number, paypal_name = r[3], r[4]
        db_mobile = r[6]
        match_type, phone_same = r[10], r[11]
        if match_type == "no_match" or phone_same != "N" or not member_number:
            continue
        new_mobile = normalize_phone(excel_phone)
        if not new_mobile:
            continue
        updates.append(
            {
                "member_number": int(member_number),
                "paypal_name": paypal_name,
                "excel_name": f"{given or ''} {surname or ''}".strip(),
                "old_mobile": db_mobile,
                "new_mobile": new_mobile,
                "match_type": match_type,
            }
        )
    return updates


def backup_members(cur, path: Path, member_numbers: list[int]) -> None:
    cur.execute(
        """
        SELECT id, member_number, paypal_name, full_name, mobile, home_phone, email, status
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
        print("No updates to apply.")
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
        backup_path = DATA / f"mobile_backup_{stamp}.csv"
        backup_members(cur, backup_path, member_numbers)
        print(f"Backup: {backup_path} ({len(member_numbers)} members)")

        applied = 0
        skipped = []

        for u in updates:
            num = u["member_number"]
            new_digits = phone_digits(u["new_mobile"])

            cur.execute(
                """
                SELECT id, member_number, paypal_name, full_name, mobile, email, status
                FROM members WHERE member_number = %s
                """,
                (num,),
            )
            row = cur.fetchone()
            if not row:
                skipped.append((num, "member not found"))
                continue
            (
                member_id,
                _num,
                paypal_name,
                full_name,
                old_mobile,
                email,
                status,
            ) = row

            if email and str(email).lower() == QA_EMAIL.lower():
                skipped.append((num, "QA test member"))
                continue
            if "qa test" in str(full_name or "").lower():
                skipped.append((num, "QA test member"))
                continue

            if new_digits:
                cur.execute(
                    """
                    SELECT member_number, paypal_name
                    FROM members
                    WHERE member_number <> %s
                      AND RIGHT(REGEXP_REPLACE(COALESCE(mobile, ''), '[^0-9]', '', 'g'), 10) = %s
                    """,
                    (num, new_digits),
                )
                shared = cur.fetchall()
                if shared:
                    others = ", ".join(f"#{r[0]} {r[1]}" for r in shared)
                    print(f"  (shared phone — also on {others})")

            label = paypal_name or full_name or u["excel_name"]
            print(
                f"{'UPDATE' if apply else 'WOULD'} #{num} {label}: "
                f"{old_mobile or '(empty)'} -> {u['new_mobile']}"
            )

            if apply:
                note = f"[Board] Mobile updated from PayPal cell list ({u['new_mobile']})."
                cur.execute(
                    """
                    UPDATE members
                    SET mobile = %s,
                        updated_at = NOW(),
                        notes = CASE
                          WHEN notes IS NULL OR BTRIM(notes) = '' THEN %s
                          ELSE notes || E'\\n' || %s
                        END
                    WHERE id = %s
                    """,
                    (u["new_mobile"], note, note, member_id),
                )
                applied += 1

        if apply:
            conn.commit()
            print(f"\nApplied {applied} mobile update(s).")
        else:
            conn.rollback()
            print(f"\nDry run — {len(updates) - len(skipped)} would update, {len(skipped)} skipped.")

        if skipped:
            print("Skipped:")
            for num, reason in skipped:
                print(f"  #{num}: {reason}")

        return 0
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
