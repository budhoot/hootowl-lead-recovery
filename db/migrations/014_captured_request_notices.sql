-- Marks the AI-captured requests whose contractor email has been claimed, so one call sends at most one email.
-- Additive and safe to run twice.
ALTER TABLE voice_agent_sessions ADD COLUMN IF NOT EXISTS owner_notified_at TIMESTAMPTZ;
