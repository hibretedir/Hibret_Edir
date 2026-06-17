# System validation playbook

**Purpose:** Repeatable end-to-end test of the membership onboarding lifecycle using real production logic — no cap bypass, no invite overrides.

**Policy:** `MEMBER_CAP=201` = **200 member families + 1 reserved validation slot**. Real new members still target 200 active; slot 201 is for proving the join process works.

---

## Environment (Netlify + local `.env`)

| Variable | Value | Notes |
|----------|--------|--------|
| `MEMBER_CAP` | `201` | Permanent reserved QA slot |
| `DEMO_QA_ENABLED` | `true` | Enables test-member reset + Monitor Health test actions |
| `DEMO_QA_EMAIL` | `hibretedirtest@gmail.com` | **Only** this identity can be reset (safety) |
| `DEMO_QA_PHONE` | Test phone | Application verify + waiting list |
| `DEMO_QA_NAME` | Display name | Shown on Monitor Health dashboard |
| `REGISTRATION_FEE` | `1` for QA, `200` for production | PayPal registration invoice amount (live PayPal = real charge) |
| `SENDGRID_API_KEY` | Set on Netlify | Required for invitation / application emails |
| `SENDGRID_FROM_EMAIL` | Verified sender in SendGrid | Must match SendGrid sender authentication |
| `TEST_NOTIFY_EMAIL` | Same as `DEMO_QA_EMAIL` locally | Optional — for `npm run test:notify -- --send` |

**Admin UI:** **System Health → Health & Tests** — **Dashboard** and **Test** tabs (integrations, test member pipeline, Meridian validation steps).

---

## Email & SMS testing (before onboarding QA)

Verify SendGrid **before** running ONB-02 (invitation email). Two ways:

### A. Admin UI (production or local with `npm run dev`)

1. Admin → **System Health** → **Dashboard**
2. Confirm **SendGrid** health card shows **Pass**
3. Click **Send test email** — sends to `DEMO_QA_EMAIL` (e.g. `hibretedirtest@gmail.com`)
4. Check inbox (and spam) for subject **Hibret Edir — QA test email**

**Test tab:** Phase **0 — Notifications** → step **NTF-01** has the same button and instructions.

### B. CLI (local `.env`)

```bash
# Config only — no send
npm run test:notify

# Live send to TEST_NOTIFY_EMAIL (+ TEST_NOTIFY_PHONE for SMS)
npm run test:notify -- --send
```

Required in `.env`:

```
SENDGRID_API_KEY=SG....
SENDGRID_FROM_EMAIL=notifications@hibretedir.com
TEST_NOTIFY_EMAIL=hibretedirtest@gmail.com
TEST_NOTIFY_PHONE=4245475594   # optional SMS test
```

### C. Real-flow email (end-to-end)

After NTF-01 passes, run onboarding step **ONB-02** — **Send Invitation** should deliver the real invite template to the same QA email.

Full reference: `docs/notifications-setup.md`

---

## Validation cycle

### 1. Before test

- Confirm Admin banner shows open slot: e.g. `200 / 201 active — 1 spot open`
- If a prior test was incomplete, run **Reset demo cycle** (Admin) or:

```bash
npm run demo:reset          # dry run — shows what will change
npm run demo:reset:apply    # execute reset
```

### 2. Run full process (live site)

| Step | Action | Validates |
|------|--------|-----------|
| 0 | **System Health → Send test email** (NTF-01) | SendGrid keys, verified sender, deliverability |
| 1 | Public waiting list signup (`DEMO_QA_EMAIL`) | Form, address check, duplicate rules |
| 2 | Admin → Waiting List → **Send Invitation** | Slot math, rank, email notification |
| 3 | Applicant opens `/application/`, verifies email/phone, submits | Application API, file upload |
| 4 | Admin → Applications → review checklist → approve | Board review, PayPal registration invoice |
| 5 | Payment (PayPal or board **Mark Registration Paid**) | PayPal sync / mark-paid, member creation |
| 6 | Confirm CRM: new **Active** member, waiting list **Added as Member** | `membership-completion.js`, audit log |

### 3. After test — reset

**Admin:** Waiting List tab → **Reset demo cycle**

Or CLI: `npm run demo:reset:apply`

**What reset does:**

- Demo member → **Inactive** (frees cap slot; record kept for audit)
- Demo **application** → deleted
- Demo **waiting list** row → **Rejected** (same email can sign up again)
- Registration invoice → **Cancelled** if still unpaid

**What reset does *not* do:**

- Does not use funeral/deceased event flow (different lifecycle)
- Does not delete the member row (optional later if CRM cleanup needed)
- Does not reset real members — only `DEMO_QA_EMAIL`

### 4. Repeat

Sign up on the public form again with the same email → full cycle from step 1.

---

## When to run

- Before a board demo of the join process  
- After deploys touching `apply.js`, notifications, PayPal, or admin onboarding  
- Monthly/quarterly operational health check  
- When debugging a reported onboarding issue  

---

## Board talking points

> “We keep 200 member slots. Slot 201 is reserved to run the full join process anytime and confirm email, applications, payments, and member creation still work. After each test we reset the demo identity — production rules never change.”

---

## Future: automated periodic test

The same reset can be driven by CI or a scheduled agent:

1. `POST /.netlify/functions/apply/demo-qa/reset` (admin JWT) — or run `npm run demo:reset:apply` against production DB from a secure runner  
2. Script/API signup → invite → application → approve → mark paid (Playwright or Cursor agent)  
3. Assert member active + audit entries  
4. Reset again  

Keep `DEMO_QA_EMAIL` dedicated; never point automation at a real member email.

---

## PayPal registration ($1 real-money test)

With `REGISTRATION_FEE=1` and live PayPal credentials, **Approve & Send Invoice** creates a **$1.00** PayPal invoice (real charge). After payment:

- Scheduled sync (9 AM & 6 PM Pacific) or Admin **Sync PayPal** marks it paid  
- System creates the active member automatically  
- Or use **Mark Registration Paid** to skip PayPal and test member creation  

Set `REGISTRATION_FEE=200` when not running QA (or omit — default is 200).

---

## Death / funeral workflow — what you can test now

The “someone dies, board gets a call” journey has **several parts**. Not all are built as one button yet.

| Step | Status | How to test today |
|------|--------|-------------------|
| Board opens **$15K payout case**, collects docs, dual approval | **Live** | Admin → **Payout Fund** → **Open Payout Case** (use a fake name + link to an existing event label) |
| Public **funeral announcement** (prayer/burial) | **Live** | Needs an **Active** row in `events`; update details with `node scripts/set_event_announcement.js <event#>` |
| Members see **$110 invoice** in portal | **Live** | Only if an invoice exists for that member (usually created in PayPal when board runs an event) |
| PayPal **sync** marks event invoices paid | **Live** | Pay a real/small invoice or **Mark Paid** / receipt flow |
| **New event** → auto-create **~200 PayPal invoices** + mass SMS/email | **Not built yet** (planned EVT-06 / EVT-07) | Cannot test full “call comes in → everyone notified” from Admin today |

**Practical QA path for death (partial, no blast to 200 members):**

1. Complete demo onboarding so QA member exists and is **Active**  
2. **Payout Fund:** open a test case (“QA Test Deceased”), walk document checklist → approve → mark paid out  
3. **Announcement:** if you have event #N in DB, run `set_event_announcement.js` and check public **Announcement** section  
4. **Single-member $110:** create one PayPal invoice manually in PayPal for the demo member at **$1** (or wait until bulk event creation is built), then sync  

**Do not** use the demo reset / inactive member flow to simulate death — that is for onboarding QA only. Payout cases are the correct death-benefit test surface.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|--------|-----|
| “Email already on waiting list” | Prior row not rejected | Run reset |
| Send Invitation disabled | No open slots (`in_pipeline` full or 201 active) | Reset demo pipeline; ensure demo member is Inactive |
| No invitation email received | SendGrid not configured or sender unverified | Run NTF-01 test email; check `docs/notifications-setup.md` |
| Test email fails in admin | Missing `DEMO_QA_EMAIL` or SendGrid env | Set env vars on Netlify and redeploy |
| Reset button missing | `DEMO_QA_ENABLED` not true | Set env + redeploy |
| Reset rejected wrong person | Email mismatch | Only `DEMO_QA_EMAIL` is allowed |

---

## Related

- `netlify/functions/demo-qa-reset.js` — reset logic  
- `scripts/demo_cycle_reset.js` — CLI  
- `docs/membership-onboarding-workflow.md` — full workflow reference  
