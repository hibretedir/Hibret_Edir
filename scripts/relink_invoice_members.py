#!/usr/bin/env python3
"""Re-link invoices to members by PayPal recipient_name (fixes placeholder-email collisions)."""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from seed_from_exports import find_member_id, load_env_file, require_psycopg


def main():
    parser = argparse.ArgumentParser(description="Re-link invoice member_id from recipient_name")
    parser.add_argument("--dry-run", action="store_true", help="Show changes without writing")
    args = parser.parse_args()

    load_env_file()
    conn = require_psycopg().connect(
        os.environ["DATABASE_URL"], sslmode="require", connect_timeout=15
    )
    conn.autocommit = False
    cur = conn.cursor()

    cur.execute(
        """
        SELECT id, invoice_number, recipient_name, member_id
        FROM invoices
        WHERE recipient_name IS NOT NULL AND TRIM(recipient_name) <> ''
        ORDER BY invoice_number
        """
    )
    rows = cur.fetchall()
    updated = 0
    cleared = 0
    unchanged = 0

    for inv_id, inv_num, recipient, old_mid in rows:
        new_mid = find_member_id(cur, recipient, None)
        if new_mid == old_mid:
            unchanged += 1
            continue
        action = f"#{inv_num} {recipient!r}: member_id {old_mid} -> {new_mid}"
        if args.dry_run:
            print(action)
        else:
            cur.execute("UPDATE invoices SET member_id = %s, updated_at = NOW() WHERE id = %s", (new_mid, inv_id))
            print(action)
        if new_mid:
            updated += 1
        else:
            cleared += 1

    if args.dry_run:
        print(f"\nDry run: {updated} would update, {cleared} unmatched, {unchanged} unchanged")
    else:
        conn.commit()
        print(f"\nDone: {updated} updated, {cleared} unmatched (member_id set NULL), {unchanged} unchanged")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
