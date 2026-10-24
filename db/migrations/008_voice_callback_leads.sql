ALTER TABLE voice_agent_sessions
  ADD COLUMN IF NOT EXISTS address_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS callback_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS voice_agent_sessions_callback_idx
  ON voice_agent_sessions (created_at DESC) WHERE callback_requested;
