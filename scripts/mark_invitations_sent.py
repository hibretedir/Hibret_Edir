#!/usr/bin/env python3
"""Mark top-3 invitees: two invited (no response), Misrak application in progress."""

import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[1]

INVITED_NO_RESPONSE = [
    "Simon Tiku",
    "Yohannes Afework",
]

IN_PROGRESS = [
    "Misrak B. Demessie",
    "Misrak B Demessie",
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


def ensure_columns(cur) -> None:
    cur.execute(
        "ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS invited_at TIMESTAMP WITH TIME ZONE"
    )


def update_by_name(cur, name: str, status: str, note: str) -> int:
    cur.execute(
        """
        UPDATE waiting_list
        SET status = %s,
            invited_at = COALESCE(invited_at, NOW()),
            reviewed_at = NOW(),
            notes = TRIM(BOTH FROM COALESCE(notes, '') || %s)
        WHERE TRIM(full_name) ILIKE %s
        """,
        (status, note, name),
    )
    if cur.rowcount:
        print(f"  {name} → {status}")
    else:
        print(f"  {name} → NOT FOUND")
    return cur.rowcount


def main() -> None:
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=10)
    conn.autocommit = True
    cur = conn.cursor()
    ensure_columns(cur)

    print("Invitation sent (awaiting response):")
    n1 = 0
    for name in INVITED_NO_RESPONSE:
        n1 += update_by_name(
            cur,
            name,
            "Invited to Apply",
            " Board marked invitation sent — awaiting applicant response.",
        )

    print("In progress (application submitted):")
    n2 = 0
    for name in IN_PROGRESS:
        count = update_by_name(
            cur,
            name,
            "Application Submitted",
            " Board marked invitation sent; application in progress.",
        )
        if count:
            n2 += count
            break

    cur.execute(
        """
        SELECT full_name, status, invited_at
        FROM waiting_list
        WHERE full_name ILIKE 'Simon Tiku'
           OR full_name ILIKE 'Yohannes Afework'
           OR full_name ILIKE 'Misrak B.%'
        ORDER BY applied_at ASC NULLS LAST, id ASC
        """
    )
    print("\nVerified:")
    for row in cur.fetchall():
        print(f"  {row[0]} | {row[1]} | invited {row[2]}")

    conn.close()
    print(f"\nUpdated {n1 + n2} row(s).")


if __name__ == "__main__":
    main()
