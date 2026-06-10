# Hibret Edir — Agent Context & Handoff

**Last updated:** June 2026 (post `679151f`)  
**Purpose:** Onboard a new Cursor agent quickly. Read this file first, then `HIBRET_EDIR_PROJECT_HANDOFF (1).md` for deeper business rules and by-laws.

---

## 1. What this project is

**Hibret Edir** is an Ethiopian mutual-assistance (Edir) organization in Greater Los Angeles. When a member or covered family member dies:

- Every **active member pays $110** per event (via PayPal invoice, Zelle, or direct deposit).
- The grieving family receives a **$15,000 payout** for funeral costs.
- **~195 active members** (cap 200). Founded 2011.

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
│   ├── index.html                 # Public website (multi-section SPA)
│   ├── portal/index.html          # Member portal
│   ├── admin/index.html           # Board Admin Page (CRM)
│   ├── application/index.html     # Full membership application (step 2)
│   ├── data/memorial.json          # In Remembrance roll (name + year) — editable
│   ├── waiting-list-public.json   # Static fallback for public waiting list
│   ├── member-stats.json          # Hero stats (active count)
│   ├── css/
│   │   ├── public-pages.css       # Public site styles
│   │   ├── app-theme.css          # Portal theme
│   │   ├── admin-tracker.css      # Admin dashboard
│   │   ├── compat.css             # Shared fixes (invoice buttons, etc.)
│   │   └── hibret.css             # Legacy/shared tokens
│   └── admin/invoices-snapshot.json  # Offline invoice fallback for admin
├── netlify/functions/
│   ├── auth.js                    # PIN, board login, PIN reset requests
│   ├── admin-auth.js              # Shared JWT verify helpers
│   ├── portal.js                  # Members, invoices, profile, beneficiary, activity
│   ├── apply.js                   # Waiting list, applications, contact messages, change requests
│   ├── receipts.js                # Member receipt upload + admin review
│   ├── payouts.js                 # $15K payout document workflow
│   ├── notify.js                  # SendGrid + Twilio (profile, beneficiary, applications)
│   ├── sync.js                    # Cross-entity sync + audit triggers
│   ├── audit.js                   # Activity log read/write
│   ├── db.js                      # pg Pool singleton
│   ├── geo.js                     # Address / radius helpers
│   ├── paypal-sync.js             # PayPal pull → PostgreSQL (GET preview, POST sync)
│   ├── paypal-env.js              # Local .env loader for PayPal creds
│   └── member-snapshot.js         # Static member export + dev PIN file
├── db/schema.sql                  # PostgreSQL schema + migration comments
├── scripts/
│   ├── start-dev.js               # Netlify dev (Google Drive–friendly)
│   ├── extract_memorial.js        # Build memorial list from invoice snapshot
│   ├── seed_from_exports.py       # Seed members/invoices from data/ exports
│   ├── import_waiting_list.py     # Import waiting list xlsx → DB
│   ├── build_invoice_snapshot.py  # Build admin/invoices-snapshot.json
│   └── build_members_snapshot.py
├── data/                          # Gitignored exports (xlsx, csv) — not in repo
├── .env.example
├── netlify.toml
├── package.json
├── README.md                      # Outdated in places — prefer this file
└── HIBRET_EDIR_PROJECT_HANDOFF (1).md  # Original Claude handoff doc
```

**Note:** `upload.js`, `members.js`, `events.js` from the original handoff **do not exist**. Receipt uploads use **`receipts.js`** (base64 in DB, not S3). Admin “create event → auto invoices” is still not built.

---

## 3. Local development

### ⚠️ Netlify free tier — local-first workflow

**The maintainer uses Netlify Free (~300 build credits/month). Treat credits as scarce.**

| Do locally | Avoid until feature is complete |
|------------|----------------------------------|
| All coding, UI, and API changes via `npm run dev` | Pushing half-finished work to trigger deploys |
| Test functions at `http://localhost:8888/.netlify/functions/...` | Multiple push/redeploy cycles to “try something” |
| Use Render Postgres from local `.env` (same DB as prod if desired) | Preview deploys for every branch |
| Admin offline fallback: `npm run build:invoice-snapshot` | Netlify build plugins / extra build steps |
| Static-only UI checks: `npm run dev:static` (no credit cost) | Committing unless user explicitly asks |

**Deploy rule:** Only push to GitHub / Netlify when the user says the batch of work is **complete and tested locally**. Do not proactively commit or push. Batch related changes into one deploy.

```bash
npm install          # May fail on Google Drive — start-dev.js works around this
cp .env.example .env # Fill DATABASE_URL, JWT_SECRET, etc.
npm run db:migrate   # Apply schema.sql (new tables: contact_messages, pin_reset_requests, etc.)
npm run dev          # → http://localhost:8888 (full stack, no Netlify credits)
```

- **`scripts/start-dev.js`** installs deps under `%TEMP%/hibret-dev` when `node_modules` on Google Drive is broken.
- Board admin locally: `ADMIN_AUTH_ENABLED` is **off by default** — admin opens without login unless `ADMIN_AUTH_ENABLED=true`.
- Member auth locally: `DATABASE_URL` + seeded members; dev PINs in `netlify/functions/.dev-pins.json` (local only, gitignored).

---

## 4. Environment variables

See `.env.example`. Critical ones:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Render Postgres — required for real data |
| `JWT_SECRET` | Member + board tokens |
| `ADMIN_AUTH_ENABLED` | `true` on Netlify production (recommended) |
| `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` | PayPal sync |
| `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` | Email |
| `TWILIO_*` | SMS |
| `BOARD_NOTIFY_EMAIL` / `BOARD_NOTIFY_PHONE` | Board alerts |
| `ADMIN_SITE_URL` | Links in board notification emails |

Notifications **skip gracefully** when SendGrid/Twilio are unset (console warn only).

---

## 5. Database

**Schema file:** `db/schema.sql` — run `npm run db:migrate` after pulling schema changes.

**Tables in use:**

| Table | Purpose |
|-------|---------|
| `members` | CRM — includes `pin_hash` for portal |
| `beneficiaries` | Death beneficiary per member (primary) |
| `events` | Funeral events (deceased name, event #, date) |
| `invoices` | PayPal-linked invoices |
| `receipts` | Zelle/BofA receipt uploads (base64 `file_url`, admin approve → mark invoice Paid) |
| `waiting_list` | Public waiting list queue |
| `membership_applications` | Step-2 application + ID docs (JSONB) |
| `member_change_requests` | Beneficiary changes pending board approval |
| `contact_messages` | Public Contact Us form inbox |
| `pin_reset_requests` | Member forgot-PIN requests |
| `event_payouts` | $15K payout document + approval workflow |
| `audit_log` | Activity log |
| `board_members` | Board login accounts |
| `notifications` | Email/SMS send log |

**Migrations:** Bottom of `schema.sql` has commented snippets for existing DBs. If a function errors on missing table, run `npm run db:migrate`.

**Seeding:**

```bash
npm run seed
npm run import:waiting-list:seed
npm run build:invoice-snapshot
node scripts/extract_memorial.js   # Optional: refresh memorial names from snapshot
```

---

## 6. Netlify Functions — API reference

Base URL: `/.netlify/functions/<name>`

### `auth.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/config` | — | `{ adminAuthRequired, memberAuthRequired }` |
| POST | `/check-phone` | — | Member lookup; `{ exists, hasPin, member }` |
| POST | `/create-pin` | — | Set/change bcrypt PIN (phone required) |
| POST | `/verify-pin` | — | Returns member JWT |
| POST | `/request-pin-reset` | — | Member locked out — creates `pin_reset_requests` row |
| GET | `/pin-reset-requests` | Admin | List PIN reset requests |
| POST | `/pin-reset-requests/:id/approve` | Admin | Clear PIN + mark approved |
| POST | `/pin-reset-requests/:id/reject` | Admin | Decline request |
| POST | `/admin/reset-pin` | Admin | `{ memberId }` — clear PIN from member modal |
| GET | `/me` | Member JWT | Current member |
| POST | `/admin/login` | — | Board JWT |
| GET | `/admin/me` | Board JWT | Current admin |

### `portal.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/members` | Admin | Member list |
| GET | `/member` | Admin | Single member lookup |
| POST | `/member` | Admin | Update member fields |
| GET | `/invoices` | Admin or Member | Invoice list |
| POST | `/invoice` | Admin | Mark invoice paid |
| GET | `/profile` | Member | Profile + beneficiary + pending change |
| PATCH | `/profile` | Member | Update profile (notifies member + board) |
| PUT | `/beneficiary` | Member | **Submits change request** for board approval (not direct save) |
| GET | `/events` | Member | Deceased names for receipt dropdown |
| GET | `/activity` | Admin or Member | Audit log entries |
| GET | `/member/journey` | Admin | Timeline for one member |

### `paypal-sync.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | — | Preview normalized invoices from PayPal (debug) |
| POST | `/` | Admin | Pull all PayPal invoices → upsert `invoices` table |

Run locally: `npm run sync:paypal`. Admin UI: **Sync PayPal** on Invoices tab; auto re-sync if last sync &gt; 30 minutes ago.

### `receipts.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/` | Member | Upload receipt (base64 file, deceased name, optional `invoice_num`) |
| GET | `/` | Admin | List receipts (optional `?status=Pending`) |
| POST | `/:id/approve` | Admin | Approve → marks linked invoice Paid |
| POST | `/:id/reject` | Admin | Reject upload |

Max file 5 MB; JPG/PNG/PDF/WebP. Files stored as `data:` URLs in `receipts.file_url`.

### `apply.js`

**Public:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/waiting-list` | Join waiting list (address validated) |
| GET | `/waiting-list/status` | Public queue |
| GET | `/validate-address` | 50-mile radius check |
| POST | `/verify` | Waiting list invite token for `/application` |
| POST | `/membership` | Submit application + ID docs |
| POST | `/contact` | Contact Us form → `contact_messages` + email board |

**Admin** (board JWT):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/applications` | Membership applications + merged beneficiary requests |
| GET/PATCH/POST | `/applications/:id` | Review, approve, reject applications |
| GET | `/change-requests` | Beneficiary change requests |
| GET/POST | `/change-requests/:id` | Detail; `approve` / `reject` |
| GET | `/contact-messages` | Contact form inbox |

Beneficiary **approve** applies payload to `beneficiaries` and sends member email + SMS.

### `payouts.js` (admin only)

Same as before: list, open case, upload docs, checklist, 2 board approvals, mark $15,000 paid.

### `notify.js`

Called on profile update, beneficiary submit/approve/reject, application events, PIN reset board alert, contact form.

**Beneficiary sensitivity:** SMS avoids full beneficiary names where possible; all member messages include “call (424) 547-5594 if this was not you.”

---

## 7. Frontend — what exists and what's wired

### Public site (`public/index.html`)

Single-page app with hash routing (`#remembrance`, `#apply`, etc.). English + Amharic (`lang-am`).

**Sections:** Announcement (memorial letter template for current event), **In Remembrance** (`#remembrance`), How It Works, About, Payment, By-Laws, Waiting List, Waiting List Status, Contact (form first).

**In Remembrance:** Loads `public/data/memorial.json` — one card, vertical list of **name + year**. Update JSON when full historical list is available; `scripts/extract_memorial.js` pulls names from invoice snapshot (handles `# 27` spacing quirk).

**Other UX:** Colored Explore cards, memorial announcement `data-ann-*` template, by-laws PDF modal, waiting list shows next names in queue.

### Member portal (`public/portal/index.html`)

**Wired:**

- Phone + PIN login; **Forgot PIN? Request a reset** → `auth/request-pin-reset`
- Invoices from DB; unpaid cards: **gold** “If paid, Upload Receipt” + **green** “Pay via PayPal”
- Receipt upload → `receipts` API (person dropdown from `portal/events`, links invoice if prefilled)
- Profile edit; beneficiary edit → **pending board approval**
- Change PIN in Profile (logged in)
- Activity in notifications tab

**Partial mock:** Some static notification cards remain for demo.

### Board Admin Page (`public/admin/index.html`)

**Sidebar views:** Invoices · Members · **Approval** (applications + beneficiary changes) · **Receipts** · **Messages** (Contact + PIN Reset tabs) · Event Summary · Payout Fund · Activity Log

**Features:**

- Invoice tracker + late matching by PayPal name
- Member modal: edit CRM fields, journey timeline, **Reset PIN** button
- Approval: membership apps (4-checklist) + beneficiary change requests (`cr-{id}` IDs)
- Receipts: pending/approved/rejected; preview image/PDF; approve marks invoice Paid
- Messages: contact inbox + PIN reset queue (approve clears PIN)
- Payout Fund workflow (unchanged)

**Data:** Live API + `invoices-snapshot.json` fallback for invoices offline.

### Membership application (`public/application/index.html`)

Waiting list verify gate → full form → `apply/membership`.

---

## 8. Completed work (summary by phase)

### Phase 2–5 — Core platform (DONE)

Auth, portal, admin CRM, applications, waiting list, notifications, audit, sync, payout fund.

### Phase 6 — Recent (June 2026, commit `679151f`)

- [x] **Receipt uploads** — `receipts.js` + portal + admin Receipts tab
- [x] **In Remembrance** public page + `memorial.json`
- [x] **PIN reset** — member request flow + admin inbox + member modal reset
- [x] **Beneficiary approval** — member changes require board approve; email/SMS on submit, approve, reject
- [x] **Contact messages** — public form → admin Messages tab
- [x] **Memorial announcement** letter template on public site
- [x] Portal invoice UX (stacked pay/upload buttons, gold/green)
- [x] Admin labels: Board Admin Page, Approval tab

### Still partial / ops

- [x] **PayPal → DB sync** — `paypal-sync.js` POST syncs all invoices; Admin **Sync PayPal** button; background sync every 30 min; `npm run sync:paypal`
- [ ] Admin create event → bulk invoices (PayPal API create)
- [ ] All members have portal PINs (ops)
- [ ] Full memorial history in `memorial.json` (user to supply list)
- [ ] S3 for receipts (optional; currently DB base64)
- [ ] Production: add `PAYPAL_*` env vars on Netlify + run `db:migrate`

---

## 9. Not done yet / known gaps

| Item | Notes |
|------|-------|
| `events.js` | No admin “create event → auto 195 invoices” via PayPal API |
| Automated payment reminders | Day 3/7/14 — not started |
| Twilio SMS bot | Not started |
| Registration fee PayPal ($200) after application approval | Partial |
| Welcome email + digital membership card | Not started |
| 4-month waiting period tracking | Not started |
| Reporting (event collection, delinquency, semi-annual) | Not started |
| Receipt storage at scale | Base64 in Postgres OK for now |
| `README.md` | Partially outdated |
| Production migrations | Run `npm run db:migrate` on Render after deploy |

---

## 10. Business rules (implement carefully)

From by-laws / handoff:

- Ethiopian origin, **50 miles** of Downtown LA
- **$200** one-time membership fee after waiting list invite
- **$110** per event, due within 3 days
- **4-month waiting period** for new members before benefits
- **$15,000** payout; **2 board approvals** required
- **200** member cap
- Coverage: member, spouse, children up to 26
- **Beneficiary changes** require board approval (sensitive — always notify member)

---

## 11. Agent conventions

1. **Minimal diffs** — vanilla JS + CSS; match existing patterns.
2. **Bilingual** — `.en` / `.am` pairs on public and portal strings.
3. **Mobile first** — most members use phones.
4. **Do not commit or push** unless the user explicitly asks. Netlify free tier ~300 build credits/month.
5. **Do not commit** `.env`, secrets, or `data/` exports.
6. **Database:** timeouts via `db.js` Pool; graceful empty responses if tables missing.
7. **Production:** `ADMIN_AUTH_ENABLED=true` on Netlify.
8. **Sensitive data:** ID/receipt/payout docs as base64 — never log full payloads.

---

## 12. Recent session changelog (for continuity)

### June 2026 — `679151f`

- Memorial roll on public site; 6 names from invoice data (#25–#30).
- Receipt API + admin Receipts + portal upload linked to invoices.
- PIN reset request (portal) + admin Messages → PIN Reset + Reset PIN on member.
- Beneficiary email/SMS: on request submitted, board approved, board rejected.
- Portal: gold upload / green PayPal invoice buttons.
- Admin: “Board Admin Page”, Approval tab, Receipts tab.

### Earlier sessions

- Beneficiary approval workflow (`member_change_requests`).
- Contact messages tab.
- Memorial announcement template (Brook Zewdie).
- Payout fund, waiting list embed, admin late invoice matching.

---

## 13. Quick troubleshooting

| Problem | Likely cause |
|---------|----------------|
| Admin shows no invoices | No `DATABASE_URL`; run `build:invoice-snapshot` |
| Receipts / PIN reset / Messages empty | Run `npm run db:migrate` |
| Memorial shows 4 not 6 names | Old `memorial.json`; run `extract_memorial.js` or edit JSON |
| PIN reset 503 locally | No `DATABASE_URL` |
| Beneficiary stuck “pending” | Board must approve in Admin → Approval |
| Notifications not sending | SendGrid/Twilio unset (expected locally) |
| Netlify dev slow | Google Drive sync; use `start-dev.js` |

---

## 14. Related documents

- **`HIBRET_EDIR_PROJECT_HANDOFF (1).md`** — Original handoff (business, SMS bot spec, roadmap).
- **`README.md`** — Deploy instructions (partially outdated).
- **`.env.example`** — All env vars.

---

*Maintained for Cursor agents. Update this file when completing major features or changing architecture.*
