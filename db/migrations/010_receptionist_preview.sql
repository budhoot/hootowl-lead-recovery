-- Preview calls let a customer hear its own AI receptionist on its own phone. They are kept apart from real calls.
ALTER TABLE voice_agent_sessions ADD COLUMN IF NOT EXISTS is_preview BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS voice_agent_sessions_preview_idx
  ON voice_agent_sessions (client_phone_number_id, created_at DESC) WHERE is_preview;
