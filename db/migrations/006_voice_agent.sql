CREATE TABLE IF NOT EXISTS voice_agent_sessions (
  call_sid TEXT PRIMARY KEY,
  client_phone_number_id BIGINT NOT NULL REFERENCES client_phone_numbers(id),
  caller_number TEXT NOT NULL CHECK (caller_number ~ '^\+[1-9][0-9]{1,14}$'),
  call_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'failed')),
  customer_name TEXT NOT NULL DEFAULT '',
  service_type TEXT NOT NULL DEFAULT '',
  service_address TEXT NOT NULL DEFAULT '',
  issue_description TEXT NOT NULL DEFAULT '',
  risk_flag BOOLEAN NOT NULL DEFAULT FALSE,
  offered_slots JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_slot_index SMALLINT CHECK (pending_slot_index IS NULL OR pending_slot_index BETWEEN 1 AND 3),
  google_event_id TEXT,
  booked_start TIMESTAMPTZ,
  booked_end TIMESTAMPTZ,
  recording_sid TEXT,
  recording_url TEXT,
  recording_status TEXT
    CHECK (recording_status IS NULL OR recording_status IN ('in-progress', 'completed', 'absent')),
  recording_duration INTEGER CHECK (recording_duration IS NULL OR recording_duration >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE voice_agent_sessions
  ADD COLUMN IF NOT EXISTS pending_slot_index SMALLINT
  CHECK (pending_slot_index IS NULL OR pending_slot_index BETWEEN 1 AND 3);

CREATE INDEX IF NOT EXISTS voice_agent_sessions_client_created_idx
  ON voice_agent_sessions (client_phone_number_id, created_at DESC);
