#!/usr/bin/env python3
"""Mark known existing members as Added as Member on the waiting list queue."""

import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[1]

# Places 1–11 joined through Martha Mekonnen (minus canceled Senait/Kidus from export).
ADDED_MEMBER_NAMES = [
    "Almaz N",
    "Meseret Habte",
    "Lydia Shiferaw",
    "Bizuayahu Derseh",
    "Etenat Shegaw",
    "Tsegamlak Worku",
    "Temersta Tekie",
    "Tewodros Negash",
    "Martha Mekonnen",
]


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
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
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL is not set")

    conn = psycopg2.connect(db_url, connect_timeout=10)
    cur = conn.cursor()
    note = " Already a member — marked added by board."

    for name in ADDED_MEMBER_NAMES:
        cur.execute(
            """
            UPDATE waiting_list
            SET status = 'Added as Member',
                notes = TRIM(BOTH FROM COALESCE(notes, '') || %s)
            WHERE TRIM(full_name) ILIKE %s
            """,
            (note, name),
        )
        print(f"{name}: updated {cur.rowcount} row(s)")

    conn.commit()

    cur.execute(
        """
        SELECT full_name, email, status
        FROM waiting_list
        WHERE status IN ('Registered', 'Pending')
        ORDER BY applied_at ASC NULLS LAST, id ASC
        LIMIT 5
        """
    )
    print("\nNext in queue (Ready to Invite):")
    for row in cur.fetchall():
        print(f"  {row[0]} | {row[1]} | {row[2]}")

    conn.close()


def export_public_json_from_db() -> None:
    """Refresh public/waiting-list-public.json from database queue."""
    import json
    import sys
    from datetime import datetime

    sys.path.insert(0, str(ROOT / "scripts"))
    from import_waiting_list import ADDED_THROUGH_POSITION, PUBLIC_WAITING_LIST_JSON

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=10)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT full_name, status, applied_at
        FROM waiting_list
        WHERE status NOT IN ('Rejected', 'Canceled')
        ORDER BY applied_at ASC NULLS LAST, id ASC
        """
    )
    rows = cur.fetchall()
    conn.close()

    entries = []
    next_position = None
    added_count = 0
    for idx, (full_name, status, applied_at) in enumerate(rows, start=1):
        added = status == "Added as Member"
        if added:
            added_count += 1
        if not added and next_position is None:
            next_position = idx
        applied_text = applied_at.strftime("%B %d, %Y") if applied_at else None
        status_labels = {
            "Added as Member": ("Added", "ተጨምሯል"),
            "Invited to Apply": ("Invitation Sent", "ግብአት ተላልፏል"),
            "Application Submitted": ("Invitation Sent", "ግብአት ተላልፏል"),
            "Registered": ("Registered", "ተመዝግቧል"),
            "Pending": ("Pending", "በመጠባበቅ ላይ"),
        }
        label_en, label_am = status_labels.get(status, ("Pending", "በመጠባበቅ ላይ"))
        entries.append(
            {
                "position": idx,
                "display_name": full_name,
                "applied_date_text": applied_text,
                "status": status,
                "status_label": label_en,
                "status_label_en": label_en,
                "status_label_am": label_am,
                "added": added,
            }
        )

    note = (
        f"{added_count} member{'s' if added_count != 1 else ''} added so far. #{next_position} is next in line."
        if next_position
        else f"{added_count} member{'s' if added_count != 1 else ''} added so far."
    )
    payload = {
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "added_through_position": added_count,
        "added_count": added_count,
        "count": len(entries),
        "note": note,
        "entries": entries,
    }
    PUBLIC_WAITING_LIST_JSON.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Updated {PUBLIC_WAITING_LIST_JSON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
    export_public_json_from_db()
