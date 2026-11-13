-- AFBiz Autopilot schema (isolated local PostgreSQL; never point at production).
-- Idempotent: safe to re-run via scripts/db-setup.ts.

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_phone TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_owner_norm_uq ON customers (owner_phone, normalized_name);

CREATE TABLE IF NOT EXISTS sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_phone TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  customer_id UUID REFERENCES customers (id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_owner_time_idx ON sales (owner_phone, recorded_at);

CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_phone TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_owner_time_idx ON expenses (owner_phone, recorded_at);

CREATE TABLE IF NOT EXISTS debts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_phone TEXT NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers (id),
  description TEXT NOT NULL,
  amount_due NUMERIC(14, 2) NOT NULL CHECK (amount_due > 0),
  amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS debts_owner_idx ON debts (owner_phone, customer_id);

-- Duplicate-message protection: one receipt per Meta message id (Test F).
CREATE TABLE IF NOT EXISTS webhook_receipts (
  wa_message_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  preview TEXT,
  status TEXT NOT NULL DEFAULT 'claimed',
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Confirmation flow: at most one pending action per sender (new one supersedes).
CREATE TABLE IF NOT EXISTS pending_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_phone TEXT NOT NULL,
  tool TEXT NOT NULL,
  payload JSONB NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pending_owner_status_idx ON pending_actions (owner_phone, status);

-- Local event ledger (Phase 3): every operational event lands here FIRST, so
-- diagnosis works even when the PostHog service is unreachable. The payload
-- column is local-only (e.g. raw amount text for parse failures); it never
-- leaves the machine.
CREATE TABLE IF NOT EXISTS event_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id TEXT NOT NULL,
  event TEXT NOT NULL,
  tool TEXT,
  agent_version TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  failure_category TEXT,
  duration_ms INTEGER,
  improvement_version TEXT,
  error_class TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_ledger_created_idx ON event_ledger (created_at);
CREATE INDEX IF NOT EXISTS event_ledger_category_idx ON event_ledger (failure_category);
