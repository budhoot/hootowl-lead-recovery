-- Records each attempt to email a workspace invitation to a buyer. Additive and safe to run twice.
CREATE TABLE IF NOT EXISTS invitation_emails (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 client_id BIGINT NOT NULL REFERENCES clients(id),
 email TEXT NOT NULL,
 order_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('sent','failed')),
 detail TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invitation_emails_client_idx ON invitation_emails(client_id, created_at DESC);
