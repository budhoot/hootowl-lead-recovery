-- One row per daily Wix billing check (src/reconcile.js). Report only: nothing here changes a subscription.
CREATE TABLE IF NOT EXISTS billing_reconcile_runs (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 status TEXT NOT NULL CHECK(status IN ('ok','error')),
 error TEXT,
 wix_orders_seen INTEGER NOT NULL DEFAULT 0,
 truncated BOOLEAN NOT NULL DEFAULT FALSE,
 counts JSONB NOT NULL DEFAULT '{}'::jsonb,
 findings JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS billing_reconcile_runs_ran_at_idx ON billing_reconcile_runs(ran_at DESC);
