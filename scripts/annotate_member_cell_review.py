#!/usr/bin/env python3
"""
Sort PayPal cell list and annotate with matching CRM data for board review.
Does NOT update the database.

Input:  data/members cell number.xlsx  (given_name, surname, phone_no)
Output: data/members cell number - review.xlsx

Usage:
  python scripts/annotate_member_cell_review.py
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
INPUT_XLSX = DATA / "members cell number.xlsx"
OUTPUT_XLSX = DATA / "members cell number - review.xlsx"

sys.path.insert(0, str(ROOT / "scripts"))
from seed_from_exports import load_env_file, normalize_phone, require_openpyxl, require_psycopg

load_env_file()

DB_COLS = [
    "db_member_number",
    "db_paypal_name",
    "db_full_name",
    "db_mobile",
    "db_home_phone",
    "db_status",
    "has_pin",
    "match_type",
    "phone_same",
    "your_ok",
]


def norm_name(value) -> str:
    if value is None:
        return ""
    text = re.sub(r"\s+", " ", str(value).strip().lower())
    text = re.sub(r"^dr\.?\s+", "", text)
    return text


def primary_household(full_name: str | None) -> str:
    if not full_name:
        return ""
    return norm_name(str(full_name).split("/")[0].strip())


def phone_digits(value) -> str:
    if not value:
        return ""
    d = re.sub(r"\D", "", str(value))
    return d[-10:] if len(d) >= 10 else d


def excel_full_name(given, surname) -> str:
    return norm_name(f"{given or ''} {surname or ''}".strip())


def collapse_name(value) -> str:
    return re.sub(r"[^a-z0-9]", "", norm_name(value))


def member_keys(row: dict) -> list[tuple[str, str]]:
    """Return (normalized_key, match_type) candidates for a CRM member."""
    keys: list[tuple[str, str]] = []
    paypal = norm_name(row.get("paypal_name"))
    full_primary = primary_household(row.get("full_name"))
    first_last = norm_name(f"{row.get('first_name') or ''} {row.get('last_name') or ''}".strip())
    full = norm_name(row.get("full_name"))

    if paypal:
        keys.append((paypal, "paypal"))
        collapsed = collapse_name(row.get("paypal_name"))
        if collapsed:
            keys.append((f"__collapsed__:{collapsed}", "paypal_fuzzy"))
    if full_primary and full_primary != paypal:
        keys.append((full_primary, "full_name"))
        collapsed = collapse_name(full_primary)
        if collapsed:
            keys.append((f"__collapsed__:{collapsed}", "full_name_fuzzy"))
    if first_last and first_last not in {paypal, full_primary}:
        keys.append((first_last, "first_last"))
    if full and full not in {k[0] for k in keys if not k[0].startswith("__collapsed__")}:
        keys.append((full, "full_name"))
    return keys


def build_member_index(rows: list[dict]) -> dict[str, list[dict]]:
    index: dict[str, list[dict]] = {}
    for row in rows:
        seen: set[str] = set()
        for key, _match in member_keys(row):
            if not key or key in seen:
                continue
            seen.add(key)
            index.setdefault(key, []).append(row)
    return index


def find_match(excel_row: dict, index: dict[str, list[dict]], db_members: list[dict]) -> tuple[dict | None, str]:
    key = excel_row["excel_name_norm"]
    collapsed_key = f"__collapsed__:{collapse_name(excel_row.get('excel_name'))}"

    for lookup, default_type in ((key, None), (collapsed_key, "review")):
        if lookup in index:
            m, mt = pick_best_match(index[lookup])
            if m:
                if default_type == "review" and mt == "paypal":
                    return m, "review"
                return m, mt if mt != "no_match" else default_type or "paypal"

    # Surname + first-name prefix (e.g. Tsegamlak Worku → Tsegamlak T Worku)
    surname = norm_name(excel_row.get("surname"))
    given = norm_name(excel_row.get("given_name"))
    if surname and given:
        hits = []
        for m in db_members:
            if norm_name(m.get("last_name")) != surname and not norm_name(m.get("paypal_name", "")).endswith(" " + surname):
                paypal_parts = norm_name(m.get("paypal_name")).split()
                if not paypal_parts or paypal_parts[-1] != surname:
                    continue
            paypal_given = norm_name(m.get("paypal_name")).rsplit(surname, 1)[0].strip() if surname else ""
            first = norm_name(m.get("first_name"))
            if given == first or given == paypal_given:
                hits.append(m)
                continue
            if paypal_given.startswith(given) or given.startswith(paypal_given.split()[0] if paypal_given else ""):
                hits.append(m)
        if len(hits) == 1:
            return hits[0], "review"
        if len(hits) > 1:
            return pick_best_match(hits)[0], "review"

    return None, "no_match"


def pick_best_match(candidates: list[dict]) -> tuple[dict | None, str]:
    if not candidates:
        return None, "no_match"
    if len(candidates) == 1:
        m = candidates[0]
        match_type = "paypal"
        for key, mt in member_keys(m):
            if key in {norm_name(m.get("paypal_name"))}:
                match_type = mt
                break
        return m, match_type
    # Prefer Active, then lowest member_number
    active = [c for c in candidates if str(c.get("status") or "").lower() == "active"]
    pool = active or candidates
    pool = sorted(pool, key=lambda c: (c.get("member_number") is None, c.get("member_number") or 9999))
    if len(set(c["id"] for c in pool)) > 1:
        return pool[0], "review"
    return pool[0], "paypal"


def load_db_members() -> list[dict]:
    psycopg2 = require_psycopg()
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL missing in .env")
    kwargs = {}
    if "render.com" in url:
        kwargs["sslmode"] = "require"
    conn = psycopg2.connect(url, connect_timeout=15, **kwargs)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, member_number, first_name, last_name, full_name, paypal_name,
                   mobile, home_phone, status, (pin_hash IS NOT NULL) AS has_pin
            FROM members
            ORDER BY member_number NULLS LAST, id
            """
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        cur.close()
        return rows
    finally:
        conn.close()


def read_excel_rows(openpyxl) -> tuple[list[str], list[dict]]:
    if not INPUT_XLSX.exists():
        raise SystemExit(f"Missing input file: {INPUT_XLSX}")
    wb = openpyxl.load_workbook(INPUT_XLSX, read_only=True, data_only=True)
    ws = wb.active
    raw = list(ws.iter_rows(values_only=True))
    wb.close()
    if not raw:
        raise SystemExit("Input spreadsheet is empty")
    header = [str(c or "").strip().lower() for c in raw[0]]
    given_idx = next((i for i, h in enumerate(header) if h in ("given_name", "given", "first")), 0)
    surname_idx = next((i for i, h in enumerate(header) if h in ("surname", "last")), 1)
    phone_idx = next((i for i, h in enumerate(header) if "phone" in h), 2)

    rows = []
    for r in raw[1:]:
        if not r or all(v is None or str(v).strip() == "" for v in r):
            continue
        given = r[given_idx] if given_idx < len(r) else None
        surname = r[surname_idx] if surname_idx < len(r) else None
        phone = r[phone_idx] if phone_idx < len(r) else None
        rows.append(
            {
                "given_name": given,
                "surname": surname,
                "phone_no": phone,
                "excel_name": f"{given or ''} {surname or ''}".strip(),
                "excel_name_norm": excel_full_name(given, surname),
                "excel_phone_norm": normalize_phone(phone),
            }
        )
    source_header = [str(c or "").strip() for c in raw[0]]
    return source_header, rows


def main() -> int:
    openpyxl = require_openpyxl()
    source_header, excel_rows = read_excel_rows(openpyxl)
    db_members = load_db_members()
    index = build_member_index(db_members)

    # Sort A–Z by surname, then given name
    excel_rows.sort(
        key=lambda r: (
            norm_name(r.get("surname")),
            norm_name(r.get("given_name")),
        )
    )

    matched = 0
    review = 0
    no_match = 0

    out_rows = []
    for row in excel_rows:
        m, match_type = find_match(row, index, db_members)

        excel_digits = phone_digits(row.get("phone_no"))
        db_mobile_digits = phone_digits(m.get("mobile") if m else None)
        if not m:
            phone_same = ""
        elif not excel_digits and not db_mobile_digits:
            phone_same = "blank"
        elif excel_digits and db_mobile_digits and excel_digits == db_mobile_digits:
            phone_same = "Y"
        else:
            phone_same = "N"

        out_rows.append(
            {
                **row,
                "db_member_number": m.get("member_number") if m else "",
                "db_paypal_name": m.get("paypal_name") if m else "",
                "db_full_name": m.get("full_name") if m else "",
                "db_mobile": m.get("mobile") if m else "",
                "db_home_phone": m.get("home_phone") if m else "",
                "db_status": m.get("status") if m else "",
                "has_pin": "Y" if m and m.get("has_pin") else ("N" if m else ""),
                "match_type": match_type,
                "phone_same": phone_same,
                "your_ok": "",
            }
        )

    matched = sum(1 for r in out_rows if r["match_type"] in ("paypal", "full_name", "first_last"))
    review = sum(1 for r in out_rows if r["match_type"] == "review")
    no_match = sum(1 for r in out_rows if r["match_type"] == "no_match")
    would_update = sum(
        1 for r in out_rows
        if r["match_type"] in ("paypal", "full_name", "first_last", "review")
        and r["phone_same"] == "N"
        and r.get("excel_phone_norm")
    )

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Review"
    header = source_header + DB_COLS
    ws.append(header)
    for row in out_rows:
        ws.append(
            [
                row.get("given_name"),
                row.get("surname"),
                row.get("phone_no"),
                row.get("db_member_number"),
                row.get("db_paypal_name"),
                row.get("db_full_name"),
                row.get("db_mobile"),
                row.get("db_home_phone"),
                row.get("db_status"),
                row.get("has_pin"),
                row.get("match_type"),
                row.get("phone_same"),
                row.get("your_ok"),
            ]
        )

    # Unmatched CRM active members (optional second sheet)
    matched_ids = {
        index.get(r["excel_name_norm"], [{}])[0].get("id")
        for r in excel_rows
        if index.get(r["excel_name_norm"])
    }
    ws2 = wb.create_sheet("CRM not in Excel")
    ws2.append(["member_number", "paypal_name", "full_name", "mobile", "status"])
    for m in db_members:
        if str(m.get("status") or "").lower() != "active":
            continue
        paypal_key = norm_name(m.get("paypal_name"))
        if paypal_key not in {r["excel_name_norm"] for r in excel_rows}:
            ws2.append(
                [
                    m.get("member_number"),
                    m.get("paypal_name"),
                    m.get("full_name"),
                    m.get("mobile"),
                    m.get("status"),
                ]
            )

    wb.save(OUTPUT_XLSX)
    print(f"Wrote {OUTPUT_XLSX}")
    print(f"  Excel rows: {len(out_rows)} (sorted A–Z by surname, given name)")
    print(f"  Matched: {matched}  Review: {review}  No match: {no_match}")
    print(f"  Would update mobile (phone_same=N): {would_update}")
    print("Fill column 'your_ok' with OK to approve updates (Agent mode apply step).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
