#!/usr/bin/env python3
"""
Import Hibret Edir waiting list from local board export (gitignored).

Expected file (never commit):
  data/Hibret Waiting list.xlsx

Columns: Name, Email, Phone, Address, Referred By, Message, Submitted Date

Usage:
  python scripts/import_waiting_list.py --dry-run
  python scripts/import_waiting_list.py --seed
  DATABASE_URL=postgres://... python scripts/import_waiting_list.py --seed
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WAITING_LIST_XLSX = DATA / "Hibret Waiting list.xlsx"
WIX_URL = "https://www.hibretedir.com/yourwaitinglist"
CONNECT_TIMEOUT_SEC = 10
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def require_openpyxl():
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        import subprocess

        subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "-q"])
    import openpyxl

    return openpyxl


def require_psycopg():
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        import subprocess

        subprocess.check_call([sys.executable, "-m", "pip", "install", "psycopg2-binary", "-q"])
    import psycopg2

    return psycopg2


def clean_text(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_name_key(name: str | None) -> str:
    text = (name or "").lower()
    text = re.sub(r"\([^)]*\)", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_phone(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, float):
        if value != value:  # NaN
            return None
        if abs(value) >= 1e12:
            return None
        value = str(int(value)) if float(value).is_integer() else str(value)
    text = str(value).strip()
    if not text or text.lower() == "none":
        return None
    digits = re.sub(r"\D", "", text)
    if len(digits) < 10:
        return text if text else None
    last10 = digits[-10:]
    return f"({last10[:3]}) {last10[3:6]}-{last10[6:]}"


def split_name(full: str | None) -> tuple[str | None, str | None]:
    text = clean_text(full)
    if not text:
        return None, None
    text = re.sub(r"\s*\([^)]*\)\s*", " ", text).strip()
    parts = text.split()
    if len(parts) == 1:
        return parts[0], None
    return parts[0], " ".join(parts[1:])


def parse_submitted(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = clean_text(value)
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%B %d, %Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def format_public_date(d: date | None) -> str | None:
    if not d:
        return None
    return d.strftime("%B %d, %Y")


def fetch_wix_status_map() -> dict[str, str]:
    """Optional: merge Registered/Canceled labels from legacy public Wix page."""
    try:
        req = urllib.request.Request(
            WIX_URL,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html"},
        )
        with urllib.request.urlopen(req, timeout=CONNECT_TIMEOUT_SEC) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        return {}

    import html as htmlmod

    m = re.search(
        r'<script type="application/json" id="wix-warmup-data">(.*?)</script>',
        html,
        re.S,
    )
    if not m:
        return {}

    data = json.loads(m.group(1))
    merged: dict = {}
    for upd in data.get("platform", {}).get("ssrPropsUpdates", []):
        merged.update(upd)

    item_ids = merged.get("comp-m7jpl32w2", {}).get("items") or []
    status_map: dict[str, str] = {}
    for item_id in item_ids:
        raw = merged.get(f"comp-m7jpl335__{item_id}", {}).get("html", "")
        name = htmlmod.unescape(re.sub(r"<[^>]+>", " ", raw))
        name = re.sub(r"\s+", " ", name).strip()
        if not name:
            continue
        label = "Pending"
        if re.search(r"\(registered\)", name, re.I):
            label = "Registered"
        elif re.search(r"\(cancel+ed\)", name, re.I):
            label = "Canceled"
        clean = re.sub(r"\([^)]*\)", "", name, flags=re.I).strip()
        status_map[normalize_name_key(clean)] = label
    return status_map


def load_xlsx(path: Path, merge_wix_status: bool) -> list[dict]:
    openpyxl = require_openpyxl()
    if not path.exists():
        raise FileNotFoundError(f"Waiting list export not found: {path}")

    wix_status = fetch_wix_status_map() if merge_wix_status else {}
    if wix_status:
        print(f"Merged public status labels for {len(wix_status)} names from Wix.")

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    wb.close()

    if not rows:
        return []

    header = [clean_text(c) or "" for c in rows[0]]
    col = {name.lower(): idx for idx, name in enumerate(header)}

    def cell(row, *names, default=None):
        for name in names:
            idx = col.get(name.lower())
            if idx is not None and idx < len(row):
                return row[idx]
        return default

    entries: list[dict] = []
    for row in rows[1:]:
        if not row or not any(row):
            continue
        name = clean_text(cell(row, "name"))
        if not name:
            continue

        submitted = parse_submitted(cell(row, "submitted date", "submission time"))
        display_name = re.sub(r"\s*\([^)]*\)\s*", " ", name).strip()
        status = wix_status.get(normalize_name_key(display_name), "Pending")
        first, last = split_name(name)

        email_raw = clean_text(cell(row, "email"))
        entries.append(
            {
                "position": len(entries) + 1,
                "display_name": display_name,
                "name_raw": name,
                "first_name": first,
                "last_name": last,
                "full_name": display_name,
                "email": email_raw.lower() if email_raw else None,
                "phone": normalize_phone(cell(row, "phone")),
                "address": clean_text(cell(row, "address")),
                "referred_by": clean_text(cell(row, "referred by")),
                "message": clean_text(cell(row, "message")),
                "applied_at": submitted.isoformat() if submitted else None,
                "applied_date_text": format_public_date(submitted),
                "status_label": status,
                "status": status,
                "applicant_role": "primary",
            }
        )

    entries.sort(key=lambda e: (e.get("applied_at") or "9999-99-99", e.get("position", 0)))
    for idx, entry in enumerate(entries, start=1):
        entry["position"] = idx
        entry["queue_position"] = idx
    return entries


def normalize_for_db(row: dict) -> dict:
    note_parts = [f"Imported from board waiting list export #{row['queue_position']}."]
    if row.get("message"):
        note_parts.append(f"Message: {row['message']}")
    return {
        "first_name": row.get("first_name"),
        "last_name": row.get("last_name"),
        "full_name": row.get("full_name"),
        "email": row.get("email"),
        "phone": row.get("phone"),
        "address": row.get("address"),
        "referred_by": row.get("referred_by"),
        "family_members": None,
        "applicant_role": "primary",
        "status": row.get("status") or "Pending",
        "applied_at": row.get("applied_at"),
        "notes": " ".join(note_parts),
        "queue_position": row.get("queue_position"),
    }


PUBLIC_WAITING_LIST_JSON = ROOT / "public" / "waiting-list-public.json"
HIDDEN_PUBLIC_STATUSES = frozenset({"Rejected", "Canceled"})
# Queue places 1–11 have joined as members (through Martha Mekonnen).
ADDED_THROUGH_POSITION = 11


def export_public_entries(entries: list[dict]) -> list[dict]:
    """Public queue: place #, name, date applied only (no email/phone/status)."""
    public: list[dict] = []
    for entry in entries:
        if (entry.get("status") or "Pending") in HIDDEN_PUBLIC_STATUSES:
            continue
        pos = entry.get("position")
        public.append(
            {
                "position": pos,
                "display_name": entry.get("display_name"),
                "applied_date_text": entry.get("applied_date_text"),
                "added": isinstance(pos, int) and pos <= ADDED_THROUGH_POSITION,
            }
        )
    return public


def write_public_json(entries: list[dict]) -> Path:
    public = export_public_entries(entries)
    payload = {
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "added_through_position": ADDED_THROUGH_POSITION,
        "count": len(public),
        "note": f"Places 1–{ADDED_THROUGH_POSITION} have been added as members. #12 is next in line.",
        "entries": public,
    }
    PUBLIC_WAITING_LIST_JSON.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_WAITING_LIST_JSON.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return PUBLIC_WAITING_LIST_JSON


def upsert_waiting_list(conn, rows: list[dict], dry_run: bool) -> tuple[int, int, int]:
    inserted = 0
    updated = 0
    skipped = 0

    insert_sql = """
        INSERT INTO waiting_list (
          first_name, last_name, full_name, email, phone, address,
          referred_by, applicant_role, status, applied_at, notes
        ) VALUES (
          %(first_name)s, %(last_name)s, %(full_name)s, %(email)s, %(phone)s, %(address)s,
          %(referred_by)s, %(applicant_role)s, %(status)s,
          COALESCE(%(applied_at)s::date, CURRENT_DATE), %(notes)s
        )
    """
    update_sql = """
        UPDATE waiting_list SET
          first_name = %(first_name)s,
          last_name = %(last_name)s,
          full_name = %(full_name)s,
          phone = %(phone)s,
          address = %(address)s,
          referred_by = %(referred_by)s,
          status = %(status)s,
          applied_at = COALESCE(%(applied_at)s::date, applied_at),
          notes = %(notes)s
        WHERE id = %(id)s
    """
    find_sql = """
        SELECT id FROM waiting_list
        WHERE (email IS NOT NULL AND LOWER(email) = LOWER(%(email)s))
           OR (
             %(phone)s IS NOT NULL
             AND phone IS NOT NULL
             AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10)
               = RIGHT(REGEXP_REPLACE(%(phone)s, '[^0-9]', '', 'g'), 10)
           )
        LIMIT 1
    """

    with conn.cursor() as cur:
        for row in rows:
            payload = normalize_for_db(row)
            if not payload.get("email") and not payload.get("phone"):
                skipped += 1
                if dry_run:
                    print(f"[dry-run skip] #{payload['queue_position']} {payload.get('full_name')} (no email/phone)")
                continue

            cur.execute(find_sql, {"email": payload.get("email"), "phone": payload.get("phone")})
            existing = cur.fetchone()

            if dry_run:
                action = "update" if existing else "insert"
                print(
                    f"[dry-run {action}] #{payload['queue_position']} "
                    f"{payload.get('full_name')} <{payload.get('email')}> ({payload.get('status')})"
                )
                if existing:
                    updated += 1
                else:
                    inserted += 1
                continue

            if existing:
                payload["id"] = existing[0]
                cur.execute(update_sql, payload)
                updated += 1
            else:
                cur.execute(insert_sql, payload)
                inserted += 1

        if not dry_run:
            conn.commit()
    return inserted, updated, skipped


def main():
    parser = argparse.ArgumentParser(description="Import waiting list from local Excel export")
    parser.add_argument(
        "--file",
        default=str(WAITING_LIST_XLSX),
        help="Path to Hibret Waiting list.xlsx",
    )
    parser.add_argument("--dry-run", action="store_true", help="Parse only; optional DB preview")
    parser.add_argument("--seed", action="store_true", help="Upsert into DATABASE_URL")
    parser.add_argument(
        "--merge-wix-status",
        action="store_true",
        help="Pull Registered/Canceled labels from legacy public Wix page (names only)",
    )
    parser.add_argument(
        "--output",
        default=str(DATA / "waiting_list_import.json"),
        help="Write parsed JSON preview (gitignored data/)",
    )
    args = parser.parse_args()

    path = Path(args.file)
    print(f"Reading {path.name} ...")
    try:
        entries = load_xlsx(path, merge_wix_status=args.merge_wix_status)
    except FileNotFoundError as err:
        print(err)
        sys.exit(1)

    print(f"Parsed {len(entries)} waiting list entries.")
    with_email = sum(1 for e in entries if e.get("email"))
    with_phone = sum(1 for e in entries if e.get("phone"))
    print(f"  {with_email} with email, {with_phone} with phone")

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "source": str(path),
                "imported_at": datetime.utcnow().isoformat() + "Z",
                "count": len(entries),
                "entries": entries,
            },
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )
    print(f"Wrote preview (gitignored): {out_path.name}")

    public_path = write_public_json(entries)
    print(f"Wrote public status file: {public_path.relative_to(ROOT)} ({len(export_public_entries(entries))} names)")

    if args.seed or (args.dry_run and os.environ.get("DATABASE_URL")):
        db_url = os.environ.get("DATABASE_URL")
        if not db_url:
            print("DATABASE_URL not set — skipping DB seed.")
            return

        psycopg2 = require_psycopg()
        conn = psycopg2.connect(db_url, connect_timeout=CONNECT_TIMEOUT_SEC)
        try:
            inserted, updated, skipped = upsert_waiting_list(
                conn, entries, dry_run=args.dry_run and not args.seed
            )
            if args.dry_run and not args.seed:
                print(f"Would insert: {inserted}; would update: {updated}; skipped: {skipped}")
            else:
                print(f"Inserted: {inserted}; updated: {updated}; skipped: {skipped}")
        finally:
            conn.close()
    elif args.seed:
        print("DATABASE_URL not set.")
        sys.exit(1)


if __name__ == "__main__":
    main()
