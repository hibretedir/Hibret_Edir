#!/usr/bin/env python3
"""Build public/portal/members-snapshot.json from membership Excel (local dev login)."""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from seed_from_exports import load_members, require_openpyxl, MEMBERS_XLSX  # noqa: E402

OUT = ROOT / "public" / "portal" / "members-snapshot.json"


def main():
    if not MEMBERS_XLSX.exists():
        print(f"Missing {MEMBERS_XLSX}")
        return

    openpyxl = require_openpyxl()
    members = load_members(openpyxl)
    payload = []
    for m in members:
        num = m.get("member_number")
        payload.append(
            {
                "id": num,
                "member_number": num,
                "first_name": m.get("first_name"),
                "last_name": m.get("last_name"),
                "full_name": m.get("full_name"),
                "paypal_name": m.get("paypal_name"),
                "email": m.get("email"),
                "mobile": m.get("mobile"),
                "home_phone": m.get("home_phone"),
                "address": m.get("address"),
                "status": m.get("status") or "Active",
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "source": MEMBERS_XLSX.name,
                "count": len(payload),
                "members": payload,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Wrote {len(payload)} members to {OUT}")


if __name__ == "__main__":
    main()
