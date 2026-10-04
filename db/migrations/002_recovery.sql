ALTER TABLE clients ADD COLUMN IF NOT EXISTS booking_url TEXT;
ALTER TABLE client_phone_numbers ADD COLUMN IF NOT EXISTS recovery_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS recovery_messages (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 call_sid TEXT NOT NULL UNIQUE REFERENCES missed_calls(call_sid),
 client_phone_number_id BIGINT NOT NULL REFERENCES client_phone_numbers(id),
 recipient TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','suppressed','review')),
 message_sid TEXT UNIQUE,
 delivery_status TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sms_opt_outs (
 client_phone_number_id BIGINT NOT NULL REFERENCES client_phone_numbers(id),
 caller_number TEXT NOT NULL,
 PRIMARY KEY(client_phone_number_id, caller_number)
);
CREATE TABLE IF NOT EXISTS inbound_messages (
 message_sid TEXT PRIMARY KEY,
 client_phone_number_id BIGINT NOT NULL REFERENCES client_phone_numbers(id),
 caller_number TEXT NOT NULL,
 body TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
