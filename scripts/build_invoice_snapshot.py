#!/usr/bin/env python3
"""Build public/admin/invoices-snapshot.json from PayPal export CSV (gitignored data/)."""

import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUT = ROOT / "public" / "admin" / "invoices-snapshot.json"

CANDIDATES = sorted(DATA.glob("Download-*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)


def parse_date(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return ""
    for fmt in ("%m/%d/%y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw


def main():
    src = CANDIDATES[0] if CANDIDATES else None
    if not src or not src.exists():
        print("No Download-*.csv in data/ — skipping snapshot.")
        return

    items_by_inv: dict[str, dict] = {}
    with src.open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if row.get("Type") != "Invoice summary":
                continue
            inv_num = (row.get("Invoice number") or "").strip()
            if not inv_num or inv_num in items_by_inv:
                continue
            status_raw = row.get("Status") or "Unpaid"
            status = "Paid" if "paid" in status_raw.lower() and "unpaid" not in status_raw.lower() else "Unpaid"
            try:
                amount_due = float(row.get("Amount due") or row.get("Total invoice") or 110)
            except ValueError:
                amount_due = 110.0
            items_by_inv[inv_num] = {
                "invoice_num": int(inv_num) if inv_num.isdigit() else inv_num,
                "name": (row.get("Name") or "").strip(),
                "email": (row.get("To email") or "").strip(),
                "item": "",
                "date": parse_date(row.get("Invoice date") or row.get("Date created")),
                "status": status,
                "amount_due": amount_due,
                "total": amount_due,
                "paypal_id": (row.get("PayPal Invoice ID") or "").strip(),
            }

    # Attach event names from invoice item rows
    with src.open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if row.get("Type") != "Invoice item":
                continue
            inv_num = (row.get("Invoice number") or "").strip()
            if inv_num in items_by_inv and not items_by_inv[inv_num]["item"]:
                items_by_inv[inv_num]["item"] = (row.get("Item name") or "").strip()

    invoices = sorted(items_by_inv.values(), key=lambda x: x["invoice_num"], reverse=True)
    for inv in invoices:
        if not inv["item"]:
            inv["item"] = "Unknown Event"

    members = {}
    events = set()
    for inv in invoices:
        members[inv["name"]] = members.get(inv["name"], 0) + 1
        events.add(inv["item"])

    report_day = datetime.now().strftime("%B %d, %Y").replace(" 0", " ")
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": src.name,
        "report_label": f"Report as of {report_day} · PayPal Export",
        "invoices": invoices,
        "meta": {
            "total_invoices": len(invoices),
            "unique_members": len(members),
            "events_covered": len(events),
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {len(invoices)} invoices to {OUT}")


if __name__ == "__main__":
    main()
