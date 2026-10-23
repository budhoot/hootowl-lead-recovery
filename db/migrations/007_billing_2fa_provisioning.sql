CREATE TABLE IF NOT EXISTS billing_subscriptions (
 client_id BIGINT PRIMARY KEY REFERENCES clients(id),
 wix_plan_id TEXT NOT NULL,
 wix_subscription_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('active','past_due','cancelled','refunded')),
 buyer_email TEXT,
 current_period_end TIMESTAMPTZ,
 last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS billing_subscriptions_status_idx ON billing_subscriptions(status);
CREATE UNIQUE INDEX IF NOT EXISTS billing_subscriptions_wix_sub_idx ON billing_subscriptions(wix_subscription_id) WHERE wix_subscription_id IS NOT NULL;

-- Idempotency and audit log for every billing event received; unmatched events stay visible for operator reconciliation.
CREATE TABLE IF NOT EXISTS billing_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source TEXT NOT NULL,
 event_id TEXT NOT NULL,
 event_type TEXT NOT NULL,
 client_id BIGINT REFERENCES clients(id),
 outcome TEXT NOT NULL CHECK(outcome IN ('applied','unmatched','ignored')),
 payload JSONB NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(source, event_id)
);
CREATE INDEX IF NOT EXISTS billing_events_unmatched_idx ON billing_events(received_at) WHERE outcome = 'unmatched';

-- Provider usage keyed by Twilio SID so a replayed callback can never be billed twice.
CREATE TABLE IF NOT EXISTS usage_ledger (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 client_id BIGINT NOT NULL REFERENCES clients(id),
 kind TEXT NOT NULL CHECK(kind IN ('call','sms_out','sms_in','auth_sms')),
 provider_sid TEXT NOT NULL UNIQUE,
 quantity NUMERIC NOT NULL CHECK(quantity >= 0),
 billable BOOLEAN NOT NULL DEFAULT TRUE,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS usage_ledger_client_idx ON usage_ledger(client_id, occurred_at);

CREATE TABLE IF NOT EXISTS customer_totp (
 user_id BIGINT PRIMARY KEY REFERENCES customer_users(id) ON DELETE CASCADE,
 secret_enc TEXT NOT NULL,
 confirmed_at TIMESTAMPTZ,
 last_step BIGINT
);
ALTER TABLE customer_users ADD COLUMN IF NOT EXISTS sms_2fa_phone TEXT;
ALTER TABLE customer_users ADD COLUMN IF NOT EXISTS sms_2fa_verified_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS customer_recovery_codes (
 user_id BIGINT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
 code_hash TEXT NOT NULL,
 used_at TIMESTAMPTZ,
 PRIMARY KEY(user_id, code_hash)
);
-- Short-lived second-factor challenge issued after a correct password.
CREATE TABLE IF NOT EXISTS customer_2fa_challenges (
 token_hash TEXT PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
 sms_code_hash TEXT,
 attempts INT NOT NULL DEFAULT 0,
 expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS twilio_provisioning (
 client_id BIGINT PRIMARY KEY REFERENCES clients(id),
 consent_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','failed')),
 subaccount_sid TEXT UNIQUE,
 credential_ref TEXT,
 last_error TEXT,
 attempts INT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
