#!/usr/bin/env python3
"""
Fix same-day waiting list order using registration order numbers from
data/Order of Registration.xlsx (tie-breaker only; file may contain duplicates).

Usage:
  python scripts/fix_waiting_list_order.py --dry-run
  python scripts/fix_waiting_list_order.py --apply
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
ORDER_XLSX = ROOT / "data" / "Order of Registration.xlsx"
CONNECT_TIMEOUT_SEC = 10


def load_env_file() -> None:
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


def load_registration_order(path: Path) -> dict[str, int]:
    """Map normalized name -> best (lowest) registration order number."""
    openpyxl = require_openpyxl()
    if not path.exists():
        raise FileNotFoundError(path)

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if not rows:
        return {}

    header = [clean_text(c) or "" for c in rows[0]]
    col = {name.lower(): idx for idx, name in enumerate(header)}

    def cell(row, *names, default=None):
        for name in names:
            idx = col.get(name.lower())
            if idx is not None and idx < len(row):
                return row[idx]
        return default

    order_by_name: dict[str, int] = {}
    for row in rows[1:]:
        if not row or not any(row):
            continue
        name = clean_text(cell(row, "name", "full name", "display name"))
        if not name:
            continue
        display_name = re.sub(r"\s*\([^)]*\)\s*", " ", name).strip()
        key = normalize_name_key(display_name)
        if not key:
            continue

        order_raw = cell(row, "order", "#", "number", "position", "registration order", "no", "no.")
        order_num = None
        if order_raw is not None:
            text = clean_text(str(order_raw).rstrip("."))
            if text and text.isdigit():
                order_num = int(text)
        if order_num is None:
            # First column is often the order number
            first = row[0]
            if isinstance(first, (int, float)) and not isinstance(first, bool):
                order_num = int(first)
            elif clean_text(first) and str(clean_text(first)).isdigit():
                order_num = int(clean_text(first))

        if order_num is None:
            continue

        prev = order_by_name.get(key)
        if prev is None or order_num < prev:
            order_by_name[key] = order_num

    return order_by_name


def applied_at_date(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return None


def compute_applied_at(day: date, order_num: int) -> datetime:
    """Preserve calendar day; use order number as intraday tie-breaker (PT noon base)."""
    base = datetime(day.year, day.month, day.day, 12, 0, 0, tzinfo=timezone.utc)
    return base + timedelta(seconds=order_num)


def main() -> None:
    load_env_file()
    parser = argparse.ArgumentParser(description="Fix same-day waiting list order from registration file")
    parser.add_argument("--file", default=str(ORDER_XLSX))
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--apply", action="store_true", help="Write applied_at fixes to DB")
    args = parser.parse_args()
    apply = args.apply

    order_by_name = load_registration_order(Path(args.file))
    print(f"Loaded {len(order_by_name)} unique names with order numbers from {Path(args.file).name}")

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set")
        sys.exit(1)

    psycopg2 = require_psycopg()
    conn = psycopg2.connect(db_url, connect_timeout=CONNECT_TIMEOUT_SEC)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, full_name, applied_at, status FROM waiting_list "
                "ORDER BY applied_at ASC NULLS LAST, id ASC"
            )
            rows = cur.fetchall()

        by_day: dict[date | None, list] = defaultdict(list)
        for row_id, full_name, applied_at, status in rows:
            by_day[applied_at_date(applied_at)].append(
                {
                    "id": row_id,
                    "full_name": full_name,
                    "applied_at": applied_at,
                    "status": status,
                    "order": order_by_name.get(normalize_name_key(full_name)),
                }
            )

        updates: list[tuple[datetime, int, str, datetime | None]] = []
        same_day_groups = 0
        for day, group in sorted(by_day.items(), key=lambda x: (x[0] is None, x[0] or date.min)):
            if day is None or len(group) < 2:
                continue
            same_day_groups += 1
            with_order = [g for g in group if g["order"] is not None]
            if len(with_order) < 2:
                continue

            desired = sorted(with_order, key=lambda g: g["order"])
            for g in desired:
                new_at = compute_applied_at(day, g["order"])
                old_at = g["applied_at"]
                if old_at is not None and abs((old_at - new_at).total_seconds()) < 1:
                    continue
                updates.append((new_at, g["id"], g["full_name"], old_at))

        print(f"Same-day groups in DB: {same_day_groups}")
        print(f"Rows to update applied_at: {len(updates)}")

        # Show tail of queue after fix (simulated)
        simulated = []
        for row_id, full_name, applied_at, status in rows:
            new_at = applied_at
            for candidate, rid, _, _ in updates:
                if rid == row_id:
                    new_at = candidate
                    break
            simulated.append((new_at, row_id, full_name, status))
        simulated.sort(key=lambda x: (x[0] is None, x[0], x[1]))

        visible = [
            s for s in simulated if s[3] not in ("Rejected", "Canceled", "Added as Member")
        ]
        print("\nLast 5 in public queue (after fix):")
        for pos, (_at, _id, name, status) in enumerate(visible[-5:], start=max(1, len(visible) - 4)):
            order = order_by_name.get(normalize_name_key(name))
            print(f"  #{pos} order={order} {name} ({status})")

        if updates:
            print("\nSample changes:")
            for new_at, rid, name, old_at in updates[:15]:
                print(f"  id={rid} {name}: {old_at} -> {new_at}")
            if len(updates) > 15:
                print(f"  ... and {len(updates) - 15} more")

        if apply and updates:
            with conn.cursor() as cur:
                for new_at, rid, _, _ in updates:
                    cur.execute("UPDATE waiting_list SET applied_at = %s WHERE id = %s", (new_at, rid))
            conn.commit()
            print(f"\nApplied {len(updates)} updates.")
        elif not apply:
            print("\nDry run — re-run with --apply to commit.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
