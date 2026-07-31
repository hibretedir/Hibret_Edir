# Hibret Edir — Agent Context & Handoff

**Last updated:** July 30, 2026 (waiting list Pass for non-responders)  
**Purpose:** Onboard a new Cursor agent quickly. Read this file first, then `HIBRET_EDIR_PROJECT_HANDOFF (1).md` for deeper business rules and by-laws.

**Current focus (next agent):** **Twilio SMS** — buy number, set `TWILIO_*` on Netlify, `npm run test:notify -- --send`. Then **production smoke-test**: shared-phone account picker; **portal login-help** (wrong number → required email → board reply emailed); Admin **Messages** email inbox + follow-up replies; board Access Management on phone + PC. **Database:** local `.env` `DATABASE_URL` points at **Render Postgres** — `npm run db:migrate` from your laptop **is** production DB ops. Confirm **`ADMIN_AUTH_ENABLED=true`** and **`BOARD_SUPER_ADMIN_EMAILS`** on Netlify. SendGrid is **done** — see **`docs/notifications-setup.md`**. QA playbook: **`docs/system-validation-playbook.md`**. **Local mobile testing:** `npm run dev` → phone browser `http://<PC-LAN-IP>:8888/admin/` or `/portal/`. **All user-visible dates/times** display in **Pacific (America/Los_Angeles)** via `public/js/datetime-la.js` + `netlify/functions/datetime-la.js`.

---

## 1. What this project is

**Hibret Edir** is an Ethiopian mutual-assistance (Edir) organization in Greater Los Angeles. When a member or covered family member dies:

- Every **active member pays $110** per event (via PayPal invoice, Zelle, or direct deposit).
- The grieving family receives a **$15,000 payout** for funeral costs.
- **~198 active members** (cap 200; count is live from DB). Founded 2011.

**Goal:** Replace Wix + PythonAnywhere + Google Sheets + N8N with one platform:

| Layer | Tech |
|-------|------|
| Frontend | HTML, CSS, vanilla JS (no React) |
| Hosting | Netlify (Pro) |
| API | Netlify Functions (Node.js) |
| Database | Render PostgreSQL |
| Member auth | Phone + 4-digit PIN (bcrypt + JWT) |
| Board auth | Email + password (JWT), opt-in via env |
| Payments | PayPal REST API |
| Email / SMS | SendGrid (live) / Twilio (pending — code ready, keys not set) |

**Contacts:** (424) 547-5594 · hibretedirtext@gmail.com · hibretedirautomation@gmail.com  
**Live URLs:** hibretedir.com · `/portal` · `/admin` · `/application` · `/docs/`

---

## 2. Repo structure (actual, June 2026)

```
hibretedir/
├── public/
│   ├── index.html                 # Public website (multi-section SPA, live stats/announcement)
│   ├── portal/index.html          # Member portal (live invoices, Deaths Paid)
│   ├── admin/index.html           # Board Admin Page (CRM)
│   ├── application/index.html     # Full membership application (step 2)
│   ├── waiting-list-public.json   # Static fallback for public waiting list (regenerate from DB)
│   ├── waiting-list-status/       # Full public queue page with Status column
│   ├── docs/                      # Board handout + automation showcase (mirror key HTML to public/docs/)
│   ├── member-stats.json          # Static fallback for hero active count (offline only)
│   ├── css/
│   │   ├── public-pages.css
│   │   ├── app-theme.css
│   │   ├── admin-tracker.css
│   │   ├── compat.css
│   │   └── hibret.css
│   └── js/
│       └── datetime-la.js         # Shared Pacific (LA) date/time formatters for admin, portal, application
│   └── admin/invoices-snapshot.json  # Offline invoice fallback for admin
├── netlify/functions/
│   ├── auth.js                    # PIN, board login, PIN reset requests
│   ├── admin-auth.js              # Shared JWT verify helpers
│   ├── portal.js                  # Members, invoices, profile, stats, activity
│   ├── apply.js                   # Waiting list, applications, site-stats, announcement routes
│   ├── event-announcement.js      # Memorial intake API, current-announcement, venues, PayPal balance hint
│   ├── demo-qa-dashboard.js       # System Health API + ONB validation steps (+ NTF-01 test email)
│   ├── demo-qa-reset.js           # QA demo cycle reset (DEMO_QA_EMAIL only)
│   ├── membership-completion.js   # Create active member after registration payment
│   ├── paypal-registration-invoice.js  # Registration PayPal invoice on board approve
│   ├── receipts.js                # Member receipt upload + admin review
│   ├── payouts.js                 # $15K payout document workflow
│   ├── notify.js                  # SendGrid + Twilio
│   ├── sync.js                    # Cross-entity sync + audit triggers (NOT PayPal)
│   ├── audit.js                   # Activity log read/write
│   ├── db.js                      # pg Pool singleton + timeouts
│   ├── geo.js                     # Address geocode, radius check, parseUsAddressLine for application prefill
│   ├── paypal-sync.js             # PayPal pull → PostgreSQL; orphan invoice linking; registration invoice_number=null
│   ├── paypal-sync-scheduled.js   # Netlify cron trigger (hourly; sync 9 AM & 6 PM Pacific)
│   ├── paypal-sync-background.js  # Full batched PayPal pull (long-running)
│   ├── paypal-env.js              # Local .env loader + PayPal API base URL
│   ├── payment-methods.js         # PayPal vs Zelle & BofA classification for stats
│   ├── invoice-stats-cache.js     # 60s TTL cache for admin invoice stats
│   ├── board-notes.js             # Board note merge helpers
│   ├── board-permissions.js       # Granular board perms (17 keys), tiers, restricted CRM scope
│   ├── datetime-la.js             # Server-side Pacific date/time + calendar-date helpers
│   └── member-snapshot.js         # Static member export + dev PIN file
├── db/schema.sql                  # PostgreSQL schema + idempotent migrations
├── docs/
│   ├── membership-onboarding-workflow.md
│   ├── system-validation-playbook.md  # QA slot 201, demo reset, full onboarding test cycle
│   ├── automation-registry.md         # Catalog of all automations (IDs, triggers, files)
│   ├── automation-showcase.html       # Portfolio / case-study site (share on business website)
│   ├── notifications-setup.md         # SendGrid + Twilio setup & test checklist
│   ├── board-meeting-handout.html
│   └── scheduled-paypal-sync.md
├── scripts/
│   ├── start-dev.js               # Dev entry (delegates to dev-local.js)
│   ├── dev-local.js               # Local server: public/ + functions; QA banner; /apply redirect
│   ├── demo_cycle_reset.js        # npm run demo:reset / demo:reset:apply
│   ├── test_qa_invite_local.js    # npm run test:qa-invite
│   ├── sync_paypal.js             # Full PayPal sync from terminal (no 60s limit)
│   ├── run_schema.js              # npm run db:migrate (connects to Render via .env — same DB as production)
│   ├── seed_announcement_venues.js  # npm run db:seed-ann-venues — LA church/cemetery presets for Admin dropdowns
│   ├── check_current_announcement.js  # Debug which event/memorial is live on public site
│   ├── seed_from_exports.py
│   ├── import_waiting_list.py     # Excel import + public JSON export
│   ├── fix_waiting_list_order.py  # Same-day queue tie-break from Order of Registration.xlsx
│   ├── add_yonas_misrak_crm.js    # One-off board CRM import (membership-completion flow)
│   ├── lookup_yonas_misrak.js     # DB lookup helper for CRM imports
│   ├── mark_added_waiting_list_members.py
│   ├── mark_invitations_sent.py
│   ├── seed_waiting_list_public.py
│   ├── set_event_announcement.js  # CLI backfill prayer/burial/payment on events.notes (legacy; prefer Admin → Announce)
│   ├── fix_board_permissions_regression.js  # One-off repair if board_perms regressed
│   ├── fix_qa_phone_collision.js  # Move QA test members off a real member's phone (prod DB one-off)
│   ├── annotate_member_cell_review.py  # Match Excel cell list → CRM; build board review xlsx
│   ├── apply_member_cell_updates.py      # Apply approved mobile updates from review file (shared phones OK)
│   ├── sync_board_member_names.js # Link board logins → CRM member_number; member_number roster only (no hardcoded emails)
│   ├── build_invoice_snapshot.py
│   ├── build_members_snapshot.py
│   └── test_notifications.js      # npm run test:notify — verify SendGrid/Twilio config
├── data/                          # Gitignored exports — not in repo
├── .env.example
├── netlify.toml                   # Redirects, function timeouts, scheduled cron, secrets scan omit
├── package.json
├── README.md
└── HIBRET_EDIR_PROJECT_HANDOFF (1).md
```

**Note:** `upload.js`, `members.js`, `events.js` from the original handoff **do not exist**. Receipt uploads use **`receipts.js`** (base64 in DB). Admin “create event → auto invoices” is still not built. **`sync.js` is internal CRM sync — not PayPal.**

**Removed (June 2026):** `public/data/memorial.json`, `scripts/extract_memorial.js`, public **In Remembrance** section.

---

## 3. Local development

### ⚠️ Netlify build credits — local-first workflow

| Do locally | Avoid until feature is complete |
|------------|----------------------------------|
| All coding via `npm run dev` | Pushing half-finished work to trigger deploys |
| Test functions at `http://localhost:8888/.netlify/functions/...` | Multiple push/redeploy cycles to “try something” |
| Use Render Postgres from local `.env` | **There is no separate “prod migrate” step** — `npm run db:migrate` from your machine updates Render |
| `npm run db:migrate` after schema changes | Committing unless user explicitly asks |

**Deploy rule:** Only push when the user says work is **complete and tested locally**.

```bash
npm install          # May fail on Google Drive — dev-local.js works around this
cp .env.example .env # Fill DATABASE_URL, JWT_SECRET, PAYPAL_*, CRON_SECRET, etc.
npm run db:migrate   # Apply schema.sql to Render (safe to re-run)
npm run db:seed-ann-venues  # Optional — 6 LA church/cemetery presets for Admin announce dropdowns
npm run dev          # → http://localhost:8888
npm run sync:paypal  # Full PayPal → DB sync from terminal
```

- **`scripts/dev-local.js`** serves `public/` and loads `netlify/functions/*.js` directly.
- Board admin locally: `ADMIN_AUTH_ENABLED` **off by default**.
- **Restart `npm run dev`** after adding new function routes or API endpoints.

### Mobile preview on desktop / real phone (no deploy)

| Method | How |
|--------|-----|
| **Browser DevTools** | `localhost:8888/portal/` → F12 → device toolbar (Ctrl+Shift+M) → pick iPhone/Pixel width |
| **Real phone, same Wi‑Fi** | Find PC LAN IP → `http://192.168.x.x:8888/portal/` — exercises real taps, keyboard, scroll |
| **When to push** | Production Netlify behavior, board review, or CI — not for every CSS/tab check |

Hard-refresh after CSS/JS changes (`Ctrl+Shift+R` on desktop; pull-to-refresh on phone).

---

## 4. Environment variables

See `.env.example`. Critical ones:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Render Postgres — required for real data |
| `JWT_SECRET` | Member + board tokens |
| `ADMIN_AUTH_ENABLED` | `true` on Netlify production (recommended) |
| `BOARD_SUPER_ADMIN_EMAILS` | Comma-separated emails with full access + can grant board permissions |
| `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` | PayPal sync |
| `PAYPAL_ENV` | `sandbox` or production (empty/non-sandbox = production API). Not a secret — omitted from Netlify secrets scan via `netlify.toml` |
| `CRON_SECRET` | **Required on Netlify** for scheduled + background PayPal sync |
| `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` / `SENDGRID_REPLY_TO` | Email (SendGrid v3) — **live** |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | SMS (E.164 Twilio number, e.g. `+14245551234`) — **not set yet** |
| `BOARD_NOTIFY_EMAIL` / `BOARD_NOTIFY_PHONE` | Comma-separated board alert recipients |
| `TEST_NOTIFY_EMAIL` / `TEST_NOTIFY_PHONE` | Optional — destinations for `npm run test:notify -- --send` |
| `ADMIN_SITE_URL` | Links in board notification emails |
| `PUBLIC_SITE_URL` | Short invite/apply links in emails (use `http://localhost:8888` locally; production URL on Netlify) |
| `MEMBER_CAP` | Default 200; use **`201`** for QA = **200 production slots + 1 reserved validation slot** (slot 201 is QA-only — real waiting-list invites use cap 200) |
| `DEMO_QA_ENABLED` | `true` to enable System Health QA + **Reset demo cycle** |
| `DEMO_QA_EMAIL` / `DEMO_QA_PHONE` / `DEMO_QA_NAME` | Dedicated test identity (never a real member). **`DEMO_QA_PHONE` must not match any real member** — use `3105550199` after June 2026 collision fix |
| `REGISTRATION_FEE` | `200` production; `1` for live PayPal QA smoke test |
| `ANNOUNCEMENT_FUND_THRESHOLD` | Optional — auto-suggest no collection when PayPal balance ≥ this (default 50000) |

**SendGrid production values (June 2026):**

| Variable | Value |
|----------|--------|
| `SENDGRID_FROM_EMAIL` | `notifications@hibretedir.com` |
| `SENDGRID_REPLY_TO` | `hibretedirtext@gmail.com` |

**DNS:** Domain auth for `hibretedir.com` is on **Wix DNS** (nameservers `NS0/NS1.WIXDNS.NET`) — site still on Wix; Netlify cutover not done. SendGrid CNAMEs + `_dmarc` TXT added in Wix. **Keep these records** when migrating DNS to Netlify.

**Twilio:** `TWILIO_FROM` must be a **Twilio-purchased** number — not the board line `(424) 547-5594`. Trial accounts can only SMS verified numbers until upgraded.

Notifications **skip gracefully** when Twilio is unset; email sends when SendGrid is configured.

---

## 5. Database

**Schema file:** `db/schema.sql` — run `npm run db:migrate` after pulling schema changes (idempotent). **Your local `.env` `DATABASE_URL` is Render** — migrations run from the command line update the live database Netlify uses.

**Tables in use:**

| Table | Purpose |
|-------|---------|
| `members` | CRM — includes `pin_hash`, `spouse_name`, `application_drive_url` |
| `beneficiaries` | Death beneficiary per member (primary) |
| `events` | Funeral events (deceased name, event #, amount); `notes` = JSON for public announcement (venues, `collect_dues`, spouse status, optional `announcement_text`) |
| `memorial_announcements` | No-collection memorials (no PayPal funeral event); `notes` = same JSON shape as events |
| `announcement_service_venues` | Saved church/funeral venues for Admin announce dropdowns (auto-grows on save) |
| `invoices` | PayPal-linked invoices; `recipient_name`, `paid_note` |
| `receipts` | Zelle/BofA receipt uploads (base64; approve → mark invoice Paid) |
| `waiting_list` | Public waiting list queue (`invited_at`, statuses below) |
| `membership_applications` | Step-2 application + ID docs; `registration_invoice_id`, `registration_fee_paid` |
| `invoices` | PayPal-linked; `membership_application_id` for $200 registration invoices |
| `member_change_requests` | Beneficiary changes pending board approval |
| `invoice_mark_paid_requests` | Board dual-control before manual mark-paid |
| `contact_messages` | Public Contact Us form inbox |
| `pin_reset_requests` | Member forgot-PIN requests |
| `event_payouts` | $15K payout document + approval workflow |
| `audit_log` | Activity log |
| `board_members` | Board login accounts; `display_name` (Access Management label only — **not** CRM); `member_id` link to CRM; `board_perms` JSONB (17 granular keys); legacy boolean columns kept for compat |
| `board_member_emails` | Multiple login emails per board account (aliases → one `board_members` row) |
| `notifications` | Email/SMS send log |

**Recent schema additions:** performance indexes; `invoices.paid_note`, `invoice_mark_paid_requests`; `waiting_list.invited_at`; `invoices.membership_application_id`; `membership_applications.registration_invoice_id`; `board_members.board_perms` JSONB + `display_name`; `board_member_emails`; `members.spouse_name`; `members.application_drive_url`; `membership_applications.applicant_signature`; **`memorial_announcements`**; **`announcement_service_venues`** (June 16–17).

**Waiting list statuses (admin + DB):**

| Status | Meaning |
|--------|---------|
| `Pending` / `Registered` | In queue |
| `Invited to Apply` | Board sent invite |
| `Passed` | Invited but did not respond — board **Pass** freed the slot; still on list, ranked behind Pending/Registered for the next invite |
| `Application Submitted` | Form received |
| `Added as Member` | Paid and in CRM |
| `Rejected` | Removed from queue (Remove button) |

**Public waiting list labels:** Only `Added as Member` shows **Added**. `Invited to Apply` and `Application Submitted` show **Invitation Sent** (not position-based — do not use “places 1–11” heuristic).

**Seeding / waiting list ops:**

```bash
npm run db:migrate
npm run db:seed-ann-venues   # 6 presets (3 churches, 3 cemeteries) — also auto-seeded when Admin loads venues
npm run import:waiting-list:seed          # if DB empty
python scripts/import_waiting_list.py --file "data/waiting list with phone and email.xlsx" --seed
python scripts/mark_added_waiting_list_members.py   # marks known members + refreshes public JSON
python scripts/mark_invitations_sent.py             # one-off status updates
python scripts/fix_waiting_list_order.py --apply    # Fix same-day queue order (tie-break from registration order file)
node scripts/set_event_announcement.js 30           # Backfill public announcement for event #30 (or any event #)
```

**Event announcement JSON** (`events.notes` or `memorial_announcements.notes` — Admin → **Announce** or `scripts/set_event_announcement.js`):

| Field | Purpose |
|-------|---------|
| `prayer_venue`, `prayer_address`, `prayer_datetime` | Prayer service block on public site |
| `church_service`, `funeral_service`, `guest_reception` | Structured service blocks (enabled + venue/address/datetime) |
| `burial_venue`, `burial_address` | Burial service block (legacy aliases) |
| `collect_dues` | `false` → no dues paragraph; memorial-only row when no PayPal event |
| `spouse_continue_status` | `yes` / `no` / `no_spouse` on deceased member intake |
| `announcement_text` | Free-text/HTML fallback if structured fields absent |

**Current announcement selection:** `getCurrentAnnouncementFromDb()` picks **highest `event_number`** among Active events (not `updated_at` — test saves were bumping wrong event). Active memorial with `collect_dues: false` can override. Debug: `node scripts/check_current_announcement.js`.

PayPal sync creates events with name only — **use Admin → Announce** (or `set_event_announcement.js`) so the public memorial letter shows full service details.

---

## 6. Netlify Functions — API reference

Base URL: `/.netlify/functions/<name>`

### `auth.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/config` | — | `{ adminAuthRequired, memberAuthRequired }` |
| POST | `/check-phone` | — | Returns all CRM matches for phone/email: `{ exists, canLogin, multiple, members[] }` with `displayName`, `hasPin`, `isActive` per row; QA test rows excluded |
| POST | `/create-pin` | — | Set bcrypt PIN on **selected** member (`memberId` required when multiple matches); inactive blocked |
| POST | `/verify-pin` | — | Returns member JWT; `memberId` required when multiple matches; PIN is per-member (not shared across family on same phone) |
| POST | `/request-pin-reset` | — | Creates `pin_reset_requests` row; accepts `memberId` when phone matches multiple accounts |
| GET/POST | `/pin-reset-requests/*` | Admin | List / approve / reject |
| POST | `/admin/reset-pin` | Admin | Clear PIN from member modal |
| GET | `/me` | Member JWT | Current member |
| POST | `/admin/login` | — | Board JWT |
| GET | `/admin/me` | Board JWT | Profile + `perms` |
| GET/POST | `/admin/board-members` | Super admin | List / invite board logins |
| POST | `/admin/board-members/:id/permissions` | Super admin | Save `board_perms` + `display_name` (board only — never CRM) |
| POST | `/admin/board-members/:id/deactivate` | Super admin | Deactivate login (stays in list; cannot sign in) |
| POST | `/admin/board-members/:id/reactivate` | Super admin | Restore login (new password on next sign-in) |
| POST | `/admin/board-members/:id/update-email` | Super admin | Change board login email (alias table updated) |

**Board member list (`listBoardMembers`):** Backfills empty `display_name` from linked CRM `members.full_name`; `linkBoardMemberToCrm` on invite sets `display_name` when CRM email matches.

### `portal.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/members` | Admin | Member list (`?limit=2500`) |
| GET | `/invoices` | Admin or Member | Invoice list; member query matches `member_id` **or** `recipient_name` |
| GET | `/invoice-stats` | Admin | Aggregates: paid/unpaid, Zelle & BofA, `event_summary` with `amount_owed` |
| GET | `/member-stats`, `/stats`, `/events`, `/deceased-members` | Public/Admin | Active count + event catalog |
| GET | `/profile`, PATCH `/profile` | Member | Profile + beneficiary |
| PUT | `/beneficiary` | Member | Submits change request (board approval) |
| GET | `/activity` | Admin or Member | Audit log |
| POST | `/invoice` | Admin | Mark paid (with approval flow where configured) |

**Member invoices:** `dedupeInvoicesByEvent()` on server; portal counts **Deaths Paid** = paid invoices with `event_number` (not legacy unlinked rows).

**Recipient matching:** Many invoices were bulk-imported with wrong `member_id` but correct PayPal `recipient_name`. Portal matches by member's `paypal_name` / `full_name` so counts stay accurate (~21 active members affected).

### `apply.js` (public + admin highlights)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/site-stats` | — | `active_count`, `amount_per_member`, `payout_amount` |
| GET | `/current-announcement` | — | Latest Active event (by **`event_number` DESC**) or no-collection memorial; venues from `notes` JSON |
| GET | `/waiting-list/status` | — | Live queue; `added` only if `Added as Member` |
| POST | `/waiting-list`, `/contact` | — | Public forms; `/contact` accepts `source`: `website`, `portal`, **`portal-login`** (phone not found on sign-in) |
| POST | `/contact-messages/:id/reply` | Admin (`messages` perm) | Append board reply (follow-ups append; no edit/delete); email/text member via `notifyMember()` with branded HTML |
| POST | `/verify`, `/membership` | — | Application gate (must be `Invited to Apply`) |
| GET | `/waiting-list` | Admin | Full queue + slot math |
| POST | `/waiting-list/:id/invite` | Admin | Send invitation |
| POST | `/waiting-list/:id/pass` | Admin (`waiting_list_invite`) | Pass invited non-responder — status → `Passed`, frees pipeline slot for next in line |
| POST | `/waiting-list/:id/reject` | Admin | Remove → status `Rejected` |
| GET/PATCH | `/applications/:id` | Admin | List / save review checklist |
| POST | `/applications/:id/approve-for-payment` | Admin | Vet + send PayPal registration invoice → `Awaiting Payment` |
| POST | `/applications/:id/complete` | Admin | Mark registration paid (Zelle) → create member |
| POST | `/applications/:id/reject` | Admin | Reject application |
| GET | `/qa/dashboard` | Admin | System Health + ONB step status |
| POST | `/demo-qa/test-notify` | Admin | Send test email to `DEMO_QA_EMAIL` (NTF-01) |
| POST | `/demo-qa/reset` | Admin | Reset QA demo cycle (DEMO_QA_EMAIL only) |

**Contact messages (`contact_messages`):** Sources: **website** (public Contact Us), **portal** (signed-in member), **portal-login** (cannot sign in — phone not found). On submit, board is emailed via SendGrid. On board reply: signed-in portal messages also appear under Home → **Messages from the Board**; **portal-login** users cannot see portal replies — board reply is **emailed** to the address they provided (**email required** for `portal-login`). Admin Messages tab labels login help; reply modal forces email notify for login help. **Communication policy:** append-only — second+ replies **append** to `board_reply` with `[[FOLLOWUP:ISO]]` markers; no delete/edit UI or API; email sends **only new follow-up text**. Branded HTML reply emails via `notify.js` `buildBoardReplyEmail()`. CSS `admin-tracker.css` **admin74** (email inbox + Pass on waiting list).

**Membership onboarding (live):** invite → apply → board review (3 checks) → **Approve & Send Invoice** → PayPal registration fee → **member created automatically on PayPal paid** (sync or completion job). **Mark Registration Paid** / **Approve & Add to CRM** = fallback for Zelle/BofA. See **`docs/membership-onboarding-workflow.md`** and **`docs/system-validation-playbook.md`**.

**QA test identity (local, June 2026):** `hibretedirtest@gmail.com` · **`3105550199`** (was `3103867475` — collided with Behailu #52; fixed via `fix_qa_phone_collision.js`) · `Hibret Edir QA Test` · `REGISTRATION_FEE=1` · `MEMBER_CAP=201`. Set matching `DEMO_QA_PHONE` on Netlify. Full cycle validated locally (waiting list → invite → apply → approve → PayPal $1 → sync → active member). Reset: `npm run demo:reset:apply` or Admin **Reset demo cycle**.

### PayPal sync

| Function | Role |
|----------|------|
| `paypal-sync` | GET invoice ID list; POST batch sync (Admin **Sync PayPal** button) |
| `paypal-sync-scheduled` | Cron `0 * * * *` — **Netlify shows "Every hour"**; only syncs **9 AM & 6 PM Pacific** |
| `paypal-sync-background` | Full batched pull (invoked by scheduled or `CRON_SECRET`) |

See **`docs/scheduled-paypal-sync.md`** for schedule explanation.

**Manual sync:** Admin → Invoices → **Sync PayPal** · `npm run sync:paypal` · force: `/.netlify/functions/paypal-sync-scheduled?secret=CRON_SECRET`

**PayPal member matching:** Recipient name matched **before** email on sync (`paypal-sync.js`).

**PayPal sync — invoice_number collisions (June 2026):** Event invoices use numeric `invoice_number`; registration refs (`REG-*`) store **`null`**. Legacy CRM rows may have a number but no `paypal_invoice_id` — sync **updates those orphans** instead of inserting duplicates. `sanitizeInvoiceNumbers()` drops numbers already taken by another PayPal invoice.

**Payment stats:** `PAID` → PayPal; `MARKED_AS_PAID` → Zelle & BofA (`payment-methods.js`).

**Registration payment completion:** `paypal-sync.js` calls `processPaidRegistrationInvoices()` after sync. Core logic in `membership-completion.js`.

### `receipts.js`, `payouts.js`, `notify.js`, `sync.js`

Unchanged in role: receipts workflow, payout fund, notifications, internal CRM sync (not PayPal).

---

## 7. Frontend — what exists and what's wired

### Public site (`public/index.html`)

Hash routing (`#announcement`, `#apply`, etc.). English + Amharic.

**Live from API:**

- Hero **active member count**, per-death amount, payout amount → `apply/site-stats`
- **Current announcement** → `apply/current-announcement` — full **memorial letter** (prayer/burial/payment) + summary box; **Pay Now** and PayPal line → **`/portal/`** (not legacy `hibretedir.com/invoice`)
- **Waiting list status** → `apply/waiting-list/status` (same PostgreSQL queue as Admin; hides Added/Rejected/Canceled; renumbers place in line)
- Public labels: **Added** only for members; **Invitation Sent** for invited / in-progress applicants
- **Desktop hamburger menu** — dropdown below nav bar (`#mmenu` outside `.nav` to avoid `backdrop-filter` positioning bug; JS `positionMmenu()`)
- **Mobile nav (June 17)** — `touch-action: manipulation` (no double-tap delay); hover styles wrapped in `@media (hover: hover)`; menu closes on scroll without jitter; **Back to Home** visible on PC when a section hash is active (`has-section-hash`)
- **Make a Payment** section — PayPal card links to member portal; Bank of America account #002174902906 under Upload Receipt

Placeholders show `—` until API loads. Regenerate static JSON: `python scripts/mark_added_waiting_list_members.py` (runs export at end) or import script.

**Removed:** In Remembrance section and `memorial.json`.

### Member portal (`public/portal/index.html`)

**Live:**

- Invoices from DB with recipient-name matching + event dedupe
- **Deaths Paid** = count of **paid event invoices** (unique events)
- Notifications built from live unpaid invoices + board message replies + activity (no mock array)
- **Instant tab switches (June 17)** — Home / Invoices / Profile / etc. render from in-memory cache immediately; background fetch only when tab data is missing or stale (60s TTL). Lazy-load: activity + board messages only when Notifications / Board Messages opened; events when Upload opened. Invoice fetch capped at **150** per request (was 2500). Thin gold loading bar under nav during background refresh.
- **Bilingual logged-in UI (June 17)** — `PORTAL_I18N` + `pt()` helper; EN/አማ toggle updates portal screens (not auth-only)
- **Auth UX** — language toggle inside auth card; wider login card on mobile; **phone-help panel** when number not found; error auto-scroll
- **Login help (July 3, `portal-login`)** — If phone not in CRM, member can message board; **email required** (they cannot sign in to read replies). Copy: board will reply by email. Server validates in `apply.js` `/contact`.
- **Portal auth (July 3)** — When a phone matches **multiple** CRM members, portal shows **Choose Account** (display name only). Each member has a **separate PIN**; `create-pin` / `verify-pin` / PIN reset require `memberId`. **Inactive** accounts appear labeled but cannot sign in or set a PIN. Single match skips picker. QA test rows hidden from picker (`isQaTestMember`). CSS `app-theme.css` portal29.
- **Portal auth (legacy)** — `rankMemberForPortalAuth()` still used only when a single auto-pick fallback is needed internally; no longer auto-picks for login when multiple real members share a phone.
- **Profile** — legacy CRM rows may have join **dates** in `address` column; `portal.js` `normalizePortalAddress()` + portal UI show “Not on file” instead of a date
- **Beneficiary** — `beneficiary_import_pending` for paper members until board imports digital record
- **Contact Us (signed in)** — phone/email always synced from logged-in `me` (readonly); cleared on sign-out; replies visible in portal + optional email/SMS; portal parses follow-up thread bubbles (`parseBoardReplies`)
- **Timestamps (July 3)** — all portal datetime displays use `public/js/datetime-la.js` → Pacific (Los Angeles)
- Receipt upload, profile edit, beneficiary change request, PIN reset
- Nav brand link (logo + “Back to Main Site”) — no persistent gold border bleeding into tab bar (`app-theme.css` portal29)

### Board Admin Page (`public/admin/index.html`)

**Sidebar:**

| Section | Views |
|---------|-------|
| Main | Members CRM, Invoices, Approval, Receipts, Messages |
| Reports | Event Summary, Payout Fund |
| **Announce** | Memorial intake — collection-first flow, spouse question, venue dropdowns, live preview, PayPal event auto-link when collecting |
| System Health | **Dashboard** (integrations, **Send test email**, health checks) · **QA Testing** (ONB step playbook incl. NTF-01) |
| Security | **Access Management** (super admin only), Activity Log |

**Live stats bar:** Unpaid, Paid (PayPal), Zelle & BofA, Late — colors: green / green / red. **Partial** invoices are not counted as late.

**Board permissions (June 17):** Super Admin (`BOARD_SUPER_ADMIN_EMAILS`) manages **Access Management** (master-detail: pick member → grant tier or individual perms). **17 granular keys** in `board_perms` JSONB (`board-permissions.js`). **Access tiers:** **Restricted** (read-only Members CRM only — hides other nav), **Read-only** (view all except Security), **Basic** (notes + PayPal sync + messages), **Operation** (+ edit members, reset/approve PIN), **Approver** (broad ops without full CRM write). Tier buttons highlight gold when active (`board-access-preset-btn.is-active`). **Security** (Access Management + Activity Log) is **super-admin only**. Read-only board members cannot see Security. Enforced in `board-permissions.js` across `auth.js`, `apply.js`, `portal.js`, `payouts.js`, `receipts.js`, `paypal-sync.js`.

**Access Management UX (June 17, `ec09b90`):** Super-admin **Security → Access Management** (mobile: ☰ → Security). **Add board member** form at top (email → invite). Per member: **Remove** (deactivate — stays in list), **Re-add**, **Reset password**, **Update email**, tier presets + individual checkboxes → **Save access**. Deactivated members remain visible; super admins cannot be removed (env `BOARD_SUPER_ADMIN_EMAILS`). **Mobile:** controls-only layout — hides helper paragraphs, permission descriptions, duplicate login line, joined/summary chips (full detail on PC). CSS cache bust `admin69` in `admin-tracker.css`.

**Board vs CRM names:** `board_members.display_name` is the label in Access Management only. **CRM member names** (`members.full_name`, `paypal_name`, `spouse_name`) are edited only in **Members CRM**. On invite/link, empty `display_name` auto-fills from CRM. `node scripts/sync_board_member_names.js --apply` links board logins to CRM `member_number` and sets `display_name` only when empty (use `--force-names` to reset from roster). **Multi-email login:** `board_member_emails` — one account, multiple emails (e.g. `babimuli@gmail.com` + `lily_mulugeta@yahoo.com`).

**Admin auth UI (June 17):** Logout visible on PC when signed in (sidebar foot + header); `ADMIN_AUTH_ENABLED=false` locally still shows logout for dev session.

**Members CRM (June 17):** List shows **Member** + **Spouse** columns; profile form has separate spouse field; `members.spouse_name` backfilled from `full_name` where `Primary/Spouse` format exists. **`home_phone` UI label = Spouse cell** (July 30) — stores spouse mobile; DB column unchanged; portal login still matches both `mobile` and `home_phone`.

**Refresh behavior:** Members and Invoices tabs refetch on switch; Event Summary loads full invoices + stats.

**Event Summary:** `amount_owed` from API (sum of unpaid `amount_due`), not `unpaid × 110`.

**PayPal:** **Sync PayPal** on Invoices tab (batched POST). Stats cache invalidated after sync and member changes.

**Messages (Admin → Messages → Contact):** Email-style **split-pane inbox** (list + reading pane; filters All / Needs reply / Replied; mobile: list → tap → thread with ← Inbox back). PIN reset requests + contact inbox. **Login help** rows (`source=portal-login`) — member could not sign in; reply is **emailed only** (full reply text, no “sign in to portal” wording). Reply modal: **Reply to Member** / **Send Follow-up** (always empty textarea; multiple green reply bubbles in thread). Branded HTML emails (`buildBoardReplyEmail`). Gold **Reply** button left-aligned in reading pane footer. **Timestamps:** Pacific (LA) via `datetime-la.js`.

**Activity log & timestamps (July 3):** All admin datetime displays (Activity log, member journey, board access, payouts, QA dashboard, message threads, board note stamps) use **`America/Los_Angeles`**. Activity log banner notes “Times shown in Pacific (Los Angeles).” Server: `netlify/functions/datetime-la.js` for invoice sent dates (`toDateOnlyString` — fixes UTC off-by-one on DATE columns), sync note stamps, follow-up invoice dates, PayPal approval notes.

**Approval view (three top tabs):**

| Tab | Contents |
|-----|----------|
| **Waiting List** | All · Invited · In Progress — invite from **All** with **Send Invitation →**; **Pass** on Invited (no application yet) frees the slot for the next person |
| **Applications** | Membership only — Pending (incl. Awaiting Payment) · Approved · Rejected |
| **Board Requests** | Operational approvals — **Mark Paid**, **Beneficiary** changes; own Pending · Approved · Rejected · All |

| Action | Where |
|--------|-------|
| Invite to apply | Waiting List → **Send Invitation →** (eligible rows) |
| Pass non-responder | Waiting List → Invited → **Pass** (withdraws invite, next in line becomes eligible; person stays on list as `Passed`) |
| Vet new member | Applications → 3 checks (name, fields, ID) → **Approve & Send Invoice** |
| Zelle registration | Applications → **Mark Registration Paid** when Awaiting Payment (unpaid) |
| After PayPal paid | Member auto-created on sync; **Approve & Add to CRM** only if sync lag / manual pay |
| Reset QA test | System Health → **Reset demo cycle** or `npm run demo:reset:apply` |
| Mark invoice paid (dual control) | Board Requests → Mark Paid requests; invoice table **View in Approval** opens Board Requests → Pending |

Slot math (when `MEMBER_CAP=201` + `DEMO_QA_ENABLED`):

- **`production_cap`** = 200 — used for **real** waiting-list invites (`invite_slots_remaining = production_cap − active − in_pipeline`).
- **Slot 201** — reserved for **`DEMO_QA_EMAIL` only**; shows `qa_reserved_slot_open` when `active + in_pipeline < 201`.
- Only the QA test row gets **Ready to Invite** / **Send Invitation** when production is full but the validation slot is open.
- Server rejects non-QA invites if only the reserved slot remains (prevents board from accidentally inviting real applicants).

Without QA mode: `invite_slots_remaining = MEMBER_CAP − active − in_pipeline` as before.

**Data:** Live API + `invoices-snapshot.json` fallback when DB unavailable.

### Membership application (`public/application/index.html`)

Waiting list verify gate (email + phone, must be **Invited to Apply**) → full form → `POST apply/membership`.

**June 2026:** `/verify` returns parsed **address, city, state, zip** from waiting-list one-liner (`geo.parseAddressForForm`). **Upload CA ID** button styled green (required). Desktop hides **Take photo**; mobile keeps both. Death beneficiary + emergency contact validation (client + server). Submit confirmation above button.

### Waiting list status page (`public/waiting-list-status/index.html`)

Full queue table with **Status** column (same API as home page).

**Docs (board + marketing):** `docs/membership-onboarding-workflow.md` · `docs/automation-registry.md` (all workflows) · `docs/automation-showcase.html` (Meridian portfolio — **keep in sync with** `public/docs/`) · `docs/board-meeting-handout.html` · deployed at `/docs/` (`public/docs/index.html` hub).

**Meridian showcase** (`/docs/automation-showcase.html`): Ethio AI Solutions marketing case study. First-person AI agent **Meridian** narrates onboarding → memorial → payout with animated walkthrough. Browser **Web Speech API** (male UK English when available). **Mobile (June 13):** scroll to top on load/PLAY/loop; phase-2 scroll to terminal dots (ring stays visible); speech-gated slide advance; scroll-before-speech on phase 2 to avoid iOS freeze. **Closing CTA:** free consultation after `www.EthioAiSolutions.com`; banner links switch to [ethioaisolutions.com/contact](https://ethioaisolutions.com/contact) after closing pitch. TTS: Hibret → Hehbret, Edir → Eder, ID → `I D` (no pause).

---

## 8. Completed work (summary)

### Core platform (DONE)

Auth, portal, admin CRM, applications, waiting list, notifications, audit, payout fund, receipts, beneficiary approval, PIN reset, contact messages.

### June 2026 — Live data & PayPal (commits `8a78e85` → `8e86532`)

- [x] **Dynamic public site** — live member count, announcement, waiting list from DB
- [x] **Dynamic portal** — Deaths Paid, invoice dedupe, recipient-name matching, live notifications
- [x] **Dynamic admin** — invoice stats cache, Zelle & BofA split, event `amount_owed`, tab refresh
- [x] **Scheduled PayPal sync** — 9 AM & 6 PM Pacific via `paypal-sync-scheduled` + `paypal-sync-background`
- [x] **Removed In Remembrance** — section and memorial JSON/scripts
- [x] **Admin Security section** — Activity Log moved under Security heading
- [x] **Schema** — indexes, `paid_note`, `invoice_mark_paid_requests`
- [x] **Netlify deploy fix** — `SECRETS_SCAN_OMIT_KEYS` for `PAYPAL_ENV` false positives (`aria-live`, etc.)
- [x] **Docs** — `docs/scheduled-paypal-sync.md`

### June 2026 — Membership onboarding & waiting list

- [x] **Onboarding pipeline** — vet → PayPal $200 on approve → member on payment (`membership-completion.js`, `paypal-registration-invoice.js`)
- [x] **Admin Approval UI** — Approve & Send Invoice, Mark Registration Paid; removed Ready to Invite tab
- [x] **Waiting list import** — Excel with email/phone (~98 rows); 9 marked `Added as Member`
- [x] **Public waiting list fix** — “Added” only for actual members; **Invitation Sent** for invited/applicants (fixed position 1–11 bug)
- [x] **Docs** — `membership-onboarding-workflow.md`, board handout, automation showcase
- [x] **Ops scripts** — `mark_invitations_sent.py`, updated public JSON export
- [x] **Admin Approval split** — **Board Requests** tab for Mark Paid + beneficiary ops; **Applications** = membership only
- [x] **Public announcement restore** — memorial letter loads from `events.notes`; `set_event_announcement.js`; Event #30 (Brook Zewdie) backfilled
- [x] **DB migrate resilience** — `run_schema.js` connect timeout 60s, query 120s, 3 retries (Render intermittent timeouts)

### June 2026 — Meridian showcase & docs hub

- [x] **`docs/automation-registry.md`** — Master automation catalog (ONB-*, EVT-*, PAY-*, etc.)
- [x] **`public/docs/index.html`** — Docs hub at `/docs/`
- [x] **Meridian showcase** — First-person agent narrative, voice + animation, Ethio AI closing line each cycle
- [x] **Voice** — Male UK English preference, natural/Neural voices, phrase-chunk pacing (browser TTS)
- [x] **`dev-local.js`** — Serve `/docs/` directory `index.html` locally
- [x] **Sync rule** — Edit `docs/automation-showcase.html` then copy to `public/docs/` before deploy (no build step)

### June 2026 — Notifications (SendGrid live)

- [x] **SendGrid domain auth** — `hibretedir.com` DNS in Wix (`em2759`, `s1._domainkey`, `s2._domainkey`, `_dmarc`)
- [x] **Single sender verified** — FROM `notifications@hibretedir.com`, REPLY `hibretedirtext@gmail.com`
- [x] **`notify.js`** — `reply_to` in SendGrid payload; defaults + `SENDGRID_REPLY_TO` env
- [x] **`npm run test:notify`** — config check + `--send` live test; email confirmed in inbox
- [x] **Netlify env** — `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_REPLY_TO` (redeploy after set)
- [ ] **Twilio SMS** — account + number + `TWILIO_*` on Netlify; then smoke-test invite SMS

### June 2026 — Board permissions, queue order, CRM ops (`5368d35`)

- [x] **Granular board permissions** — `board-permissions.js`; schema + `auth.js` JWT/me/invite; API guards; Admin read-only + Board Access checkboxes + hover tooltips
- [x] **Super admin** — `BOARD_SUPER_ADMIN_EMAILS` env; manages other board grants
- [x] **Notes + sync** — PayPal sync allowed without full CRM write access
- [x] **Partial ≠ late** — Admin stats/pills and portal `is_late` exclude partial payments
- [x] **Same-day waiting list order** — `scripts/fix_waiting_list_order.py`; uses registration order # as intraday tie-breaker on `applied_at` (39 rows fixed June 16)
- [x] **CRM board import** — Yonas Tesema & Misrak B. Demessie added as member **#232** (`misrak1940@gmail.com`); waiting list #12 → Added as Member
- [x] **Schema migrate** — user ran `npm run db:migrate` locally June 16 after push

### June 2026 — Member portal mobile perf & UX (June 17, `21e1514`)

- [x] **Instant tabs** — no full API refresh on every tap; 60s client cache; lazy per-tab loads
- [x] **Smaller invoice payload** — portal fetch limit 150 (server default 500)
- [x] **Logged-in Amharic** — `PORTAL_I18N` across home, invoices, profile, notifications, contact
- [x] **Auth fixes** — phone lookup priority (`rankMemberForPortalAuth`); QA phone moved off Behailu #52; contact form always uses session member
- [x] **Profile address** — hide legacy date strings stored in CRM `address` column
- [x] **Beneficiary import pending** — friendly message for paper-application members
- [x] **Nav UI** — brand border overlap with tab bar fixed; loading bar for background sync
- [x] **Netlify secrets scan** — `sync_board_member_names.js` roster keyed by `member_number` only (no hardcoded super-admin email)
- [x] **Deploy** — `428182a`, `6a26f50`, `21e1514` on `main`

### June 2026 — Access Management & board permissions (June 17)

- [x] **Access Management UI** — Master-detail layout; board names by CRM `#` + `display_name` (not email); access tier presets with gold active-state highlight
- [x] **17 granular permissions** — `board_perms` JSONB; default invite = Basic rights
- [x] **Restricted tier** — `view_members_crm` only; Members CRM read-only; API + nav gated
- [x] **Security super-admin only** — Access Management + Activity Log hidden from non–super-admins
- [x] **Board display names** — Separate from CRM; edits in Access Management do not update `members` table; CRM name auto-fill on invite/link
- [x] **Board login lifecycle** — Invite, deactivate (Remove), reactivate (Re-add), update email, reset password (`auth.js` `update-email` action)
- [x] **Mobile Access Management** — Stripped non-essential copy on ≤900px; all actions retained; PC keeps full descriptions
- [x] **Multi-email board login** — `board_member_emails`; merged duplicate accounts (Betelhem, Genene)
- [x] **`sync_board_member_names.js`** — Roster links board emails → CRM `member_number`; advisor role (Tsehaye Mogus = Restricted)
- [x] **CRM spouse column** — `members.spouse_name`; list + profile; migrate backfill from `full_name`
- [x] **Admin + public mobile nav** — Double-tap fix, logout on PC, public hamburger scroll/back-home
- [x] **Schema migrate** — `board_member_emails`, `display_name`, `spouse_name`; run `npm run db:migrate` June 17
- [x] **Deploy** — `ec09b90` on `main` June 17

### June 2026 — Announcement intake & public site (`1684565`)

- [x] **`event-announcement.js`** — memorial intake API, `current-announcement`, venue list/upsert, PayPal balance hint for collection suggestion
- [x] **Admin → Announce** — collection-first (Yes/No gates form); spouse continue (`yes`/`no`/`no_spouse`); auto next event # + create `events` row on save when collecting; venue dropdowns with presets
- [x] **Schema** — `memorial_announcements`, `announcement_service_venues`; migrated + `npm run db:seed-ann-venues` (6 LA presets) June 16
- [x] **Public announcement fix** — select by **`event_number` DESC** (not `updated_at`); Brook #30 not Almaw #18
- [x] **Public payments** — announcement + payment section route PayPal to **`/portal/`**; BofA direct deposit on payment page
- [x] **Hamburger menu (desktop)** — dropdown below nav (menu moved outside `.nav`; `positionMmenu()`)
- [x] **QA email test** — `POST /demo-qa/test-notify`, System Health **Send test email**, NTF-01 in playbook; fixed `demo-qa-dashboard.js` integrations destructuring bug
- [x] **Deploy** — pushed `1684565` to `main`
- [ ] **EVT-06** — bulk PayPal invoices to all members on new event (noted in Admin UI)

### Still partial / ops

- [ ] **Twilio SMS** — **NEXT** — SendGrid done; follow `docs/notifications-setup.md` § Twilio
- [x] **Local E2E onboarding QA** — full cycle with `DEMO_QA_*` + `MEMBER_CAP=201` + `$1` PayPal (June 14, 2026)
- [ ] **Netlify env for QA** — set `DEMO_QA_*`, `MEMBER_CAP=201`, `PUBLIC_SITE_URL`, `REGISTRATION_FEE` when deploying
- [ ] Admin create event → bulk PayPal invoices via API
- [ ] All members have portal PINs (ops)
- [ ] Fix mislinked `member_id` on bulk-imported invoices (recipient match covers portal; admin may still show wrong owner on some rows)
- [ ] S3 for receipts (optional; currently DB base64)
- [ ] Automated payment reminders (day 3/7/14)

---

## 9. Not done yet / known gaps

| Item | Notes |
|------|-------|
| ~~Admin UI for event announcement~~ | **Done** — Admin → **Announce** (`1684565`); CLI `set_event_announcement.js` still available |
| `events.js` | No admin “create event → auto ~197 invoices” via PayPal API (EVT-06) |
| Automated payment reminders | Not started |
| Twilio SMS bot | Not started |
| Welcome email + digital membership card | Not started (approve notify exists; no card asset) |
| 4-month waiting period tracking | Not started |
| Reporting (event collection, delinquency) | Not started |
| Receipt storage at scale | Base64 in Postgres OK for now |
| End-to-end onboarding test | **Done locally** (June 2026) — see `docs/system-validation-playbook.md`; production repeat after Netlify deploy |

**Done (June 2026):** Registration fee PayPal on board approve → member on payment — see `docs/membership-onboarding-workflow.md`.

---

## 10. Business rules (implement carefully)

From by-laws / handoff:

- Ethiopian origin, **50 miles** of Downtown LA
- **$200** one-time registration fee — PayPal invoice **after** board approves application (not before vetting)
- **$110** per event, due within 3 days
- **4-month waiting period** for new members before benefits
- **$15,000** payout; **2 board approvals** required
- **200** member cap
- Coverage: member, spouse, children up to 26
- **Beneficiary changes** require board approval

---

## 11. Agent conventions

1. **Minimal diffs** — vanilla JS + CSS; match existing patterns.
2. **Bilingual** — `.en` / `.am` pairs on public and portal strings.
3. **Mobile first** — most members use phones.
4. **Do not commit or push** unless the user explicitly asks.
5. **Do not commit** `.env`, secrets, or `data/` exports.
6. **Database:** timeouts via `db.js`; run `npm run db:migrate` after schema changes.
7. **Production:** `ADMIN_AUTH_ENABLED=true`, `CRON_SECRET` set on Netlify.
8. **Restart dev server** after new API routes.
9. **Showcase deploy:** After editing `docs/automation-showcase.html`, copy to `public/docs/automation-showcase.html` — Netlify publishes `public/` only.

---

## 12. Recent session changelog

### July 30, 2026 — Waiting list Pass for non-responders

- **Pass button** on Admin → Waiting List → Invited rows (`Invited to Apply`, no application yet).
- `POST apply/waiting-list/:id/pass` → status **`Passed`**, clears `invited_at`, frees pipeline slot; next Pending/Registered becomes eligible.
- **Passed** stays on the list, ranked **after** Pending/Registered for the next invite round; can be re-invited later. Application verify still requires `Invited to Apply`.
- UI: amber **Pass** next to Invited; CSS `admin74`. Activity: `waiting_list.pass`.

### July 3, 2026 — Messages inbox, HTML replies, follow-up policy, LA timezone

- **Admin Messages inbox (`admin73`)** — Email-style split pane: message list + reading pane; filters **All / Needs reply / Replied**; mobile list → thread with back nav. Clearer who replied (Board vs Board follow-up bubbles).
- **HTML board reply emails** — `notify.js` `buildBoardReplyEmail()` — green/gold branded HTML + plain text; `apply.js` passes `html` to `notifyMember()`.
- **Append-only follow-ups** — No delete/edit on board replies. Second+ replies **append** via `appendBoardReply()` + `[[FOLLOWUP:ISO]]` delimiter; email sends **only new text**; portal + admin parse multiple reply bubbles (`parseBoardReplies()`).
- **Reply button UX** — Gold gradient, larger, left-aligned in inbox reading pane footer.
- **Pacific timezone sitewide** — `public/js/datetime-la.js` loaded on admin, portal, application; `fmtDate`, `fmtDateTimeLA`, `fmtNowLA`. Fixes UTC timestamps appearing ~7–8 hours ahead. Server helper `netlify/functions/datetime-la.js` for invoice dates, sync stamps, PayPal approval notes, follow-up markers.

### July 3, 2026 — Shared-phone portal login + CRM cell import + login-help email

- **Shared phone picker** — `check-phone` returns all matches; new portal screen **Choose Account** when `members.length > 1`; display name only (no member # on picker). **Inactive** rows shown as non-clickable. **Separate PIN per member** — `memberId` on `create-pin`, `verify-pin`, change-PIN modal, and PIN reset when ambiguous.
- **Login help email (portal-login)** — Phone-not-found panel requires **email**; board replies from Admin → Messages are **emailed** to that address (SendGrid). Login-help email template includes full reply + call (424) 547-5594; no portal sign-in instructions. Admin UI: hint banner, forced notify on login-help replies.
- **Known duplicate mobiles (Render CRM, July 2026):** #178 Yared / #179 Nunu (`424-436-7048`); #46 Dawit / #224 Etenat; #91 Mik / #92 Almaz; #172 Metasebia / #225 Bizuayhu. Shared numbers are intentional (family); portal now disambiguates.
- **CRM cell import (ops, applied to Render):** Board Excel `data/members cell number.xlsx` → `scripts/annotate_member_cell_review.py` (match PayPal-style name, sort A–Z, annotate DB columns) → board review → `scripts/apply_member_cell_updates.py` applied **25** `mobile` updates; backups in `data/mobile_backup_*.csv` (gitignored). Shared phones allowed on apply (log only).
- **PayPal sync date (June 17, `b48d782`):** Admin “Report as of” no longer reverts to stale `invoices-snapshot.json` date.
- **Deploy:** `97b47df` (picker + cell scripts); `c2d5de2` (login-help email).

### June 17, 2026 — Board Access Management UX + mobile admin (`ec09b90`)

- **Access Management** — Invite at top; per-member Remove (deactivate, stays in list), Re-add, reset password, update email; tier presets (Restricted → Approver) with gold **active** button state; Read-only preset clears all perms
- **CRM name sync** — `listBoardMembers` backfills empty `display_name` from CRM; `linkBoardMemberToCrm` sets name on invite when email matches member
- **Mobile simplicity** — `board-access-fine-print` hides helper text, perm descriptions, duplicate login line, joined/summary on phone; full detail on PC (≥901px)
- **Removed clutter** — “Linked to CRM — edit names in Members CRM” hint; redundant intro copy
- **Admin auth UI** — Logout visible on desktop when signed in; sidebar foot pinned
- **Public site mobile** — Nav double-tap fix (`touch-action: manipulation`); scroll jitter menu close; Back to Home on PC with active section hash
- **API** — `update-email`, `reactivate` board-member actions in `auth.js`
- **Ops** — User ran `npm run db:migrate` + pushed `ec09b90` to `main` June 17

### June 17, 2026 — Member portal mobile performance & UX (`21e1514`)

- **Problem:** Every tab tap fired ~6 Netlify function calls (member, profile, invoices×2500, activity, messages, events) — very slow on real phones over cellular.
- **Fix:** `tab()` switches UI instantly from cache; `ensureTabData()` / `syncTabData()` background-fetch only what each tab needs; 60s TTL; GET requests no longer cache-busted; invoice limit 150.
- **Auth:** QA test members shared phone with Behailu #52 → wrong “Hi Hibret” login; `rankMemberForPortalAuth()` + `fix_qa_phone_collision.js` → QA phone `3105550199`.
- **i18n:** Amharic toggle now updates logged-in portal (was auth screens only).
- **Profile:** CRM `address` sometimes holds `2018-11-01` join dates — normalized server-side + empty in UI.
- **Contact form:** Always overwrites phone/email from `me` (fixed wrong contact info when testing as another member).
- **CSS:** Nav brand gold border no longer overlaps Home/Invoices tab row.
- **Local workflow:** Test mobile via `http://<LAN-IP>:8888/portal/` — avoid push-for-every-tweak.
- **Deploy:** Pushed `main` June 17.

### June 17, 2026 — Access Management, permissions, CRM spouse (earlier session)

- **Access Management** — Replaced 17-checkbox-per-row with master-detail; tier buttons (Restricted, Read-only, Basic, Operation, Approver); names show as `#N Name` without emails in list
- **Permissions model** — `board_perms` JSONB with 17 keys; `isRestrictedMembersOnly()` gates portal API + admin nav to Members CRM only
- **Board vs CRM** — `display_name` on `board_members` only; sync script never writes `members`
- **Email aliases** — `board_member_emails` table; `findAdmin()` matches any alias; duplicate board rows merged
- **Roster** — 7 board logins + super admin (#52 Behailu); Tsehaye Mogus (#11) = **advisor** + **Restricted**
- **CRM** — `spouse_name` column; Members list Spouse column; profile side-by-side name/spouse
- **Scripts** — `sync_board_member_names.js`, `fix_board_permissions_regression.js`
- **Deploy** — User requested push June 17; run `npm run db:migrate` before/on deploy

### June 16, 2026 — Announcement intake, public site, DB (deploy `1684565`)

- **Admin → Announce** — collection-first UI; spouse question; PayPal event linking; venue memory; memorial-only path (`memorial_announcements`)
- **`event-announcement.js`** — extracted from `apply.js`; current-announcement logic; `DEFAULT_SERVICE_VENUES` (3 churches, 3 cemeteries)
- **Public site** — PayPal links → `/portal/`; hamburger dropdown positioning; footer/back-button polish
- **DB** — `memorial_announcements`, `announcement_service_venues`; user ran `db:migrate` + `db:seed-ann-venues` from laptop (= Render)
- **Clarified ops** — no separate Render migrate step; local `.env` is production DB
- **Next:** Twilio SMS + production invite smoke-test

### June 16, 2026 — Board permissions, queue order, CRM import

- **Granular board permissions** — Replaced binary `write_approved` with super admin + four scoped grants; `board-permissions.js`; enforced on admin APIs; UI gates + permission chip tooltips.
- **Partial payments** — No longer counted as late in admin or member portal.
- **Waiting list same-day order** — Imported rows shared midnight `applied_at`; fixed with `scripts/fix_waiting_list_order.py` using `data/Order of Registration.xlsx` order numbers (file removable after run).
- **CRM** — Yonas Tesema (primary) / Misrak B. Demessie (spouse) → member #232; registration fee recorded; `scripts/add_yonas_misrak_crm.js`.
- **Deploy** — Pushed `5368d35` to `main`; user ran `npm run db:migrate` locally (DB-only — no re-push needed).
- **Next:** Twilio SMS + production invite smoke-test.

### June 14, 2026 — QA reserved slot (invite guard)

- **`getProductionMemberCap()`** — when `MEMBER_CAP=201`, waiting-list invite math uses **200**, not 201.
- **Only `DEMO_QA_EMAIL`** may be invited when production slots are full but validation slot 201 is open.
- Admin banner clarifies “no open slots for waiting list” + QA-only reserved slot; no **Send Invitation** on real applicants in that state.
- Server **409** if a board member tries to invite a non-QA row when only the reserved slot is available.

### June 14, 2026 — System Health, QA onboarding, PayPal sync fix

- **Admin System Health** — sidebar split: **Dashboard** (integrations + health checks) and **QA Testing** (ONB step playbook); routes `#health-dashboard`, `#qa-testing`.
- **QA demo cycle** — `demo-qa-reset.js`, `demo-qa-dashboard.js`; `DEMO_QA_ENABLED`, reserved slot **`MEMBER_CAP=201`**; QA email bypasses queue rank when slot open; **`npm run demo:reset:apply`**.
- **Full local onboarding validated** — waiting list → invite → apply → approve → PayPal $1 → paid → active member (auto on payment); reset and repeat.
- **Application form** — address prefill splits city/state/zip (`geo.js`); green **Upload CA ID**; beneficiary/emergency required fields; server validation in `apply.js`.
- **PayPal registration invoice** — extract ID from Location header; reuse existing `REG-{id}` invoice; store `invoice_number: null` in CRM.
- **PayPal sync** — `REG-*` → null; link orphan rows (number but no PayPal ID); sanitize duplicate `invoice_number` across PayPal invoices (~2.3k pull).
- **Invites / email** — `PUBLIC_SITE_URL`, short `/apply` link, SendGrid click tracking off; `notify.js` HTML invite.
- **Dev** — `dev-local.js` port-in-use message, function cache bust, QA banner; `/apply` redirect.
- **Docs** — `docs/system-validation-playbook.md`.
- **Scripts** — `demo_cycle_reset.js`, `test_qa_invite_local.js`, `test_invite_email.js`, `npm run test:qa-invite`.

### June 13, 2026 — SendGrid live + Twilio next

- **SendGrid:** Domain auth on Wix DNS; single sender verified; API key in `.env` + Netlify; test email to `hibretedirtext@gmail.com` landed in inbox.
- **Deliverability:** Use `@hibretedir.com` From (not Gmail); Reply-To board Gmail; domain auth > single sender for production.
- **Code:** `notify.js` Reply-To; `.env.example` updated; `SENDGRID_REPLY_TO` env var.
- **Wix cutover note:** DNS still on Wix while old site live — SendGrid records safe to keep through Netlify migration.
- **Next:** Twilio — buy SMS number, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, test with `npm run test:notify -- --send`.

### June 13, 2026 — Meridian showcase polish + notifications kickoff

- **Meridian mobile fixes:** phase-2 scroll (terminal dots, ring visible, Ethio AI banner); scroll-to-top on load/PLAY/pause/loop; speech-driven slide advance (no timer cutoff); phase-2 scroll-before-speech (fixes iOS freeze at Memorial).
- **Meridian CTA:** closing pitch mentions free consultation; `www.EthioAiSolutions.com` → contact booking after pitch completes.
- **TTS:** ID spelled `I D` (no comma pause).
- **Next:** SendGrid + Twilio — see `docs/notifications-setup.md`, `scripts/test_notifications.js`.

### June 12, 2026 — Meridian showcase & docs hub

- **Meridian marketing page** — `/docs/automation-showcase.html`: first-person AI agent voice, animated workflow, cycle-end Ethio AI Solutions pitch.
- **Voice:** Browser Web Speech API; prefers male UK Natural/Neural voices; phrase-chunk delivery; pronunciation map for Hibret/Edir.
- **New:** `docs/automation-registry.md`, `public/docs/index.html` (docs hub).
- **Fix:** `public/docs/` was stale vs `docs/` — showcase must be copied to `public/docs/` for localhost and Netlify.
- **`dev-local.js`:** `/docs/` directory serves `index.html`.

### June 11, 2026 — Board Requests + public announcement (local session)

- **Admin Approval:** third tab **Board Requests** for Mark Paid and beneficiary change requests; membership apps stay under **Applications** only.
- **Public announcement:** memorial letter (prayer/burial/payment) restored — reads `events.notes` JSON via `/current-announcement`; Event #30 backfilled.
- **New script:** `scripts/set_event_announcement.js` — set announcement details per event after PayPal sync creates bare event rows.
- **API:** `getCurrentAnnouncementFromDb()` filters `status = 'Active'`; supports `announcement_text` fallback and alternate venue field names.

### June 11, 2026 — Membership onboarding + waiting list (local session)

- Full onboarding workflow: invite → apply → review → PayPal $200 → active member on payment.
- New functions: `membership-completion.js`, `paypal-registration-invoice.js`.
- Admin: **Approve & Send Invoice**, **Mark Registration Paid**; removed **Ready to Invite** tab.
- Public waiting list: fixed false “Added” for positions 1–11; **Invitation Sent** for invited/applicants.
- Waiting list data: Excel import, 9 added members, Simon/Yohannes/Misrak marked invited/in progress.
- Docs: workflow spec, board handout, automation showcase (`public/docs/` copies).
- SendGrid/Twilio still unset — OK for local testing.

### June 2026 — `8a78e85` / `8e86532`

- Live data across public site, portal, admin (stats, announcement, invoices).
- Portal Deaths Paid fix: match invoices by `recipient_name` + count paid events only.
- PayPal scheduled sync (9 AM & 6 PM Pacific); `CRON_SECRET` required.
- Admin: Zelle & BofA stats, Security section, event owed from API.
- Removed In Remembrance; memorial JSON/scripts deleted.
- Netlify secrets scan omit for `PAYPAL_ENV`; deploy docs.

### June 2026 — `679151f` (earlier)

- Receipt API, PIN reset, beneficiary notifications, contact messages, memorial announcement template.

---

## 13. Quick troubleshooting

| Problem | Likely cause |
|---------|----------------|
| Admin shows no invoices | No `DATABASE_URL`; run `build:invoice-snapshot` |
| Portal Deaths Paid wrong | Stale cache — refresh; check `recipient_name` vs member `paypal_name` |
| Member missing invoices | Wrong `member_id` on import — portal uses recipient match; consider relinking in DB |
| Scheduled sync not running | `CRON_SECRET` missing on Netlify; redeploy after setting |
| Netlify build failed secrets scan | `PAYPAL_ENV=live` matches `aria-live` — fixed via `SECRETS_SCAN_OMIT_KEYS` in `netlify.toml` |
| `paypal-sync-scheduled` missing | Code not deployed — push latest `main` |
| New function 404 locally | Restart `npm run dev` |
| Receipts / PIN reset empty | Run `npm run db:migrate` |
| Notifications not sending (email) | Run `npm run test:notify`; check Netlify env + redeploy; verify SendGrid domain auth in Wix DNS |
| Notifications not sending (SMS) | Twilio not configured — set `TWILIO_*`; trial accounts require verified recipient numbers |
| Email goes to spam | Domain auth on `hibretedir.com` required; From must be `@hibretedir.com`; avoid Gmail as From |
| Invited person shows “Added” on public list | Regenerate JSON; ensure API uses status not position — see `isWaitingListPublicAdded()` in `apply.js` |
| PayPal sync duplicate invoice_number | Fixed June 2026 — orphan linking + REG-* null; restart dev and retry **Sync PayPal** |
| Application address not split | Re-verify waiting list after deploy — `/verify` uses `parseAddressForForm` |
| QA stuck “waiting for slot” | Restart `npm run dev` after `.env` change; confirm `DEMO_QA_ENABLED=true` |
| Real applicant shows Ready to Invite but only QA slot open | Fixed June 2026 — production cap 200; only `DEMO_QA_EMAIL` gets invite when slot 201 is reserved |
| Invite email 404 / long URL | Set `PUBLIC_SITE_URL`; use `/apply` short link |
| PayPal registration invoice fails | Check `PAYPAL_CLIENT_ID`/`SECRET`; reuse `REG-{id}`; **Mark Registration Paid** fallback |
| PayPal sync timeout on Netlify | Use Admin batched sync or `npm run sync:paypal`; background function for cron |
| Public announcement shows only summary, no service details | `events.notes` empty — run `node scripts/set_event_announcement.js <event#>` |
| Public announcement shows wrong deceased | Was `updated_at` ordering — fixed to `event_number DESC`; run `node scripts/check_current_announcement.js` |
| Hamburger menu opens at top of nav | `#mmenu` must be **outside** `.nav` (backdrop-filter trap); see `positionMmenu()` in `public/index.html` |
| `npm run db:migrate` timeout to Render | Retry; `run_schema.js` has 60s connect / 120s query / 3 retries |
| Showcase changes not visible on localhost | Netlify serves `public/` — copy `docs/automation-showcase.html` → `public/docs/` |
| Meridian voice sounds robotic on deploy | Normal — TTS runs in visitor's browser, not on Netlify; Edge + UK Natural voices sound best |
| Board admin read-only / 403 on save | Run `npm run db:migrate`; set `BOARD_SUPER_ADMIN_EMAILS` on Netlify; re-login after permission change |
| Restricted user sees all admin tabs | Re-login; confirm `view_members_crm` only in `board_perms`; hard-refresh admin |
| Access Management tier not highlighted | Hard-refresh admin (`admin-tracker.css?v=admin69`); click tier then check gold `is-active` on button |
| Access Management crowded on mobile | By design — helper text hidden ≤900px; use PC for full descriptions |
| Access Management name changed CRM | Should not happen — `display_name` is board-only; CRM names in Members CRM tab |
| Board login with alternate email fails | Run `sync_board_member_names.js --apply`; check `board_member_emails` |
| Same-day waiting list order wrong | Run `python scripts/fix_waiting_list_order.py --apply` with registration order file in `data/` |
| Portal slow on mobile / every tap waits | Fixed June 17 — hard-refresh; if old build, confirm `21e1514` deployed; tabs should be instant with brief bar only on first Notifications open |
| Activity log / admin times look wrong (ahead of LA) | Hard-refresh admin; confirm `public/js/datetime-la.js` loads; times should show Pacific e.g. `Jul 3, 2026, 8:49 PM` |
| Invoice sent date off by one day | Fixed July 2026 — `toDateOnlyString()` uses LA timezone in `datetime-la.js` / `portal.js` |
| Portal login shows wrong member name | Phone collision — set `DEMO_QA_PHONE=3105550199`; run `fix_qa_phone_collision.js` on DB if QA still shares a real phone |
| Profile address shows a date | Legacy CRM data in `address` — `normalizePortalAddress()` in `portal.js`; field editable to real address |
| Netlify build failed secrets scan | Hardcoded emails in scripts — use env vars / member_number roster (`sync_board_member_names.js` fixed June 17) |

---

## 14. Related documents

- **`docs/notifications-setup.md`** — SendGrid + Twilio account setup, Netlify env, test commands.
- **`docs/membership-onboarding-workflow.md`** — Full onboarding pipeline (board + dev spec).
- **`docs/system-validation-playbook.md`** — QA slot 201, demo reset, repeatable onboarding test.
- **`docs/automation-registry.md`** — Master catalog of all automations (IDs, triggers, tables, files, status).
- **`docs/automation-showcase.html`** — Meridian portfolio case study (`/docs/automation-showcase.html`); mirror to `public/docs/`.
- **`docs/board-meeting-handout.html`** — Printable board summary (Ctrl+P).
- **`docs/scheduled-paypal-sync.md`** — PayPal cron schedule (why “Every hour” in Netlify UI).
- **`HIBRET_EDIR_PROJECT_HANDOFF (1).md`** — Original handoff (business, SMS bot spec, roadmap).
- **`README.md`** — Deploy overview.
- **`.env.example`** — All env vars.

---

*Maintained for Cursor agents. Update this file when completing major features or changing architecture.*

---

## 15. Next agent priorities (July 3, 2026)

1. **Twilio SMS** — Buy US SMS number; add `TWILIO_*` to Netlify; set `DEMO_QA_PHONE=3105550199`; `npm run test:notify -- --send`.
2. **Production smoke-test** — Portal: shared-phone picker; login-help flow (bad phone → email required → admin reply → check inbox); Admin **Messages** inbox + follow-up reply; verify **LA timestamps** on Activity log; instant tabs + EN/አማ; **Access Management** on phone + PC; confirm `ADMIN_AUTH_ENABLED` + `BOARD_SUPER_ADMIN_EMAILS` on Netlify.
3. **EVT-06** — Admin create event + bulk PayPal invoices to all active members.
4. **EVT-08** — Payment reminders.
5. **Optional portal** — Extend Amharic to dynamic invoice card strings; one-off script to clear date-like `address` values in CRM for legacy members.

**Done this cycle:** Messages email inbox; HTML board reply emails; append-only follow-up replies; Pacific timezone sitewide; shared-phone account picker; login-help required email + board reply by email; CRM cell import (25 mobiles on Render); PayPal sync date fix (`b48d782`); board Access Management (`ec09b90`); portal mobile perf (`21e1514`).

**Do not regress:** Portal tabs must stay instant (no full `refreshPortalData()` on every tap); shared-phone login must always show account picker when multiple CRM rows match (never silent auto-pick); PINs are per `member_id` not per phone; inactive members cannot portal-login; **portal-login help must require email and email replies** (not portal-only); **board replies are append-only** (no edit/delete); **all displayed times must stay Pacific (LA)**; `DEMO_QA_PHONE` must not match a real member; Board `display_name` must never UPDATE `members` (except read-only backfill from CRM when empty); sync script must not overwrite non-empty `display_name` without `--force-names`; Security views super-admin only; Restricted scope limits to Members CRM; deactivated board members stay in Access Management list; Meridian showcase; waiting list order; current announcement uses `event_number`.
