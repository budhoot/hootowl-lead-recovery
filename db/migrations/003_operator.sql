ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS follow_up_status TEXT NOT NULL DEFAULT 'new'
 CHECK (follow_up_status IN ('new','in_progress','resolved'));
ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS operator_notes TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS operator_sessions (
 token_hash TEXT PRIMARY KEY,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_heartbeat (
 id INTEGER PRIMARY KEY CHECK (id=1),
 last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 sending_enabled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS website_leads (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 submission_id TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 email TEXT,
 phone TEXT,
 message TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL DEFAULT 'wix',
 status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','resolved')),
 operator_notes TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS recovery_pending_idx ON recovery_messages(id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS recovery_cooldown_idx ON recovery_messages(client_phone_number_id,recipient,created_at);
