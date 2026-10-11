ALTER TABLE client_phone_numbers
  ADD COLUMN IF NOT EXISTS intake_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE client_phone_numbers ALTER COLUMN destination_number DROP NOT NULL;
ALTER TABLE client_phone_numbers
  ADD CONSTRAINT client_phone_numbers_destination_required_for_forwarding
  CHECK (intake_enabled OR destination_number IS NOT NULL);
ALTER TABLE inbound_messages ADD COLUMN IF NOT EXISTS reply_body TEXT;

CREATE TABLE IF NOT EXISTS intake_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_sid TEXT NOT NULL UNIQUE,
  client_phone_number_id BIGINT NOT NULL REFERENCES client_phone_numbers(id),
  caller_number TEXT NOT NULL CHECK (caller_number ~ '^\+[1-9][0-9]{1,14}$'),
  call_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consent_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN (
    'awaiting_consent', 'awaiting_name', 'awaiting_service', 'awaiting_address',
    'awaiting_issue', 'awaiting_slot', 'confirmed', 'outside_area',
    'callback_requested', 'awaiting_voicemail', 'voicemail_recorded',
    'opted_out', 'needs_review'
  )),
  initial_sms_state TEXT NOT NULL DEFAULT 'not_sent'
    CHECK (initial_sms_state IN ('not_sent','sending','sent','review')),
  initial_message_sid TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  service_type TEXT NOT NULL DEFAULT '',
  service_address TEXT NOT NULL DEFAULT '',
  issue_description TEXT NOT NULL DEFAULT '',
  risk_flag BOOLEAN NOT NULL DEFAULT FALSE,
  offered_slots JSONB NOT NULL DEFAULT '[]'::jsonb,
  google_event_id TEXT,
  recording_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS intake_sessions_caller_active_idx
  ON intake_sessions (client_phone_number_id, caller_number, updated_at DESC)
  WHERE state IN (
    'awaiting_consent', 'awaiting_name', 'awaiting_service', 'awaiting_address',
    'awaiting_issue', 'awaiting_slot', 'needs_review'
  );
