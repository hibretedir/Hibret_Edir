# Scheduled PayPal sync

## What Netlify shows

| Dashboard field | Value | Meaning |
|-----------------|-------|---------|
| Function | `paypal-sync-scheduled` | Hourly trigger |
| Schedule | `0 * * * *` | **Every hour** (Netlify label) |
| Badge | Scheduled | Cron is active |

**“Every hour” does not mean PayPal syncs every hour.**

## When PayPal actually syncs

Automatic sync runs **twice per day**:

- **9:00 AM** Pacific (`America/Los_Angeles`)
- **6:00 PM** Pacific (`America/Los_Angeles`)

The function wakes every hour, checks the current Pacific hour, and **skips** unless it is 9 or 18. On skip, logs say:

```text
PayPal scheduled sync skipped — 9:00 AM & 6:00 PM Pacific (America/Los_Angeles) only
```

On sync, it starts **`paypal-sync-background`**, which pulls all invoices from PayPal into PostgreSQL in batches.

## Why hourly cron?

Netlify scheduled functions use **UTC cron only**. Los Angeles time shifts with daylight saving. An hourly trigger plus a Pacific-time check keeps **9 AM and 6 PM local** correct year-round.

## Manual sync

| Method | When |
|--------|------|
| Admin → Invoices → **Sync PayPal** | Any time (board login) |
| `npm run sync:paypal` | Local / terminal |
| `/.netlify/functions/paypal-sync-scheduled?secret=CRON_SECRET` | Any time (forces sync) |

## Required Netlify env var

| Variable | Purpose |
|----------|---------|
| `CRON_SECRET` | Authorizes scheduled + background sync |
| `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` | PayPal API |
| `PAYPAL_ENV` | `sandbox` or production (empty = production API) |
| `DATABASE_URL` | PostgreSQL |

After adding `CRON_SECRET`, redeploy once.

## Related functions

| Function | Role |
|----------|------|
| `paypal-sync-scheduled` | Hourly trigger; sync at 9 AM & 6 PM Pacific |
| `paypal-sync-background` | Full batched PayPal → DB pull |
| `paypal-sync` | Manual sync (Admin button) |
