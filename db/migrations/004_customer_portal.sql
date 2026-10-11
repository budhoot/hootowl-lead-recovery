ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Chicago';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS customer_notes TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS customer_users (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 client_id BIGINT NOT NULL REFERENCES clients(id),
 email TEXT NOT NULL UNIQUE,
 display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 theme TEXT NOT NULL DEFAULT 'system' CHECK(theme IN ('system','light','dark')),
 accent TEXT NOT NULL DEFAULT 'forest' CHECK(accent IN ('forest','ocean','plum')),
 density TEXT NOT NULL DEFAULT 'comfortable' CHECK(density IN ('comfortable','compact')),
 time_format TEXT NOT NULL DEFAULT '12' CHECK(time_format IN ('12','24')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS customer_sessions (
 token_hash TEXT PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_sessions_user_idx ON customer_sessions(user_id);
CREATE TABLE IF NOT EXISTS customer_invites (
 token_hash TEXT PRIMARY KEY,
 client_id BIGINT NOT NULL REFERENCES clients(id),
 email TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 used_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
