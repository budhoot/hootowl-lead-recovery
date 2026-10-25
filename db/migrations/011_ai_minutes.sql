-- AI receptionist minutes are metered per customer and limited by plan, with an operator override.
ALTER TABLE usage_ledger DROP CONSTRAINT IF EXISTS usage_ledger_kind_check;
ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_kind_check CHECK (kind IN ('call','sms_out','sms_in','auth_sms','ai_voice'));

-- ai_unlimited: never limited (for example HootOwl's own businesses). ai_minutes_override: monthly minutes instead of the plan's.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_unlimited BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_minutes_override INTEGER CHECK (ai_minutes_override IS NULL OR ai_minutes_override >= 0);

CREATE INDEX IF NOT EXISTS usage_ledger_ai_idx ON usage_ledger (client_id, occurred_at) WHERE kind = 'ai_voice';

-- Nocona Hills is HootOwl's original, non-subscription customer; keep its assistant answering.
UPDATE clients SET ai_unlimited = TRUE
WHERE id = (SELECT id FROM clients WHERE name ILIKE 'Nocona Hills Repair%' ORDER BY id LIMIT 1);
