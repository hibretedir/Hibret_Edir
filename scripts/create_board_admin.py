"""Create or reset a board admin login (board_members table)."""
import argparse
import getpass
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from seed_from_exports import load_env_file, require_psycopg

load_env_file()


def main():
    parser = argparse.ArgumentParser(description="Create or reset board admin password")
    parser.add_argument("--email", required=True, help="Board login email")
    parser.add_argument("--password", help="Password (prompted if omitted)")
    parser.add_argument("--role", default="admin", help="Role label (default: admin)")
    args = parser.parse_args()

    password = args.password or getpass.getpass("New password: ")
    if len(password) < 8:
        print("Use at least 8 characters.")
        return 1

    try:
        import bcrypt
    except ImportError:
        import subprocess

        subprocess.check_call([sys.executable, "-m", "pip", "install", "bcrypt", "-q"])
        import bcrypt

    email = args.email.strip().lower()
    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    psycopg2 = require_psycopg()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL missing from .env")
        return 1

    kwargs = {"connect_timeout": 15}
    if "render.com" in db_url:
        kwargs["sslmode"] = "require"

    conn = psycopg2.connect(db_url, **kwargs)
    cur = conn.cursor()
    cur.execute("SELECT id FROM board_members WHERE LOWER(email) = LOWER(%s)", (email,))
    row = cur.fetchone()
    if row:
        cur.execute(
            "UPDATE board_members SET password_hash = %s, is_active = true, role = %s WHERE id = %s",
            (password_hash, args.role, row[0]),
        )
        print(f"Updated password for board admin: {email}")
    else:
        cur.execute(
            """
            INSERT INTO board_members (email, password_hash, role, is_active)
            VALUES (%s, %s, %s, true)
            RETURNING id
            """,
            (email, password_hash, args.role),
        )
        new_id = cur.fetchone()[0]
        print(f"Created board admin #{new_id}: {email}")
    conn.commit()
    cur.close()
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
