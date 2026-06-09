# Hibret Edir — Agent Context & Handoff

**Last updated:** June 2026  
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
│   ├── admin/index.html           # Board admin CRM
│   ├── application/index.html     # Full membership application (step 2)
│   ├── waiting-list-public.json   # Static fallback for public waiting list
│   ├── member-stats.json          # Hero stats (active count)
│   ├── css/
│   │   ├── public-pages.css       # Public site styles
│   │   ├── app-theme.css          # Portal theme
│   │   ├── admin-tracker.css      # Admin dashboard
│   │   ├── compat.css             # Shared fixes (portal greeting logo, etc.)
│   │   └── hibret.css             # Legacy/shared tokens
│   └── admin/invoices-snapshot.json  # Offline invoice fallback for admin
├── netlify/functions/
│   ├── auth.js                    # Member PIN + board login
│   ├── admin-auth.js              # Shared JWT verify helpers
│   ├── portal.js                  # Members, invoices, profile, beneficiary, activity
│   ├── apply.js                   # Waiting list, address validate, applications
│   ├── payouts.js                 # $15K payout document workflow
│   ├── notify.js                  # SendGrid + Twilio
│   ├── sync.js                    # Cross-entity sync + audit triggers
│   ├── audit.js                   # Activity log read/write
│   ├── db.js                      # pg Pool singleton
│   ├── geo.js                     # Address / radius helpers
│   ├── paypal-sync.js             # PayPal invoice fetch (basic, not wired to DB cron)
│   └── member-snapshot.js         # Static member export helper
├── db/schema.sql                  # PostgreSQL schema + migration comments
├── scripts/
│   ├── start-dev.js               # Netlify dev (Google Drive–friendly)
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

**Note:** `upload.js`, `members.js`, `events.js` from the original handoff **do not exist**. Receipt upload and event creation are **not backend-complete**.

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

**What costs credits:** Each production (and often preview) **build** on Netlify consumes credits — not local `netlify dev`. Prefer local testing first.

```bash
npm install          # May fail on Google Drive — start-dev.js works around this
cp .env.example .env # Fill DATABASE_URL, JWT_SECRET, etc.
npm run dev          # → http://localhost:8888 (full stack, no Netlify credits)
```

- **`scripts/start-dev.js`** installs deps under `%TEMP%/hibret-dev` when `node_modules` on Google Drive is broken.
- Netlify Dev startup can be **slow** on Google Drive synced folders.
- Static-only fallback: `npm run dev:static` (HTML/CSS only — APIs won’t run).

**Board admin locally:** `ADMIN_AUTH_ENABLED` is **off by default** — admin opens without login. Set `ADMIN_AUTH_ENABLED=true` in `.env` to test board login locally.

**Member auth locally:** Works with `DATABASE_URL` + seeded members. Dev PINs may exist in `netlify/functions/.dev-pins.json` (local only).

---

## 4. Environment variables

See `.env.example`. Critical ones:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Render Postgres — required for real data |
| `JWT_SECRET` | Member + board tokens |
| `ADMIN_AUTH_ENABLED` | `true` on Netlify production only (recommended) |
| `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` | PayPal sync |
| `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` | Email |
| `TWILIO_*` | SMS |
| `BOARD_NOTIFY_EMAIL` / `BOARD_NOTIFY_PHONE` | Board alerts |
| `ADMIN_SITE_URL` | Links in board notification emails |

Notifications **skip gracefully** when SendGrid/Twilio are unset (console warn only).

---

## 5. Database

**Schema file:** `db/schema.sql`

**Tables in use:**

| Table | Purpose |
|-------|---------|
| `members` | CRM — 219 members when seeded |
| `beneficiaries` | Death beneficiary per member |
| `events` | Funeral events (schema exists; not fully wired in admin) |
| `invoices` | PayPal-linked invoices |
| `receipts` | Schema for receipt uploads (backend handler missing) |
| `waiting_list` | Public waiting list queue |
| `membership_applications` | Step-2 application after waiting list invite |
| `event_payouts` | **NEW** — $15K payout document + approval workflow |
| `audit_log` | Activity log |
| `board_members` | Board login accounts |
| `notifications` | Notification log |

**Migrations:** Bottom of `schema.sql` has commented `ALTER TABLE` / `CREATE TABLE` snippets for existing DBs. If a function errors on missing table/column, run the matching migration block.

**Seeding:**

```bash
npm run seed              # Python: members + invoices from data/ exports
npm run import:waiting-list:seed
npm run build:invoice-snapshot   # Offline admin fallback
```

---

## 6. Netlify Functions — API reference

Base URL: `/.netlify/functions/<name>`

### `auth.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/config` | — | `{ adminAuthRequired, memberAuthRequired }` |
| POST | `/check-phone` | — | Member lookup by phone/email |
| POST | `/create-pin` | — | Set bcrypt PIN |
| POST | `/verify-pin` | — | Returns JWT |
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
| GET | `/profile` | Member | Profile + beneficiary |
| PATCH | `/profile` | Member | Update profile (syncs to waiting list if linked) |
| PUT | `/beneficiary` | Member | Upsert beneficiary |
| GET | `/activity` | Admin or Member | Audit log entries |
| GET | `/member/journey` | Admin | Timeline for one member |

### `apply.js`

**Public:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/waiting-list` | Join waiting list (address validated) |
| GET | `/waiting-list/status` | Public queue (names + position) |
| GET | `/validate-address` | 50-mile radius check (Downtown LA) |
| POST | `/verify` | Verify waiting list invite token for `/application` |
| POST | `/membership` | Submit full membership application + ID docs (base64 JSONB) |

**Admin** (requires board JWT):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/applications` | List applications |
| GET | `/applications/:id` | Detail + ID previews |
| PATCH | `/applications/:id` | Save review checklist |
| POST | `/applications/:id/approve` | Approve → creates member in CRM |
| POST | `/applications/:id/reject` | Reject |

Application checklist (all 4 required to approve): name match, fields complete, CA ID uploaded, $200 fee paid.

### `payouts.js` (admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List payout cases |
| POST | `/` | Open new case |
| GET | `/:id` | Detail (includes document data for review) |
| PATCH | `/:id` | Update beneficiary, checklist, upload docs, notes |
| POST | `/:id/approve` | Board approval (2 required per by-laws) |
| POST | `/:id/mark-paid` | Mark $15,000 sent |

**Payout document slots:** `deceased_ss`, `deceased_id`, `beneficiary_ss`, `beneficiary_id`, `death_certificate` (base64 in JSONB, max 5 MB, same pattern as application IDs).

**Required for board approval:** deceased ID, beneficiary ID, relationship verified. Death certificate and SSN card copies are **optional** (board checks if collected).

**Statuses:** `Documents Pending` → `Under Review` → `Approved` (2 approvals) → `Paid Out`. Also `On Hold`.

### Supporting modules

- **`notify.js`** — Called from apply/portal/sync on profile, beneficiary, application events.
- **`sync.js`** — Keeps waiting list ↔ application ↔ member notes in sync; logs audit entries.
- **`audit.js`** — `logActivity`, `getActivityLog`, `getMemberJourney`.
- **`admin-auth.js`** — `verifyAdminRequest`, `verifyMemberRequest`, actor builders.
- **`paypal-sync.js`** — Fetches PayPal invoices; **not** persisted to DB automatically yet.

---

## 7. Frontend — what exists and what's wired

### Public site (`public/index.html`)

Single-page app with hash routing (`#apply`, `#waitingliststatus`, etc.). English + Amharic (`lang-am` body class).

**Sections:** Announcement, How It Works, About, Payment, By-Laws, Waiting List (apply), Waiting List Status, Contact.

**Completed UX work (recent sessions):**

- Desktop hero: content starts under nav (not vertically centered empty space).
- Nav: desktop shows Home, Member Login, hamburger, language; other links in dropdown.
- Payment section: PayPal/Zelle as emoji icons; Direct Deposit CTA → `/portal/` upload; phone in copy.
- By-Laws: in-page PDF viewer modal (`#bylawViewer`) instead of forced download.
- Waiting list apply page: **embedded waiting list status** (search + table) before the signup form; removed old “3+ year wait” static row.
- Full waiting list status section still at `#waitingliststatus` (shared API + `waiting-list-public.json` fallback).
- Address validation on waitlist submit via `apply/validate-address`.

**CSS:** `public-pages.css` (cache-bust query params on link, e.g. `?v=wlapply1`).

### Member portal (`public/portal/index.html`)

**Wired to API:**

- Phone + PIN login (`auth.js`)
- Real invoices from DB (`portal/invoices`)
- Profile edit (`portal/profile`)
- Beneficiary CRUD (`portal/beneficiary`)
- Activity feed in notifications tab (`portal/activity`)

**Still mock / not wired:**

- Receipt upload (`doUpload()` shows confirmation UI only — **no `upload.js`**, no S3)
- Static `NOTIFS` array for some notification cards
- PayPal links use invoice data when available

**UI fix:** Greeting card logo size capped in `compat.css` + `app-theme.css`.

### Board admin (`public/admin/index.html`)

**Views:** Invoices · Members CRM · Applications · Event Summary · **Payout Fund** · Activity Log

**Data sources:**

1. Live API when `DATABASE_URL` works (`portal/members`, `portal/invoices`, `apply/applications`, `payouts`, `portal/activity`)
2. Fallback: `admin/invoices-snapshot.json` for invoices offline

**Features:**

- Invoice tracker: filter, search, mark paid (session + API)
- Member edit modal + member journey timeline
- Application review modal with 4-item checklist + approve/reject → CRM
- Event summary cards from invoice `item` field; **“$ Payout case”** button opens payout workflow
- **Payout Fund:** open case, upload docs, checklist, 2 board approvals, mark paid
- Activity log view

**Admin auth fix:** Removed erroneous `compat.css` import that broke layout. Auth gated by `ADMIN_AUTH_ENABLED`.

### Membership application (`public/application/index.html`)

- Waiting list verification gate (`apply/verify`)
- Full form with CA ID photo upload (member + spouse)
- Submits to `apply/membership`

---

## 8. Completed work (summary by phase)

### Phase 1 — Frontends (DONE)

- Public website, portal UI, admin CRM UI deployed on Netlify.

### Phase 2 — Backend foundation (LARGELY DONE)

- [x] PostgreSQL schema
- [x] `auth.js` — PIN + board login
- [x] `portal.js` — members, invoices, profile, beneficiary
- [x] Seed scripts from PayPal/member exports
- [x] Admin wired to live DB with snapshot fallback
- [ ] Full production seed on Render (ops task)
- [ ] All 219 members with PINs (ops task)

### Phase 3 — PayPal (PARTIAL)

- [x] `paypal-sync.js` basic fetch
- [ ] Hourly cron sync to DB
- [ ] Live portal invoice refresh from PayPal

### Phase 4 — Applications & waiting list (DONE)

- [x] Waiting list POST + public status API
- [x] `waiting-list-public.json` static fallback
- [x] Address 50-mile validation (`geo.js`)
- [x] `/application` form + admin review + approve → member CRM
- [x] ID documents stored in JSONB on `membership_applications`

### Phase 5 — Notifications & audit (DONE)

- [x] `notify.js` — SendGrid + Twilio
- [x] `audit.js` + Activity Log in admin
- [x] `sync.js` — cross-entity sync on profile/beneficiary/application/invoice changes
- [x] Member journey in admin member modal

### Phase 6 — Payout fund workflow (NEW — DONE in code, needs DB migration)

- [x] `event_payouts` table
- [x] `payouts.js` API
- [x] Admin **Payout Fund** view + modal
- [ ] Family-facing document upload (not built — board uploads only for now)

### Public site polish (DONE)

- Nav, hero, payment, by-laws viewer, waiting list status embed, cache busting.

---

## 9. Not done yet / known gaps

| Item | Notes |
|------|-------|
| Receipt upload backend | `upload.js` missing; portal upload is UI-only |
| Cloud storage | S3 vars in `.env.example` unused |
| `events.js` | No admin “create event → auto 195 invoices” flow |
| PayPal → DB sync | Manual/snapshot based today |
| Twilio SMS bot | Phase 5 in handoff doc — not started |
| Automated reminders | Day 3/7/14 unpaid — not started |
| Registration fee PayPal link | Checklist item manual in admin |
| `README.md` | Still says “coming soon” for several done features |
| Domain cutover | hibretedir.com may still partially be Wix |
| `event_payouts` migration | Must run on production Postgres before Payout Fund works live |

---

## 10. Business rules (implement carefully)

From by-laws / handoff — enforce in UI copy and validation where possible:

- Ethiopian origin, **50 miles** of Downtown LA
- **$200** one-time membership fee after waiting list invite
- **$110** per event, due within 3 days
- **4-month waiting period** for new members before benefits
- **$15,000** payout; **2 board approvals** required
- **200** member cap
- Coverage: member, spouse, children up to 26

---

## 11. Agent conventions

1. **Minimal diffs** — match existing vanilla JS + CSS patterns; no unnecessary frameworks.
2. **Bilingual** — public and portal strings need `.en` / `.am` pairs; Amharic font: Noto Sans Ethiopic.
3. **Mobile first** — most members use phones.
4. **Do not commit or push** unless the user explicitly asks. Batch complete features before deploy — **Netlify free tier has ~300 build credits/month**; local dev first (`npm run dev`).
5. **Do not commit** `.env`, secrets, or `data/` exports.
6. **Database:** use timeouts, close connections (`db.js` Pool); handle missing tables gracefully in APIs.
7. **Admin auth:** production should set `ADMIN_AUTH_ENABLED=true` on Netlify.
8. **Sensitive data:** ID docs and payout docs stored as base64 in JSONB — never log full payloads; UI warns about SSN handling.

---

## 12. Recent session changelog (for continuity)

### Waiting list / public site

- Removed “3+ Year Wait” requirement row from apply section.
- Added **embedded waiting list status** on apply page (search, table, link to full list).
- Shared `loadWaitingListStatus()` across apply + status sections.

### Admin fixes

- Board login no longer required locally unless `ADMIN_AUTH_ENABLED=true`.
- Removed `compat.css` from admin (was breaking tracker layout).

### Portal

- Profile + beneficiary API wired; greeting logo size fixed.

### Payout fund (latest)

- New `event_payouts` schema + `payouts.js`.
- Admin sidebar **Payout Fund** with full workflow.
- Event cards link to open payout case.

---

## 13. Quick troubleshooting

| Problem | Likely cause |
|---------|----------------|
| Admin shows no invoices | No `DATABASE_URL`; run `build:invoice-snapshot` |
| Applications empty | DB not seeded or no submissions yet |
| Payout Fund 503 | `event_payouts` table not migrated |
| Waiting list status empty | DB empty + missing `waiting-list-public.json` |
| Netlify dev won't start | Google Drive + node_modules; use `start-dev.js` |
| CORS/auth errors | Missing JWT or `ADMIN_AUTH_ENABLED` mismatch |
| Notifications not sending | SendGrid/Twilio env vars unset (expected locally) |

---

## 14. Related documents

- **`HIBRET_EDIR_PROJECT_HANDOFF (1).md`** — Original full handoff (business context, AI SMS bot spec, phase roadmap).
- **`README.md`** — Deploy instructions (partially outdated).
- **`.env.example`** — All env vars.

---

*Maintained for Cursor agents. Update this file when completing major features or changing architecture.*
