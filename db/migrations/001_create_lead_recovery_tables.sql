CREATE TABLE IF NOT EXISTS clients (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_phone_numbers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES clients(id),
  twilio_number TEXT NOT NULL UNIQUE CHECK (twilio_number ~ '^\+[1-9][0-9]{1,14}$'),
  destination_number TEXT NOT NULL CHECK (destination_number ~ '^\+[1-9][0-9]{1,14}$'),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS missed_calls (
  call_sid TEXT PRIMARY KEY,
  client_phone_number_id BIGINT NOT NULL REFERENCES client_phone_numbers(id),
  caller_number TEXT NOT NULL CHECK (caller_number ~ '^\+[1-9][0-9]{1,14}$'),
  call_status TEXT NOT NULL CHECK (call_status IN ('no-answer', 'busy', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS missed_calls_phone_number_created_at_idx
  ON missed_calls (client_phone_number_id, created_at DESC);
