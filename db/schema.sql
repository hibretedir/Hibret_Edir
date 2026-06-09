-- Hibret Edir PostgreSQL schema
-- Run this in your Render Postgres database to create the initial tables.

CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  member_number INTEGER UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  full_name VARCHAR(220),
  paypal_name VARCHAR(220),
  email VARCHAR(200),
  mobile VARCHAR(32),
  home_phone VARCHAR(32),
  address TEXT,
  pin_hash VARCHAR(200),
  notes TEXT,
  joined_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_mobile ON members(mobile);
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);

CREATE TABLE IF NOT EXISTS beneficiaries (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(32),
  relationship VARCHAR(100),
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  event_number INTEGER UNIQUE NOT NULL,
  deceased_name VARCHAR(200) NOT NULL,
  deceased_relationship VARCHAR(100),
  member_id INTEGER REFERENCES members(id),
  event_date DATE,
  announcement_sent_at TIMESTAMP WITH TIME ZONE,
  amount_per_member DECIMAL(10,2) NOT NULL DEFAULT 110.00,
  payout_amount DECIMAL(12,2) NOT NULL DEFAULT 15000.00,
  payout_sent BOOLEAN NOT NULL DEFAULT FALSE,
  payout_sent_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  paypal_invoice_id VARCHAR(100) UNIQUE,
  invoice_number INTEGER,
  member_id INTEGER REFERENCES members(id),
  event_id INTEGER REFERENCES events(id),
  status VARCHAR(50),
  amount DECIMAL(10,2),
  amount_due DECIMAL(10,2),
  sent_date DATE,
  paid_date DATE,
  payment_method VARCHAR(50),
  paypal_link TEXT,
  recipient_name VARCHAR(220),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_member_id ON invoices(member_id);
CREATE INDEX IF NOT EXISTS idx_invoices_event_id ON invoices(event_id);

CREATE TABLE IF NOT EXISTS receipts (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  invoice_id INTEGER REFERENCES invoices(id),
  event_id INTEGER REFERENCES events(id),
  payment_method VARCHAR(50),
  amount DECIMAL(10,2),
  file_url TEXT,
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  reviewed_by INTEGER,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS board_members (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  role VARCHAR(50),
  email VARCHAR(200) UNIQUE,
  password_hash VARCHAR(200),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  board_member_id INTEGER REFERENCES board_members(id),
  member_id INTEGER REFERENCES members(id),
  actor_type VARCHAR(20) NOT NULL DEFAULT 'system',
  actor_label VARCHAR(220),
  action VARCHAR(100) NOT NULL,
  table_name VARCHAR(100),
  entity_type VARCHAR(50),
  record_id INTEGER,
  old_value JSONB,
  new_value JSONB,
  summary TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_member_id ON audit_log(member_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, record_id);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  event_id INTEGER REFERENCES events(id),
  type VARCHAR(50),
  message TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS waiting_list (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  full_name VARCHAR(220),
  email VARCHAR(200),
  phone VARCHAR(32),
  address TEXT,
  spouse_name VARCHAR(200),
  family_members TEXT,
  referred_by VARCHAR(200),
  applicant_role VARCHAR(20) NOT NULL DEFAULT 'primary',
  primary_member_name VARCHAR(200),
  preferred_payment_method VARCHAR(50),
  status VARCHAR(50) NOT NULL DEFAULT 'Pending',
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  approved_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  CONSTRAINT waiting_list_applicant_role_check
    CHECK (applicant_role IN ('primary', 'spouse')),
  CONSTRAINT waiting_list_no_transfer
    CHECK (applicant_role = 'primary' OR primary_member_name IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_waiting_list_email ON waiting_list(email);
CREATE INDEX IF NOT EXISTS idx_waiting_list_phone ON waiting_list(phone);
CREATE INDEX IF NOT EXISTS idx_waiting_list_status ON waiting_list(status);

-- Full membership application (Step 2 — after board approval; links to waiting list slot)
CREATE TABLE IF NOT EXISTS membership_applications (
  id SERIAL PRIMARY KEY,
  waiting_list_id INTEGER NOT NULL UNIQUE REFERENCES waiting_list(id),
  application_date DATE NOT NULL DEFAULT CURRENT_DATE,
  member_full_name VARCHAR(220) NOT NULL,
  spouse_full_name VARCHAR(220),
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(10) DEFAULT 'CA',
  zip VARCHAR(20),
  home_phone VARCHAR(32),
  office_phone VARCHAR(32),
  cell_phone VARCHAR(32),
  email VARCHAR(200),
  children JSONB DEFAULT '[]',
  beneficiary_member JSONB,
  beneficiary_spouse JSONB,
  emergency_contacts JSONB DEFAULT '[]',
  additional_family JSONB DEFAULT '[]',
  id_documents JSONB DEFAULT '{}',
  applicant_role VARCHAR(20) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'Submitted',
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  member_id INTEGER REFERENCES members(id),
  notes TEXT,
  review_checklist JSONB NOT NULL DEFAULT '{"name_match":false,"fields_complete":false,"id_uploaded":false,"fee_paid":false}',
  registration_fee_paid BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT membership_applications_role_check
    CHECK (applicant_role IN ('primary', 'spouse'))
);

-- Migration (run once if waiting_list already exists without new columns):
-- ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS spouse_name VARCHAR(200);
-- ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS family_members TEXT;
-- ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS referred_by VARCHAR(200);
-- ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS applicant_role VARCHAR(20) NOT NULL DEFAULT 'primary';
-- ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS primary_member_name VARCHAR(200);
-- ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE;
-- ALTER TABLE membership_applications ADD COLUMN IF NOT EXISTS id_documents JSONB DEFAULT '{}';
-- ALTER TABLE membership_applications ADD COLUMN IF NOT EXISTS review_checklist JSONB NOT NULL DEFAULT '{"name_match":false,"fields_complete":false,"id_uploaded":false,"fee_paid":false}';
-- ALTER TABLE membership_applications ADD COLUMN IF NOT EXISTS registration_fee_paid BOOLEAN NOT NULL DEFAULT FALSE;
-- Audit log migration (existing databases):
-- ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS member_id INTEGER REFERENCES members(id);
-- ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR(20) NOT NULL DEFAULT 'system';
-- ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_label VARCHAR(220);
-- ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50);
-- ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS summary TEXT;
-- CREATE INDEX IF NOT EXISTS idx_audit_log_member_id ON audit_log(member_id);
-- CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
-- Payout workflow migration (existing databases):
-- CREATE TABLE IF NOT EXISTS event_payouts (...);  -- see full definition above

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  invoice_id INTEGER REFERENCES invoices(id),
  event_id INTEGER REFERENCES events(id),
  payment_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  amount DECIMAL(10,2),
  method VARCHAR(50),
  reference TEXT,
  notes TEXT
);

-- $15,000 payout workflow — document collection, board approval, disbursement
CREATE TABLE IF NOT EXISTS event_payouts (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id),
  event_label VARCHAR(300),
  member_id INTEGER REFERENCES members(id),
  deceased_name VARCHAR(200) NOT NULL,
  deceased_relationship VARCHAR(100),
  beneficiary_name VARCHAR(200),
  beneficiary_phone VARCHAR(32),
  beneficiary_relationship VARCHAR(100),
  payout_amount DECIMAL(12,2) NOT NULL DEFAULT 15000.00,
  status VARCHAR(50) NOT NULL DEFAULT 'Documents Pending',
  documents JSONB NOT NULL DEFAULT '{}',
  review_checklist JSONB NOT NULL DEFAULT '{
    "deceased_ss": false,
    "deceased_id": false,
    "beneficiary_ss": false,
    "beneficiary_id": false,
    "death_certificate": false,
    "relationship_verified": false
  }',
  board_approvals JSONB NOT NULL DEFAULT '[]',
  payout_method VARCHAR(50),
  payout_reference TEXT,
  payout_sent_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT event_payouts_status_check
    CHECK (status IN ('Documents Pending', 'Under Review', 'Approved', 'Paid Out', 'On Hold'))
);

CREATE INDEX IF NOT EXISTS idx_event_payouts_status ON event_payouts(status);
CREATE INDEX IF NOT EXISTS idx_event_payouts_member_id ON event_payouts(member_id);
CREATE INDEX IF NOT EXISTS idx_event_payouts_event_id ON event_payouts(event_id);

-- Migration: store PayPal invoice recipient exactly as sent (may differ from CRM household full_name)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recipient_name VARCHAR(220);

-- Migration: remove duplicate rows per invoice_number (keep row with recipient_name, else newest)
DELETE FROM invoices
WHERE invoice_number IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON (invoice_number) id
    FROM invoices
    WHERE invoice_number IS NOT NULL
    ORDER BY invoice_number,
      (CASE WHEN recipient_name IS NOT NULL AND TRIM(recipient_name) <> '' THEN 0 ELSE 1 END),
      updated_at DESC NULLS LAST,
      id DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_number_unique ON invoices(invoice_number) WHERE invoice_number IS NOT NULL;

-- Member change requests (beneficiary updates, etc.) — board approval required
CREATE TABLE IF NOT EXISTS member_change_requests (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  request_type VARCHAR(50) NOT NULL DEFAULT 'beneficiary',
  payload JSONB NOT NULL,
  previous_payload JSONB,
  status VARCHAR(50) NOT NULL DEFAULT 'Pending',
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  reviewed_by VARCHAR(220),
  notes TEXT,
  CONSTRAINT member_change_requests_status_check
    CHECK (status IN ('Pending', 'Under Review', 'Approved', 'Rejected'))
);

CREATE INDEX IF NOT EXISTS idx_member_change_requests_member ON member_change_requests(member_id);
CREATE INDEX IF NOT EXISTS idx_member_change_requests_status ON member_change_requests(status);

-- Migration (existing databases):
-- CREATE TABLE IF NOT EXISTS member_change_requests (...);  -- see full definition above
