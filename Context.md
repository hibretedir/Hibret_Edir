# Hibret Edir — Agent Context & Handoff

**Last updated:** June 14, 2026 (QA reserved slot enforced; waiting list invite policy)  
**Purpose:** Onboard a new Cursor agent quickly. Read this file first, then `HIBRET_EDIR_PROJECT_HANDOFF (1).md` for deeper business rules and by-laws.

**Current focus (next agent):** **Netlify deploy** of QA/system-health work when user approves. Finish **Twilio SMS** — account, buy SMS number, add `TWILIO_*` to `.env` + Netlify, `npm run test:notify -- --send`. SendGrid is **done**. See **`docs/notifications-setup.md`**. For onboarding QA before deploy: **`docs/system-validation-playbook.md`** + Admin **System Health → QA Testing**.

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
│   └── admin/invoices-snapshot.json  # Offline invoice fallback for admin
├── netlify/functions/
│   ├── auth.js                    # PIN, board login, PIN reset requests
│   ├── admin-auth.js              # Shared JWT verify helpers
│   ├── portal.js                  # Members, invoices, profile, stats, activity
│   ├── apply.js                   # Waiting list, applications, site-stats, announcement, QA dashboard
│   ├── demo-qa-dashboard.js       # System Health API + ONB validation steps
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
│   ├── run_schema.js              # npm run db:migrate
│   ├── seed_from_exports.py
│   ├── import_waiting_list.py     # Excel import + public JSON export
│   ├── mark_added_waiting_list_members.py
│   ├── mark_invitations_sent.py
│   ├── seed_waiting_list_public.py
│   ├── set_event_announcement.js  # Prayer/burial/payment details on events.notes (public announcement)
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
| `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` / `SENDGRID_REPLY_TO` | Email (SendGrid v3) — **live** |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | SMS (E.164 Twilio number, e.g. `+14245551234`) — **not set yet** |
| `BOARD_NOTIFY_EMAIL` / `BOARD_NOTIFY_PHONE` | Comma-separated board alert recipients |
| `TEST_NOTIFY_EMAIL` / `TEST_NOTIFY_PHONE` | Optional — destinations for `npm run test:notify -- --send` |
| `ADMIN_SITE_URL` | Links in board notification emails |
| `PUBLIC_SITE_URL` | Short invite/apply links in emails (use `http://localhost:8888` locally; production URL on Netlify) |
| `MEMBER_CAP` | Default 200; use **`201`** for QA = **200 production slots + 1 reserved validation slot** (slot 201 is QA-only — real waiting-list invites use cap 200) |
| `DEMO_QA_ENABLED` | `true` to enable System Health QA + **Reset demo cycle** |
| `DEMO_QA_EMAIL` / `DEMO_QA_PHONE` / `DEMO_QA_NAME` | Dedicated test identity (never a real member) |
| `REGISTRATION_FEE` | `200` production; `1` for live PayPal QA smoke test |

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

**Schema file:** `db/schema.sql` — run `npm run db:migrate` after pulling schema changes (idempotent).

**Tables in use:**

| Table | Purpose |
|-------|---------|
| `members` | CRM — includes `pin_hash` for portal |
| `beneficiaries` | Death beneficiary per member (primary) |
| `events` | Funeral events (deceased name, event #, amount); `notes` = JSON for public announcement (prayer/burial venues, `collect_dues`, optional `announcement_text`) |
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
node scripts/set_event_announcement.js 30           # Backfill public announcement for event #30 (or any event #)
```

**Event announcement JSON** (`events.notes` — set via `scripts/set_event_announcement.js` or `--file`):

| Field | Purpose |
|-------|---------|
| `prayer_venue`, `prayer_address`, `prayer_datetime` | Prayer service block on public site |
| `burial_venue`, `burial_address` | Burial service block |
| `collect_dues` | `false` or `waive_dues: true` → no dues paragraph |
| `announcement_text` | Free-text fallback if structured fields absent |

PayPal sync creates events with name only — **run `set_event_announcement.js` after each new funeral** so the public memorial letter shows full service details.

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
| GET | `/current-announcement` | — | Latest **Active** event; venues from `events.notes` JSON |
| GET | `/waiting-list/status` | — | Live queue; `added` only if `Added as Member` |
| POST | `/waiting-list`, `/contact` | — | Public forms |
| POST | `/verify`, `/membership` | — | Application gate (must be `Invited to Apply`) |
| GET | `/waiting-list` | Admin | Full queue + slot math |
| POST | `/waiting-list/:id/invite` | Admin | Send invitation |
| POST | `/waiting-list/:id/reject` | Admin | Remove → status `Rejected` |
| GET/PATCH | `/applications/:id` | Admin | List / save review checklist |
| POST | `/applications/:id/approve-for-payment` | Admin | Vet + send PayPal registration invoice → `Awaiting Payment` |
| POST | `/applications/:id/complete` | Admin | Mark registration paid (Zelle) → create member |
| POST | `/applications/:id/reject` | Admin | Reject application |
| GET | `/qa/dashboard` | Admin | System Health + ONB step status |
| POST | `/demo-qa/reset` | Admin | Reset QA demo cycle (DEMO_QA_EMAIL only) |

**Membership onboarding (live):** invite → apply → board review (3 checks) → **Approve & Send Invoice** → PayPal registration fee → **member created automatically on PayPal paid** (sync or completion job). **Mark Registration Paid** / **Approve & Add to CRM** = fallback for Zelle/BofA. See **`docs/membership-onboarding-workflow.md`** and **`docs/system-validation-playbook.md`**.

**QA test identity (local, June 2026):** `hibretedirtest@gmail.com` · `3103867475` · `Hibret Edir QA Test` · `REGISTRATION_FEE=1` · `MEMBER_CAP=201`. Full cycle validated locally (waiting list → invite → apply → approve → PayPal $1 → sync → active member). Reset: `npm run demo:reset:apply` or Admin **Reset demo cycle**.

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
- **Current announcement** → `apply/current-announcement` — full **memorial letter** (prayer/burial/payment) + summary box; data from `events.notes` JSON on latest Active event
- **Waiting list status** → `apply/waiting-list/status` (same PostgreSQL queue as Admin; hides Added/Rejected/Canceled; renumbers place in line)
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
| System Health | **Dashboard** (integrations, test member, health checks) · **QA Testing** (ONB step playbook) |
| Security | Activity Log |

**Live stats bar:** Unpaid, Paid (PayPal), Zelle & BofA, Late — colors: green / green / red.

**Refresh behavior:** Members and Invoices tabs refetch on switch; Event Summary loads full invoices + stats.

**Event Summary:** `amount_owed` from API (sum of unpaid `amount_due`), not `unpaid × 110`.

**PayPal:** **Sync PayPal** on Invoices tab (batched POST). Stats cache invalidated after sync and member changes.

**Approval view (three top tabs):**

| Tab | Contents |
|-----|----------|
| **Waiting List** | All · Invited · In Progress — invite from **All** with **Send Invitation →** (no separate “Ready to Invite” tab) |
| **Applications** | Membership only — Pending (incl. Awaiting Payment) · Approved · Rejected |
| **Board Requests** | Operational approvals — **Mark Paid**, **Beneficiary** changes; own Pending · Approved · Rejected · All |

| Action | Where |
|--------|-------|
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

### Still partial / ops

- [ ] **Twilio SMS** — **IN PROGRESS** — SendGrid done; follow `docs/notifications-setup.md` § Twilio
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
| Admin UI for event announcement | Use `set_event_announcement.js` until form exists |
| `events.js` | No admin “create event → auto ~197 invoices” via PayPal API |
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
| `npm run db:migrate` timeout to Render | Retry; `run_schema.js` has 60s connect / 120s query / 3 retries |
| Showcase changes not visible on localhost | Netlify serves `public/` — copy `docs/automation-showcase.html` → `public/docs/` |
| Meridian voice sounds robotic on deploy | Normal — TTS runs in visitor's browser, not on Netlify; Edge + UK Natural voices sound best |

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

## 15. Next agent priorities (June 14, 2026)

1. **Deploy to Netlify** (when user ready) — set `PUBLIC_SITE_URL`, `MEMBER_CAP=201`, `DEMO_QA_*`, `REGISTRATION_FEE=1` for QA or `200` for production; redeploy.
2. **Twilio SMS** — Create Twilio account, buy US SMS number, add `TWILIO_*` to `.env` + Netlify, redeploy. Run `npm run test:notify -- --send`.
3. **Production smoke-test** — Admin → Waiting List → **Send Invitation** → confirm email (and SMS once Twilio live).
4. **Event announcement UI** — `scripts/set_event_announcement.js` exists; optional admin UI.
5. **EVT-06** — Admin create event + bulk PayPal invoices.
6. **EVT-08** — Payment reminders.

**SendGrid (done):** `notifications@hibretedir.com` / Reply `hibretedirtext@gmail.com` / DNS on Wix.

**Do not regress Meridian showcase:** speech-gated advance, phase-2 scroll-before-speech, contact links after closing pitch (`ETHIO_CONTACT`).
