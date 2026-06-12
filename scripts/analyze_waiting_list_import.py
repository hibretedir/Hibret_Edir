#!/usr/bin/env python3
"""Compare a waiting list Excel file against the database queue."""

from __future__ import annotations

import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from import_waiting_list import (  # noqa: E402
    load_xlsx,
    normalize_for_db,
    normalize_name_key,
    require_psycopg,
    upsert_waiting_list,
)

ENV_PATH = ROOT / ".env"
DEFAULT_FILE = ROOT / "data" / "waiting list with phone and email.xlsx"


def load_env() -> None:
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def main() -> None:
    load_env()
    file_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_FILE
    if not file_path.exists():
        print(f"File not found: {file_path}")
        sys.exit(1)

    entries = load_xlsx(file_path, merge_wix_status=False)
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set — Excel parse only.")
        print(f"Excel rows: {len(entries)}")
        with_email = sum(1 for e in entries if e.get("email"))
        with_phone = sum(1 for e in entries if e.get("phone"))
        print(f"  {with_email} with email, {with_phone} with phone")
        sys.exit(0)

    psycopg2 = require_psycopg()
    conn = psycopg2.connect(db_url, connect_timeout=10)
    cur = conn.cursor()
    cur.execute(
        "SELECT id, full_name, email, phone, status FROM waiting_list "
        "ORDER BY applied_at ASC NULLS LAST, id ASC"
    )
    db_rows = cur.fetchall()

    db_by_name: dict[str, dict] = {}
    for rid, full, email, phone, status in db_rows:
        key = normalize_name_key(full)
        if key and key not in db_by_name:
            db_by_name[key] = {
                "id": rid,
                "full_name": full,
                "email": email,
                "phone": phone,
                "status": status,
            }

    excel_keys = set()
    unmatched_excel: list[str] = []
    matched: list[tuple[str, str]] = []
    for entry in entries:
        name = entry.get("full_name") or entry.get("display_name")
        key = normalize_name_key(name)
        excel_keys.add(key)
        if key in db_by_name:
            matched.append((name, db_by_name[key]["full_name"]))
        else:
            unmatched_excel.append(name or "—")

    db_only = [
        info["full_name"]
        for key, info in db_by_name.items()
        if key not in excel_keys
    ]

    emails = [str(e.get("email") or "").lower().strip() for e in entries if e.get("email")]
    email_dups = [email for email, count in Counter(emails).items() if count > 1]

    phones = []
    for entry in entries:
        payload = normalize_for_db(entry)
        digits = "".join(ch for ch in str(payload.get("phone") or "") if ch.isdigit())[-10:]
        if digits:
            phones.append(digits)
    phone_dups = [phone for phone, count in Counter(phones).items() if count > 1]

    print("=== Waiting list import check ===")
    print(f"File: {file_path.name}")
    print(f"Excel rows: {len(entries)}")
    print(f"DB rows: {len(db_rows)}")
    print(f"Matched by name: {len(matched)}")
    print(f"In Excel only (would insert): {len(unmatched_excel)}")
    print(f"In DB only (would remain unless cleaned): {len(db_only)}")
    print(f"Duplicate emails in Excel: {len(email_dups)}")
    print(f"Duplicate phones in Excel: {len(phone_dups)}")

    if unmatched_excel:
        print("\nExcel names not in DB:")
        for name in unmatched_excel:
            print(f"  + {name}")

    if db_only:
        print("\nDB names not in Excel (likely removed duplicates / old seed-only rows):")
        for name in db_only:
            print(f"  - {name}")

    if email_dups:
        print("\nShared email addresses in Excel:")
        for email in email_dups:
            names = [
                e.get("full_name")
                for e in entries
                if str(e.get("email") or "").lower().strip() == email
            ]
            print(f"  {email} → {', '.join(names)}")

    if phone_dups:
        print("\nShared phone numbers in Excel:")
        for phone in phone_dups:
            names = []
            for entry in entries:
                payload = normalize_for_db(entry)
                digits = "".join(ch for ch in str(payload.get("phone") or "") if ch.isdigit())[-10:]
                if digits == phone:
                    names.append(payload.get("full_name"))
            print(f"  {phone} → {', '.join(names)}")

    print("\n=== Dry-run upsert preview ===")
    inserted, updated, skipped = upsert_waiting_list(conn, entries, dry_run=True)
    print(f"Would insert: {inserted}; would update: {updated}; skipped (no contact): {skipped}")

    conn.close()


if __name__ == "__main__":
    main()
