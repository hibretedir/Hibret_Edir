# Hibret Edir — Automation Registry

**Purpose:** Living catalog of every automated workflow on the platform. Use this when onboarding developers, debugging flows, or explaining how systems connect.

**Last updated:** June 2026  
**Shareable overview:** [`automation-showcase.html`](automation-showcase.html) (also at `/docs/automation-showcase.html` when deployed)

---

## How to read this document

| Column | Meaning |
|--------|---------|
| **Status** | `Live` = in production code · `Partial` = works but manual steps remain · `Planned` = not built |
| **Trigger** | Real-world event that starts the automation |
| **Functions** | Netlify function files involved |
| **Tables** | Primary PostgreSQL tables touched |
| **Notify** | Email/SMS via `notify.js` (skipped if SendGrid/Twilio unset) |

---

## 1. Membership onboarding

| ID | Name | Status | Trigger | Functions | Tables | Notify |
|----|------|--------|---------|-----------|--------|--------|
| ONB-01 | Waiting list signup | Live | Public form submit | `apply.js` | `waiting_list`, `audit_log` | — |
| ONB-02 | Board invitation | Live | Admin **Send Invitation** | `apply.js`, `notify.js` | `waiting_list`, `audit_log` | Applicant email/SMS |
| ONB-03 | Application submitted | Live | `/application/` form POST | `apply.js`, `notify.js` | `membership_applications`, `waiting_list`, `audit_log` | Board alert |
| ONB-04 | Application review | Live | Admin saves checklist | `apply.js` | `membership_applications`, `audit_log` | — |
| ONB-05 | Approve & send invoice | Live | Admin **Approve & Send Invoice** | `apply.js`, `paypal-registration-invoice.js`, `notify.js` | `membership_applications`, `invoices`, `audit_log` | Applicant invoice email |
| ONB-06 | Registration paid → member | Live | PayPal sync or **Mark Registration Paid** | `paypal-sync.js`, `membership-completion.js`, `notify.js` | `members`, `beneficiaries`, `payments`, `invoices`, `waiting_list`, `membership_applications`, `audit_log` | Welcome (when configured) |
| ONB-07 | Application rejected | Live | Admin reject | `apply.js`, `notify.js` | `membership_applications`, `waiting_list`, `audit_log` | Applicant |

**Slot math:** `MEMBER_CAP − active_members − in_pipeline` — enforced on invite (`apply.js`).

**Detail:** [`membership-onboarding-workflow.md`](membership-onboarding-workflow.md)

---

## 2. Funeral events & member dues ($110)

| ID | Name | Status | Trigger | Functions | Tables | Notify |
|----|------|--------|---------|-----------|--------|--------|
| EVT-01 | PayPal invoice sync | Live | Cron 9 AM & 6 PM Pacific, admin **Sync PayPal**, `npm run sync:paypal` | `paypal-sync-scheduled.js`, `paypal-sync-background.js`, `paypal-sync.js` | `invoices`, `events`, `members` | — |
| EVT-02 | Event row from PayPal | Live | Sync finds new `event_number` on invoice | `paypal-sync.js` | `events` | — |
| EVT-03 | Registration invoice completion | Live | Paid $200 invoice linked to `membership_application_id` | `paypal-sync.js`, `membership-completion.js` | (see ONB-06) | — |
| EVT-04 | Public funeral announcement | Live | Latest Active event + `events.notes` JSON | `apply.js` (`/current-announcement`) | `events` | — |
| EVT-05 | Set announcement details | Partial | Ops runs script after new event | `scripts/set_event_announcement.js` | `events.notes` | — |
| EVT-06 | Create event + bulk invoices | Planned | Board creates new funeral event | — (handoff spec: `events.js`) | `events`, `invoices` | Planned mass notify |
| EVT-07 | Mass event announcement | Planned | New event → SMS/email/WhatsApp all members | `notify.js` (spec in handoff) | `events`, `notifications` | All members |
| EVT-08 | Payment reminders (day 3/7/14) | Planned | Cron | — | `invoices`, `notifications` | Members |

**Announcement JSON fields** (`events.notes`): `prayer_venue`, `prayer_address`, `prayer_datetime`, `burial_venue`, `burial_address`, `collect_dues`, `announcement_text`.

**Detail:** [`scheduled-paypal-sync.md`](scheduled-paypal-sync.md)

---

## 3. Payments & receipts (Zelle / BofA / manual)

| ID | Name | Status | Trigger | Functions | Tables | Notify |
|----|------|--------|---------|-----------|--------|--------|
| PAY-01 | Mark paid request | Live | Board member requests mark paid on invoice | `portal.js` / `apply.js` | `invoice_mark_paid_requests`, `audit_log` | Second board member |
| PAY-02 | Mark paid approval | Live | Second board approves in **Board Requests** | `apply.js` | `invoices`, `invoice_mark_paid_requests`, `audit_log` | — |
| PAY-03 | Receipt upload | Live | Member uploads Zelle/BofA receipt in portal | `receipts.js` | `receipts` | Board (optional) |
| PAY-04 | Receipt approve → paid | Live | Admin approves receipt | `receipts.js` | `receipts`, `invoices`, `audit_log` | Member |
| PAY-05 | Payment method stats | Live | Admin invoice stats refresh | `portal.js`, `payment-methods.js`, `invoice-stats-cache.js` | `invoices` | — |

**Dual control:** Requester cannot approve their own mark-paid request (admin UI enforces).

---

## 4. Member portal & self-service

| ID | Name | Status | Trigger | Functions | Tables | Notify |
|----|------|--------|---------|-----------|--------|--------|
| POR-01 | Phone + PIN auth | Live | Member login | `auth.js` | `members` | — |
| POR-02 | Invoice list (matched) | Live | Portal load | `portal.js` | `invoices`, `members` | — |
| POR-03 | Live notifications feed | Live | Unpaid invoices + activity | `portal.js` (client `buildLiveNotifications`) | `invoices`, `audit_log` | — |
| POR-04 | Profile update | Live | Member saves profile | `portal.js`, `notify.js` | `members`, `audit_log` | Member + board |
| POR-05 | Beneficiary change request | Live | Member submits change | `portal.js`, `notify.js` | `member_change_requests`, `audit_log` | Board |
| POR-06 | PIN reset request | Live | Forgot PIN on login | `auth.js`, `notify.js` | `pin_reset_requests` | Board |
| POR-07 | PIN reset approve | Live | Admin approves reset | `auth.js` | `members`, `pin_reset_requests`, `audit_log` | Member |
| POR-08 | Deaths paid count | Live | Portal home | `portal.js` | `invoices` (paid + event linked) | — |

**Invoice matching:** Portal matches by `member_id` **or** PayPal `recipient_name` vs member `paypal_name` / `full_name`.

---

## 5. Board governance & approvals

| ID | Name | Status | Trigger | Functions | Tables | Notify |
|----|------|--------|---------|-----------|--------|--------|
| GOV-01 | Board login (JWT) | Live | Admin sign-in | `auth.js`, `admin-auth.js` | `board_members` | — |
| GOV-02 | Beneficiary change approve/reject | Live | **Board Requests** tab | `apply.js`, `notify.js` | `member_change_requests`, `beneficiaries`, `audit_log` | Member |
| GOV-03 | Activity log | Live | Any audited action | `audit.js`, callers | `audit_log` | — |
| GOV-04 | Contact message inbox | Live | Public contact form | `apply.js` | `contact_messages` | Board (optional) |
| GOV-05 | Board reply to member | Live | Admin replies in Messages | `apply.js`, `notify.js` | `contact_messages`, `audit_log` | Member |
| GOV-06 | Approval tab: Waiting List | Live | Admin UI | `apply.js` | `waiting_list` | — |
| GOV-07 | Approval tab: Applications | Live | Membership only | `apply.js` | `membership_applications` | — |
| GOV-08 | Approval tab: Board Requests | Live | Mark paid + beneficiary | `apply.js` | `invoice_mark_paid_requests`, `member_change_requests` | — |

---

## 6. Payout fund ($15,000)

| ID | Name | Status | Trigger | Functions | Tables | Notify |
|----|------|--------|---------|-----------|--------|--------|
| OUT-01 | Open payout case | Live | Admin **Open Payout Case** | `payouts.js` | `event_payouts`, `audit_log` | — |
| OUT-02 | Document checklist | Live | Admin updates case | `payouts.js` | `event_payouts`, `audit_log` | — |
| OUT-03 | Board approve payout | Live | Dual board approval flow | `payouts.js` | `event_payouts`, `audit_log` | — |
| OUT-04 | Mark $15K paid out | Live | Admin confirms wire/check | `payouts.js` | `event_payouts`, `events`, `audit_log` | — |

---

## 7. Public website

| ID | Name | Status | Trigger | Functions | Tables | Notify |
|----|------|--------|---------|-----------|--------|--------|
| WEB-01 | Hero live stats | Live | Page load | `apply.js` (`/site-stats`), fallbacks | `members`, `events` | — |
| WEB-02 | Waiting list public status | Live | Page load | `apply.js` (`/waiting-list/status`) | `waiting_list` | — |
| WEB-03 | Waiting list signup | Live | Apply section form | `apply.js` | `waiting_list` | — |
| WEB-04 | Contact form | Live | Contact section | `apply.js` | `contact_messages` | — |
| WEB-05 | Address radius check | Live | Application address validate | `apply.js`, `geo.js` | — | — |

**Public labels:** `Added as Member` → **Added**; `Invited to Apply` / `Application Submitted` → **Invitation Sent**.

---

## 8. Notifications infrastructure

| ID | Name | Status | Trigger | Functions | Tables |
|----|------|--------|---------|-----------|--------|
| NTF-01 | SendGrid email | Partial | Any `notify.js` caller | `notify.js` | `notifications` — setup: `docs/notifications-setup.md` |
| NTF-02 | Twilio SMS | Partial | Any `notify.js` caller | `notify.js` | `notifications` — setup: `docs/notifications-setup.md` |
| NTF-03 | Board alert email/SMS | Partial | Applications, receipts, etc. | `notify.js` | `notifications` |
| NTF-04 | Graceful skip | Live | Missing API keys | `notify.js` | — |
| NTF-05 | Config test script | Live | `npm run test:notify` | `scripts/test_notifications.js` | — |

**Env:** `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `TWILIO_*`, `BOARD_NOTIFY_EMAIL`, `BOARD_NOTIFY_PHONE`.

---

## 9. Scheduled jobs

| Job | Schedule | Function | What it does |
|-----|----------|----------|--------------|
| PayPal sync | Hourly cron; runs sync **9 AM & 6 PM Pacific** | `paypal-sync-scheduled.js` → `paypal-sync-background.js` | Pull PayPal invoices → DB; complete registration payments |
| Manual full sync | On demand | `npm run sync:paypal` | Same without Netlify timeout limits |

**Requires:** `CRON_SECRET` on Netlify production.

---

## 10. Planned / not built

| Item | Notes |
|------|-------|
| Admin create event → auto ~197 PayPal invoices | Spec in handoff; no `events.js` yet |
| Mass SMS/email/WhatsApp on new funeral | Spec in handoff |
| Automated payment reminders | Day 3, 7, 14 |
| Welcome email + digital membership card | Partial notify exists |
| 4-month waiting period enforcement | Business rule not coded |
| Twilio SMS bot for members | Spec in handoff |
| S3 receipt storage | Base64 in Postgres today |
| Admin UI for event announcement | Use `set_event_announcement.js` |

---

## File index (quick lookup)

| Area | Primary files |
|------|----------------|
| Onboarding | `netlify/functions/apply.js`, `membership-completion.js`, `paypal-registration-invoice.js` |
| PayPal | `paypal-sync.js`, `paypal-sync-scheduled.js`, `paypal-sync-background.js`, `paypal-client.js` |
| Portal | `netlify/functions/portal.js`, `public/portal/index.html` |
| Admin | `public/admin/index.html` |
| Public site | `public/index.html` |
| Receipts | `netlify/functions/receipts.js` |
| Payouts | `netlify/functions/payouts.js` |
| Auth | `netlify/functions/auth.js` |
| Notifications | `netlify/functions/notify.js` |
| Audit | `netlify/functions/audit.js` |
| Schema | `db/schema.sql` |
| Ops scripts | `scripts/set_event_announcement.js`, `scripts/sync_paypal.js`, `scripts/run_schema.js` |

---

## Maintenance checklist

When adding a new automation:

1. Add a row to the appropriate section above (new ID).
2. Add trigger diagram to [`automation-showcase.html`](automation-showcase.html) if portfolio-worthy.
3. Write `audit_log` entries for board-visible actions.
4. Wire `notify.js` if humans need to know.
5. Update [`Context.md`](../Context.md) if architecture changes.

---

*Registry version 1.0 — June 2026*
