# Hibret Edir — Agent Context & Handoff

**Last updated:** June 11, 2026 (membership onboarding workflow + waiting list public status fix)  
**Purpose:** Onboard a new Cursor agent quickly. Read this file first, then `HIBRET_EDIR_PROJECT_HANDOFF (1).md` for deeper business rules and by-laws.

---

## 1. What this project is

**Hibret Edir** is an Ethiopian mutual-assistance (Edir) organization in Greater Los Angeles. When a member or covered family member dies:

- Every **active member pays $110** per event (via PayPal invoice, Zelle, or direct deposit).
- The grieving family receives a **$15,000 payout** for funeral costs.
- **~197 active members** (cap 200; count is live from DB). Founded 2011.

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
| Email / SMS | SendGrid / Twilio (graceful skip if unset) |

**Contacts:** (424) 547-5594 · hibretedirtext@gmail.com · hibretedirautomation@gmail.com  
**Live URLs:** hibretedir.com · `/portal` · `/admin` · `/application`

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
│   ├── docs/                      # Board handout + automation showcase (also in docs/)
│   ├── member-stats.json          # Static fallback for hero active count (offline only)
│   ├── css/
│   │   ├── public-pages.css
│   │   ├── app-theme.css
│   │   ├── admin-tracker.css
│   │   ├── compat.css
│   │   └── hibret.css
│   └── admin/invoices-snapshot.json  # Offline invoice fallback for admin
├── netlify/functions/
│   ├── auth.js                    # PIN, board login, PIN reset requests
│   ├── admin-auth.js              # Shared JWT verify helpers
│   ├── portal.js                  # Members, invoices, profile, stats, activity
│   ├── apply.js                   # Waiting list, applications, site-stats, announcement
│   ├── membership-completion.js   # Create active member after registration payment
│   ├── paypal-registration-invoice.js  # $200 PayPal invoice on board approve
│   ├── receipts.js                # Member receipt upload + admin review
│   ├── payouts.js                 # $15K payout document workflow
│   ├── notify.js                  # SendGrid + Twilio
│   ├── sync.js                    # Cross-entity sync + audit triggers (NOT PayPal)
│   ├── audit.js                   # Activity log read/write
│   ├── db.js                      # pg Pool singleton + timeouts
│   ├── geo.js                     # Address / radius helpers
│   ├── paypal-sync.js             # PayPal pull → PostgreSQL (GET list, POST batch sync)
│   ├── paypal-sync-scheduled.js   # Netlify cron trigger (hourly; sync 9 AM & 6 PM Pacific)
│   ├── paypal-sync-background.js  # Full batched PayPal pull (long-running)
│   ├── paypal-env.js              # Local .env loader + PayPal API base URL
│   ├── payment-methods.js         # PayPal vs Zelle & BofA classification for stats
│   ├── invoice-stats-cache.js     # 60s TTL cache for admin invoice stats
│   ├── board-notes.js             # Board note merge helpers
│   └── member-snapshot.js         # Static member export + dev PIN file
├── db/schema.sql                  # PostgreSQL schema + idempotent migrations
├── docs/
│   ├── membership-onboarding-workflow.md
│   ├── board-meeting-handout.html
│   ├── automation-showcase.html
│   └── scheduled-paypal-sync.md
├── scripts/
│   ├── start-dev.js               # Dev entry (delegates to dev-local.js)
│   ├── dev-local.js               # Local server: public/ + functions (no Netlify CLI cache)
│   ├── sync_paypal.js             # Full PayPal sync from terminal (no 60s limit)
│   ├── run_schema.js              # npm run db:migrate
│   ├── seed_from_exports.py
│   ├── import_waiting_list.py     # Excel import + public JSON export
│   ├── mark_added_waiting_list_members.py
│   ├── mark_invitations_sent.py
│   ├── seed_waiting_list_public.py
│   ├── build_invoice_snapshot.py
│   └── build_members_snapshot.py
│   └── (many compare/audit scripts for ops — optional)
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
| Use Render Postgres from local `.env` | Preview deploys for every small change |
| `npm run db:migrate` after schema changes | Committing unless user explicitly asks |

**Deploy rule:** Only push when the user says work is **complete and tested locally**.

```bash
npm install          # May fail on Google Drive — dev-local.js works around this
cp .env.example .env # Fill DATABASE_URL, JWT_SECRET, PAYPAL_*, CRON_SECRET, etc.
npm run db:migrate   # Apply schema.sql (safe to re-run)
npm run dev          # → http://localhost:8888
npm run sync:paypal  # Full PayPal → DB sync from terminal
```

- **`scripts/dev-local.js`** serves `public/` and loads `netlify/functions/*.js` directly.
- Board admin locally: `ADMIN_AUTH_ENABLED` **off by default**.
- **Restart `npm run dev`** after adding new function routes or API endpoints.

---

## 4. Environment variables

See `.env.example`. Critical ones:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Render Postgres — required for real data |
| `JWT_SECRET` | Member + board tokens |
| `ADMIN_AUTH_ENABLED` | `true` on Netlify production (recommended) |
| `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` | PayPal sync |
| `PAYPAL_ENV` | `sandbox` or production (empty/non-sandbox = production API). Not a secret — omitted from Netlify secrets scan via `netlify.toml` |
| `CRON_SECRET` | **Required on Netlify** for scheduled + background PayPal sync |
| `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` | Email |
| `TWILIO_*` | SMS |
| `BOARD_NOTIFY_EMAIL` / `BOARD_NOTIFY_PHONE` | Board alerts |
| `ADMIN_SITE_URL` | Links in board notification emails |

Notifications **skip gracefully** when SendGrid/Twilio are unset.

---

## 5. Database

**Schema file:** `db/schema.sql` — run `npm run db:migrate` after pulling schema changes (idempotent).

**Tables in use:**

| Table | Purpose |
|-------|---------|
| `members` | CRM — includes `pin_hash` for portal |
| `beneficiaries` | Death beneficiary per member (primary) |
| `events` | Funeral events (deceased name, event #, amount, notes JSON for announcement venues) |
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
| `board_members` | Board login accounts |
| `notifications` | Email/SMS send log |

**Recent schema additions:** performance indexes; `invoices.paid_note`, `invoice_mark_paid_requests`; `waiting_list.invited_at`; `invoices.membership_application_id`; `membership_applications.registration_invoice_id`.

**Waiting list statuses (admin + DB):**

| Status | Meaning |
|--------|---------|
| `Pending` / `Registered` | In queue |
| `Invited to Apply` | Board sent invite |
| `Application Submitted` | Form received |
| `Added as Member` | Paid and in CRM |
| `Rejected` | Removed from queue (Remove button) |

**Public waiting list labels:** Only `Added as Member` shows **Added**. `Invited to Apply` and `Application Submitted` show **Invitation Sent** (not position-based — do not use “places 1–11” heuristic).

**Seeding / waiting list ops:**

```bash
npm run db:migrate
npm run import:waiting-list:seed          # if DB empty
python scripts/import_waiting_list.py --file "data/waiting list with phone and email.xlsx" --seed
python scripts/mark_added_waiting_list_members.py   # marks known members + refreshes public JSON
python scripts/mark_invitations_sent.py             # one-off status updates
```

---

## 6. Netlify Functions — API reference

Base URL: `/.netlify/functions/<name>`

### `auth.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/config` | — | `{ adminAuthRequired, memberAuthRequired }` |
| POST | `/check-phone` | — | Member lookup |
| POST | `/create-pin` | — | Set bcrypt PIN |
| POST | `/verify-pin` | — | Returns member JWT |
| POST | `/request-pin-reset` | — | Creates `pin_reset_requests` row |
| GET/POST | `/pin-reset-requests/*` | Admin | List / approve / reject |
| POST | `/admin/reset-pin` | Admin | Clear PIN from member modal |
| GET | `/me` | Member JWT | Current member |
| POST | `/admin/login` | — | Board JWT |

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
| GET | `/current-announcement` | — | Latest event from DB |
| GET | `/waiting-list/status` | — | Live queue; `added` only if `Added as Member` |
| POST | `/waiting-list`, `/contact` | — | Public forms |
| POST | `/verify`, `/membership` | — | Application gate (must be `Invited to Apply`) |
| GET | `/waiting-list` | Admin | Full queue + slot math |
| POST | `/waiting-list/:id/invite` | Admin | Send invitation |
| POST | `/waiting-list/:id/reject` | Admin | Remove → status `Rejected` |
| GET/PATCH | `/applications/:id` | Admin | List / save review checklist |
| POST | `/applications/:id/approve-for-payment` | Admin | Vet + send $200 PayPal invoice → `Awaiting Payment` |
| POST | `/applications/:id/complete` | Admin | Mark registration paid (Zelle) → create member |
| POST | `/applications/:id/reject` | Admin | Reject application |

**Membership onboarding (live):** invite → apply → board review (3 checks) → **Approve & Send Invoice** → PayPal $200 → member created on payment (PayPal sync or **Mark Registration Paid**). See **`docs/membership-onboarding-workflow.md`**.

**Registration payment completion:** `paypal-sync.js` calls `processPaidRegistrationInvoices()` after sync. Core logic in `membership-completion.js`.

### PayPal sync

| Function | Role |
|----------|------|
| `paypal-sync` | GET invoice ID list; POST batch sync (Admin **Sync PayPal** button) |
| `paypal-sync-scheduled` | Cron `0 * * * *` — **Netlify shows "Every hour"**; only syncs **9 AM & 6 PM Pacific** |
| `paypal-sync-background` | Full batched pull (invoked by scheduled or `CRON_SECRET`) |

See **`docs/scheduled-paypal-sync.md`** for schedule explanation.

**Manual sync:** Admin → Invoices → **Sync PayPal** · `npm run sync:paypal` · force: `/.netlify/functions/paypal-sync-scheduled?secret=CRON_SECRET`

**PayPal member matching:** Recipient name matched **before** email on sync (`paypal-sync.js`).

**Payment stats:** `PAID` → PayPal; `MARKED_AS_PAID` → Zelle & BofA (`payment-methods.js`).

### `receipts.js`, `payouts.js`, `notify.js`, `sync.js`

Unchanged in role: receipts workflow, payout fund, notifications, internal CRM sync (not PayPal).

---

## 7. Frontend — what exists and what's wired

### Public site (`public/index.html`)

Hash routing (`#announcement`, `#apply`, etc.). English + Amharic.

**Live from API:**

- Hero **active member count**, per-death amount, payout amount → `apply/site-stats`
- **Current announcement** → `apply/current-announcement` (memorial letter + summary box)
- **Waiting list status** → `apply/waiting-list/status` (DB first, `waiting-list-public.json` fallback)
- Public labels: **Added** only for members; **Invitation Sent** for invited / in-progress applicants

Placeholders show `—` until API loads. Regenerate static JSON: `python scripts/mark_added_waiting_list_members.py` (runs export at end) or import script.

**Removed:** In Remembrance section and `memorial.json`.

### Member portal (`public/portal/index.html`)

**Live:**

- Invoices from DB with recipient-name matching + event dedupe
- **Deaths Paid** = count of **paid event invoices** (unique events)
- Notifications built from live unpaid invoices + activity (no mock array)
- `refreshPortalData()` on tab switch and `visibilitychange`
- Receipt upload, profile, beneficiary change request, PIN reset

### Board Admin Page (`public/admin/index.html`)

**Sidebar:**

| Section | Views |
|---------|-------|
| Main | Members CRM, Invoices, Approval, Receipts, Messages |
| Reports | Event Summary, Payout Fund |
| Security | Activity Log |

**Live stats bar:** Unpaid, Paid (PayPal), Zelle & BofA, Late — colors: green / green / red.

**Refresh behavior:** Members and Invoices tabs refetch on switch; Event Summary loads full invoices + stats.

**Event Summary:** `amount_owed` from API (sum of unpaid `amount_due`), not `unpaid × 110`.

**PayPal:** **Sync PayPal** on Invoices tab (batched POST). Stats cache invalidated after sync and member changes.

**Approval view (Waiting List + Applications):**

| Waiting List tabs | All · Invited · In Progress (no separate “Ready to Invite” — invite from **All**) |
| Applications | Pending (incl. Awaiting Payment) · Approved · Rejected |
| Invite | **Send Invitation →** on eligible rows in **All** only |
| Review | 3 checks: name, fields, ID → **Approve & Send Invoice** |
| Payment | **Mark Registration Paid** when status is Awaiting Payment (Zelle/BofA) |

Slot math: `invite_slots_remaining = MEMBER_CAP − active − in_pipeline` (`Invited to Apply` + `Application Submitted`).

**Data:** Live API + `invoices-snapshot.json` fallback when DB unavailable.

### Membership application (`public/application/index.html`)

Waiting list verify gate (email + phone, must be **Invited to Apply**) → full form → `POST apply/membership`.

### Waiting list status page (`public/waiting-list-status/index.html`)

Full queue table with **Status** column (same API as home page).

**Docs (board + marketing):** `docs/membership-onboarding-workflow.md` · `docs/board-meeting-handout.html` · `docs/automation-showcase.html` · copies under `public/docs/` when deployed.

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

### June 2026 — Membership onboarding & waiting list (local; not necessarily deployed)

- [x] **Onboarding pipeline** — vet → PayPal $200 on approve → member on payment (`membership-completion.js`, `paypal-registration-invoice.js`)
- [x] **Admin Approval UI** — Approve & Send Invoice, Mark Registration Paid; removed Ready to Invite tab
- [x] **Waiting list import** — Excel with email/phone (~98 rows); 9 marked `Added as Member`
- [x] **Public waiting list fix** — “Added” only for actual members; **Invitation Sent** for invited/applicants (fixed position 1–11 bug)
- [x] **Docs** — `membership-onboarding-workflow.md`, board handout, automation showcase
- [x] **Ops scripts** — `mark_invitations_sent.py`, updated public JSON export

### Still partial / ops

- [ ] **SendGrid / Twilio** — not configured yet; notifications skip gracefully (manual comms for invites)
- [ ] Admin create event → bulk PayPal invoices via API
- [ ] All members have portal PINs (ops)
- [ ] Fix mislinked `member_id` on bulk-imported invoices (recipient match covers portal; admin may still show wrong owner on some rows)
- [ ] S3 for receipts (optional; currently DB base64)
- [ ] Automated payment reminders (day 3/7/14)

---

## 9. Not done yet / known gaps

| Item | Notes |
|------|-------|
| `events.js` | No admin “create event → auto ~197 invoices” via PayPal API |
| Automated payment reminders | Not started |
| Twilio SMS bot | Not started |
| Welcome email + digital membership card | Not started (approve notify exists; no card asset) |
| 4-month waiting period tracking | Not started |
| Reporting (event collection, delinquency) | Not started |
| Receipt storage at scale | Base64 in Postgres OK for now |
| End-to-end onboarding test | Mock user + $1 PayPal invoice planned; not run yet |

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

---

## 12. Recent session changelog

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
| Notifications not sending | SendGrid/Twilio unset (expected locally and until configured) |
| Invited person shows “Added” on public list | Regenerate JSON; ensure API uses status not position — see `isWaitingListPublicAdded()` in `apply.js` |
| PayPal registration invoice fails | Check `PAYPAL_CLIENT_ID`/`SECRET`; use **Mark Registration Paid** as fallback |
| PayPal sync timeout on Netlify | Use Admin batched sync or `npm run sync:paypal`; background function for cron |

---

## 14. Related documents

- **`docs/membership-onboarding-workflow.md`** — Full onboarding pipeline (board + dev spec).
- **`docs/board-meeting-handout.html`** — Printable board summary (Ctrl+P).
- **`docs/automation-showcase.html`** — Portfolio / case-study page with diagrams.
- **`docs/scheduled-paypal-sync.md`** — PayPal cron schedule (why “Every hour” in Netlify UI).
- **`HIBRET_EDIR_PROJECT_HANDOFF (1).md`** — Original handoff (business, SMS bot spec, roadmap).
- **`README.md`** — Deploy overview.
- **`.env.example`** — All env vars.

---

*Maintained for Cursor agents. Update this file when completing major features or changing architecture.*
