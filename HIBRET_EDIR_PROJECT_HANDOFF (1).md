# HIBRET EDIR — Complete Project Handoff
## For Cursor AI Agent

---

## 1. WHAT IS HIBRET EDIR?

Hibret Edir is an Ethiopian mutual assistance organization (Edir) based in Greater Los Angeles, California. It operates as a funeral support fund — when a member or their immediate family member dies, all active members contribute $110 each, and the grieving family receives a $15,000 payout to cover funeral and burial costs.

- **Founded:** 2011
- **Members:** 195 active members (at full capacity of 200)
- **Contribution:** $110 per event per member
- **Payout:** $15,000 per event
- **Location:** Greater Los Angeles (members within 50-mile radius of Downtown LA)
- **Status:** Operating as a community organization, 501(c) status in progress
- **Phone:** (424) 547-5594 (dedicated org number)
- **Emails:** hibretedirautomation@gmail.com (technical), hibretedirtext@gmail.com (member communications)
- **Website:** hibretedir.com (currently on Wix — being replaced)
- **PayPal:** hibretedirautomation@gmail.com

---

## 2. WHO IS BUILDING THIS?

The developer is a board member (also serving as Secretary) of Hibret Edir. He is handling all technology pro bono. He has:
- GitHub account under hibretedirautomation@gmail.com
- Netlify account (Pro plan, $24/month)
- Render account (PostgreSQL database, paying ~$7/month)
- PayPal Business account with API Client ID (has Client ID, needs to securely add Secret)
- Experience with Python, N8N automation, PythonAnywhere
- Existing system: PythonAnywhere fetches PayPal invoices → Google Sheets → Wix displays data

**Goal:** Replace the fragmented Wix + PythonAnywhere + Google Sheets + N8N system with a single modern web platform on Netlify + Render.

---

## 3. TECH STACK DECISIONS

| Layer | Technology | Reason |
|-------|-----------|--------|
| Frontend | HTML, CSS, Vanilla JS | Already built, works great |
| Hosting | Netlify | Already using, Pro plan |
| Database | Render PostgreSQL | Already paying for it |
| Auth | Custom PIN (hashed with bcrypt) | Simple for non-tech members |
| Payments | PayPal REST API | Already using PayPal |
| SMS/WhatsApp | Twilio | Port (424) 547-5594 to Twilio |
| Email | SendGrid | Free tier sufficient |
| Version Control | GitHub | Under hibretedirautomation account |
| Functions | Netlify Functions (serverless) | No separate server needed |

**NOT using:** Google Sheets, Wix, PythonAnywhere, N8N (all being replaced)

---

## 4. REPO STRUCTURE

```
hibretedir/
├── public/
│   ├── index.html              ← Public website (replaces Wix)
│   ├── portal/
│   │   └── index.html          ← Member portal (phone + PIN)
│   └── admin/
│       └── index.html          ← Board CRM & invoice dashboard
├── netlify/
│   └── functions/
│       ├── auth.js             ← PIN login, JWT tokens
│       ├── paypal-sync.js      ← Fetch invoices from PayPal API
│       ├── upload.js           ← Receipt upload handler
│       ├── members.js          ← CRUD for member data
│       ├── events.js           ← Funeral event management
│       └── notify.js           ← SMS/email/WhatsApp triggers
├── netlify.toml
├── .env.example
└── README.md
```

---

## 5. DATABASE SCHEMA (Render PostgreSQL)

```sql
-- Members table
CREATE TABLE members (
  id SERIAL PRIMARY KEY,
  member_number INTEGER UNIQUE NOT NULL,
  status VARCHAR(20) DEFAULT 'Active', -- Active, Not Active, Deceased
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  full_name VARCHAR(200), -- includes spouse name
  paypal_name VARCHAR(200), -- exact name as it appears in PayPal
  email VARCHAR(200),
  mobile VARCHAR(20),
  home_phone VARCHAR(20),
  address TEXT,
  pin_hash VARCHAR(200), -- bcrypt hashed PIN
  notes TEXT,
  joined_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Beneficiaries table
CREATE TABLE beneficiaries (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(20),
  relationship VARCHAR(100),
  is_primary BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Events table (each funeral event)
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  event_number INTEGER UNIQUE NOT NULL, -- e.g. 30
  deceased_name VARCHAR(200) NOT NULL,
  deceased_relationship VARCHAR(100), -- member, spouse, child
  member_id INTEGER REFERENCES members(id), -- which member's family
  event_date DATE,
  announcement_sent_at TIMESTAMP,
  amount_per_member DECIMAL(10,2) DEFAULT 110.00,
  payout_amount DECIMAL(10,2) DEFAULT 15000.00,
  payout_sent BOOLEAN DEFAULT false,
  payout_sent_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'Active', -- Active, Closed
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Invoices table (synced from PayPal)
CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  paypal_invoice_id VARCHAR(100) UNIQUE,
  invoice_number INTEGER,
  member_id INTEGER REFERENCES members(id),
  event_id INTEGER REFERENCES events(id),
  status VARCHAR(50), -- Unpaid, Paid, Cancelled
  amount DECIMAL(10,2),
  amount_due DECIMAL(10,2),
  sent_date DATE,
  paid_date DATE,
  payment_method VARCHAR(50), -- PayPal, Zelle, BofA, Cash
  paypal_link TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Receipts table (uploaded by members for Zelle/BofA)
CREATE TABLE receipts (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  invoice_id INTEGER REFERENCES invoices(id),
  event_id INTEGER REFERENCES events(id),
  payment_method VARCHAR(50), -- Zelle, BofA
  amount DECIMAL(10,2),
  file_url TEXT, -- stored in Render or cloud storage
  notes TEXT,
  status VARCHAR(20) DEFAULT 'Pending', -- Pending, Approved, Rejected
  reviewed_by INTEGER REFERENCES board_members(id),
  reviewed_at TIMESTAMP,
  submitted_at TIMESTAMP DEFAULT NOW()
);

-- Board members table (for admin login)
CREATE TABLE board_members (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  role VARCHAR(50), -- President, Secretary, Treasurer, Tech, Board
  email VARCHAR(200) UNIQUE,
  password_hash VARCHAR(200),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit log
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  board_member_id INTEGER REFERENCES board_members(id),
  action VARCHAR(100),
  table_name VARCHAR(100),
  record_id INTEGER,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Notifications log
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  event_id INTEGER REFERENCES events(id),
  type VARCHAR(50), -- SMS, Email, WhatsApp
  message TEXT,
  status VARCHAR(20), -- Sent, Failed, Pending
  sent_at TIMESTAMP DEFAULT NOW()
);
```

---

## 6. ENVIRONMENT VARIABLES (Netlify Dashboard)

```env
# PayPal API
PAYPAL_CLIENT_ID=your_client_id_here
PAYPAL_SECRET=your_secret_here
PAYPAL_MODE=production  # or sandbox for testing

# Database
DATABASE_URL=postgresql://user:password@host:port/dbname

# Auth
JWT_SECRET=random_long_secret_string
JWT_EXPIRES_IN=7d

# Twilio (SMS/WhatsApp)
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_PHONE=+14245475594  # after porting

# SendGrid (email)
SENDGRID_API_KEY=your_key
FROM_EMAIL=hibretedirtext@gmail.com

# App
NODE_ENV=production
APP_URL=https://hibretedir.com
```

---

## 7. WHAT'S ALREADY BUILT (Frontend Only)

### Public Website (public/index.html)
- Full page with hero, announcement banner, how it works, about, payment methods, by-laws, apply/waiting list, contact, footer
- English / Amharic language toggle
- Mobile-first design with section-based navigation on mobile
- Tapping a section on mobile shows it full screen with back button
- Hamburger menu with full screen overlay on mobile
- Logo centered in nav on mobile

### Member Portal (public/portal/index.html)
- Phone number + PIN authentication flow
- First-time users create a PIN (4-digit)
- Returning users enter PIN with shake animation on wrong attempt
- Dashboard showing: outstanding invoices, events paid, amount due
- Invoice list with PayPal payment links and days overdue indicators
- Receipt upload (photo/file) for Zelle and BofA payments
- Confirmation screen after receipt submitted
- Profile page with all member info and edit buttons
- Beneficiary section (designate who receives $15K payout)
- Notifications tab
- Change PIN modal
- Sign out
- Bottom navigation bar (Home, Invoices, Receipt, Profile)
- Currently uses demo data embedded in HTML — needs backend wiring

### Board CRM (public/admin/index.html)
- Sidebar navigation
- Members view: all 219 members searchable and filterable
- Member detail modal: edit all fields, view invoice history, mark paid
- Invoice dashboard: all invoices grouped by event, searchable
- Overview tab: stats, event cards, members with unpaid invoices, missing emails
- Currently uses demo data — needs backend wiring

---

## 8. MEMBER DATA

- **Total members:** 219 (195 Active, 24 Not Active)
- **With email:** ~171
- **With address:** ~148
- **Data source:** Excel file with 3 sheets: Active List, Original (with emails/addresses), Deceased or Out
- **All data has been parsed and is ready to seed into PostgreSQL**
- The member data JSON is embedded in the CRM HTML file currently

---

## 9. INVOICE DATA

- **Total unpaid invoices:** 118 (from PayPal export as of June 3, 2026)
- **Events covered:** 6 events (#25 through #30)
- **Amount per invoice:** $110
- **Total outstanding:** ~$12,980
- **Current event:** #30 — Ato Brook Zewdie (April 2026)
- **Data format:** PayPal CSV export, parsed and embedded in HTML

---

## 10. PAYMENT FLOW

Members currently pay via:
1. **PayPal** (best — auto-trackable via API)
2. **Zelle** — sends to board's phone, manual tracking
3. **Bank of America direct deposit** — manual tracking

For Zelle and BofA:
- Member sends payment
- Member takes screenshot of confirmation
- Member uploads screenshot to portal
- Board gets notification
- Board reviews and marks invoice paid in CRM

---

## 11. NETLIFY FUNCTIONS NEEDED

### auth.js
- POST /auth/check-phone — verify phone in members table
- POST /auth/verify-pin — compare hashed PIN
- POST /auth/create-pin — hash and store new PIN
- POST /auth/board-login — email + password for board members
- POST /auth/refresh — refresh JWT token

### paypal-sync.js
- GET /paypal/sync — fetch all invoices from PayPal API, update DB
- GET /paypal/invoices/:memberId — get invoices for one member
- POST /paypal/create-invoices/:eventId — create invoices for all members for new event

### members.js
- GET /members — all members (board only)
- GET /members/:id — single member
- PUT /members/:id — update member info
- GET /members/me — current member's own data (from JWT)
- PUT /members/me — member updates own info

### events.js
- GET /events — all events
- POST /events — create new funeral event (board only)
  - Triggers: create PayPal invoices for all members
  - Triggers: send SMS + email + WhatsApp to all members
- GET /events/:id — event details with payment status

### receipts.js
- POST /receipts — member uploads receipt
  - Saves file to storage
  - Notifies board via email/SMS
- GET /receipts — all pending receipts (board only)
- PUT /receipts/:id/approve — board approves receipt, marks invoice paid
- PUT /receipts/:id/reject — board rejects receipt

### notify.js
- POST /notify/event — send announcement to all members (SMS + email + WhatsApp)
- POST /notify/reminder — send reminder to unpaid members
- POST /notify/member — send message to specific member

---

## 12. AUTOMATION WORKFLOWS

### New Funeral Event Flow
```
Board clicks "New Event" in admin
  → Enter: deceased name, relationship, member affected, date
  → System creates event record in DB
  → PayPal API: create invoice for each of 195 active members
  → Twilio: send SMS to all members with mobile numbers
  → SendGrid: send email to all members with email addresses
  → Twilio WhatsApp: send WhatsApp to all members
  → Dashboard updates in real time
  → Automated reminders scheduled: day 3, day 7, day 14
```

### Payment Received (PayPal)
```
Hourly cron job OR PayPal webhook
  → Sync invoices from PayPal API
  → Update invoice status in DB
  → Member portal shows updated status
```

### Receipt Upload (Zelle/BofA)
```
Member uploads photo in portal
  → File saved to cloud storage
  → Board gets SMS + email notification
  → Board reviews in admin CRM
  → Board clicks Approve
  → Invoice marked paid in DB
  → Member gets SMS confirmation
```

### Overdue Reminders
```
Day 3 after event: SMS + email to all unpaid members
Day 7: SMS + email + WhatsApp to all still unpaid
Day 14: SMS + email + WhatsApp + board gets delinquency list
Day 45: Board gets termination warning list (per by-laws Article 11)
```

### Waiting List Flow
```
Person submits application on website
  → Saved to waiting_list table in DB
  → Auto-email confirmation to applicant
  → Board gets notification
  → Board reviews in admin (check 50-mile rule, background)
  → Board clicks Approve
  → Applicant gets invitation email/SMS
  → Applicant pays $200 registration fee via PayPal
  → Added to active members table
  → PayPal invoices generated for future events
  → Welcome email + digital membership card sent
  → 4-month waiting period tracked (no benefits until day 121)
```

---

## 13. AI SMS BOT (Phase 5)

When members text (424) 547-5594:

```
Member: "Did I pay for event 30?"
Bot: "Hi Zerfe, your $110 for Event #30 (Ato Brook Zewdie) 
     is UNPAID. Due April 18. Pay here: [PayPal link]"

Member: "How much do I owe?"
Bot: "Hi Samuel, you have 2 unpaid invoices: 
     Event #29 ($110) + Event #30 ($110) = $220 total."

Member: "My phone number"
Bot: "You are Member #47 - Samuel Woldeyes. 
     Status: Active. Last payment: Event #28."

Member: "STOP"
Bot: "You have been unsubscribed from reminders."
```

Implementation: Twilio webhook → Netlify function → query DB → send reply

---

## 14. BY-LAWS SUMMARY (key rules to implement)

- **Membership:** Ethiopian origin, within 50 miles of Downtown LA (Staples Center)
- **Initial fee:** $200 (one-time)
- **Per event:** $110 due within 3 days of notification
- **Late payment:** After 3 days = late
- **Grace period:** 45 days total
- **Termination:** After 4 consecutive delinquencies + 45 days each
- **Payout:** $15,000 per event
- **Coverage:** Member + spouse + biological/adopted children up to age 26
- **New member waiting:** 4 months before drawing benefits (accidental death is immediate)
- **Board approval required:** 2 board members must approve payout
- **Capacity:** 200 active members maximum
- **Reports:** Financial reports to all members every 6 months

---

## 15. BUILD PRIORITY ORDER

### Phase 1 — Live on Netlify (DONE)
- ✅ Public website
- ✅ Member portal (frontend)
- ✅ Board CRM (frontend)
- ✅ Deployed to Netlify

### Phase 2 — Backend Foundation (START HERE)
- Set up Render PostgreSQL tables
- Seed all 219 members from existing data
- Seed 118 invoices from PayPal export
- Build auth.js Netlify function (phone + PIN)
- Wire member portal login to real database
- Wire CRM to real database

### Phase 3 — PayPal Integration
- Build paypal-sync.js function
- Auto-pull invoices every hour
- Live payment status in portal and CRM
- Add PayPal Client Secret to Netlify env vars

### Phase 4 — Event Automation
- Build events.js function
- New event creation in admin → auto-creates all 195 invoices via PayPal API
- Wire up receipt upload flow
- Board approval workflow

### Phase 5 — Notifications
- SendGrid email setup
- Twilio SMS setup (port 424-547-5594)
- Twilio WhatsApp setup
- Auto-send on new event
- Auto-reminders at day 3, 7, 14
- AI SMS bot for member queries

### Phase 6 — Waiting List & Registration
- Online application → database
- Board approval flow
- Registration fee payment via PayPal
- Welcome email and digital membership card

### Phase 7 — Reporting & Polish
- Event collection reports
- Annual financial report (auto November)
- Delinquency reports
- Board presentation mode
- Member self-service portal fully complete

### Phase 8 — Go Live
- Point hibretedir.com to Netlify
- Cancel Wix ($30/month saved)
- Cancel PythonAnywhere ($5/month saved)
- Cancel Google Sheets dependency
- Board review and sign-off
- Training session for board members

---

## 16. IMPORTANT NOTES FOR THE AGENT

1. **Language:** The site supports English and Amharic. All user-facing text needs both languages. Amharic uses font: 'Noto Sans Ethiopic'.

2. **Mobile first:** Most members use phones. Every screen must work perfectly on mobile (375px+). The portal and website are heavily optimized for mobile.

3. **Non-tech members:** Many members are older Ethiopian community members not comfortable with technology. UI must be extremely simple. Phone number + PIN login (no email/password).

4. **Security:** Never expose PayPal credentials or database URL in frontend code. All API calls go through Netlify functions. PINs must be bcrypt hashed.

5. **No single point of failure:** System must work even if the developer leaves. Credentials stored in Netlify env vars, documented for board.

6. **Ethiopian colors:** Green (#078930), Gold (#FCDD09), Red (#DA121A) — these are the Ethiopian flag colors and should be used throughout.

7. **PayPal naming:** Members are matched to invoices by their PayPal name (stored in paypal_name field in members table). This matching is critical.

8. **Existing Wix features to replicate:**
   - Pay invoice page
   - Upload receipt page
   - Waiting list form
   - Waiting list status check
   - About / By-Laws page
   - Contact form
   - Members-only portal
   - Admin panel
   - Collect funeral info (board)

9. **Do NOT use:** Google Sheets, Wix, PythonAnywhere, N8N (all being replaced)

10. **The (424) 547-5594 number** is a regular cell phone currently. Plan is to port it to Twilio. Until then, SMS automation is not yet active.

---

## 17. FILES ALREADY BUILT

All frontend HTML files are complete and deployed:
- `public/index.html` — public website
- `public/portal/index.html` — member portal
- `public/admin/index.html` — board CRM

These files contain embedded demo data (member list, invoice list as JSON). The task now is to:
1. Extract that data and seed it into the Render PostgreSQL database
2. Replace the embedded JSON with API calls to Netlify functions
3. Add real authentication

---

## 18. CONTACT & CREDENTIALS (DO NOT COMMIT TO GIT)

Store all of these in Netlify Environment Variables only:
- PayPal Client ID and Secret
- Render PostgreSQL connection string
- JWT secret
- Twilio credentials (when set up)
- SendGrid API key (when set up)

The developer will add these directly in the Netlify dashboard.

---

*This document was prepared as a full handoff from Claude (claude.ai) to Cursor for continued development of the Hibret Edir web platform. Last updated: June 2026.*
