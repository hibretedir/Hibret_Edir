# SendGrid + Twilio setup (Hibret Edir)

All notification code lives in `netlify/functions/notify.js`. When API keys are missing, sends are **skipped gracefully** (logged as `Skipped` in `notifications` table when DB is available).

## What notifications do today

| Trigger | Member email/SMS | Board alert |
|---------|------------------|-------------|
| Waiting list → Invited | ✓ | — |
| Application submitted | ✓ | ✓ |
| Registration invoice sent | ✓ | ✓ |
| Application approved / rejected | ✓ | — |
| Profile / beneficiary changes | ✓ | ✓ |

Callers: `apply.js`, `portal.js`, `auth.js`, `membership-completion.js`.

---

## 1. SendGrid (email)

1. Create a [SendGrid](https://sendgrid.com/) account (free tier is enough for board volume).
2. **Settings → API Keys → Create API Key** — Full Access or Restricted with Mail Send only.
3. **Settings → Sender Authentication**
   - **Single Sender Verification** for `hibretedirautomation@gmail.com` (quick start), **or**
   - **Domain Authentication** for `hibretedir.com` (recommended for production deliverability).
4. Copy the API key once — it is shown only at creation.

### Env vars

| Variable | Example | Notes |
|----------|---------|--------|
| `SENDGRID_API_KEY` | `SG.xxxx` | Required for email |
| `SENDGRID_FROM_EMAIL` | `hibretedirautomation@gmail.com` | Must be a verified sender in SendGrid |
| `BOARD_NOTIFY_EMAIL` | `hibretedirtext@gmail.com` | Comma-separated board inboxes |

---

## 2. Twilio (SMS)

1. Create a [Twilio](https://www.twilio.com/) account.
2. **Console → Account Info** — copy Account SID and Auth Token.
3. **Phone Numbers → Buy a number** (or use trial number for testing).
4. Set `TWILIO_FROM` to that number in **E.164** format: `+14245475594`.

Trial accounts can only SMS **verified** recipient numbers until the account is upgraded.

### Env vars

| Variable | Example | Notes |
|----------|---------|--------|
| `TWILIO_ACCOUNT_SID` | `ACxxxx` | |
| `TWILIO_AUTH_TOKEN` | `xxxx` | |
| `TWILIO_FROM` | `+14245475594` | Must be your Twilio number (E.164) |
| `BOARD_NOTIFY_PHONE` | `4245475594` | Comma-separated; normalized to +1 |

---

## 3. Local `.env`

Copy from `.env.example`:

```bash
cp .env.example .env
```

Fill in notification section plus optional test destinations:

```
SENDGRID_API_KEY=SG....
SENDGRID_FROM_EMAIL=hibretedirautomation@gmail.com
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+1XXXXXXXXXX
BOARD_NOTIFY_EMAIL=hibretedirtext@gmail.com
BOARD_NOTIFY_PHONE=4245475594

# Optional — for live test script only
TEST_NOTIFY_EMAIL=you@example.com
TEST_NOTIFY_PHONE=4245551234
```

**Never commit `.env`.**

---

## 4. Netlify (production)

1. Netlify dashboard → **Site → Environment variables**.
2. Add the same keys as above (no `TEST_*` vars needed in production unless you want them).
3. **Trigger deploy** after saving env vars so functions pick up new values.

Also set `ADMIN_SITE_URL=https://hibretedir.com` so board emails include admin review links.

---

## 5. Verify configuration

```bash
# Config check only (exit 1 if nothing configured)
npm run test:notify

# Send test email + SMS to TEST_NOTIFY_* addresses
npm run test:notify -- --send
```

Expected dry-run output shows `configured: yes` for each channel when keys are set.

---

## 6. Smoke-test real flows

After `--send` succeeds:

1. **Waiting list invite** — Admin → Waiting list → mark someone Invited → they should receive email + SMS with `/application/` link.
2. **Application submitted** — Submit test application → applicant + board should be notified.
3. Check **Admin → notifications** table (if exposed) or Render Postgres `notifications` rows.

---

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Email skipped in logs | `SENDGRID_API_KEY` missing on Netlify; redeploy after setting |
| SendGrid 403 / sender not verified | Complete Single Sender or Domain Authentication for `SENDGRID_FROM_EMAIL` |
| SMS skipped | Missing `TWILIO_*` or invalid `TWILIO_FROM` (must be E.164) |
| Twilio 21608 / unverified number | Trial account — verify recipient phone in Twilio console |
| Works locally, not production | Netlify env not set or deploy not run after env change |
| Board gets email but not SMS | Check `BOARD_NOTIFY_PHONE` format; use 10-digit US numbers |

---

## 8. Registry IDs

See `docs/automation-registry.md`: **NTF-01** (SendGrid), **NTF-02** (Twilio), **NTF-03** (board alerts), **NTF-04** (graceful skip). Mark NTF-01–03 **Live** after production smoke-test passes.
