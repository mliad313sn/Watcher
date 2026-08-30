-- Acknowledgement-SLA escalation (the "must-have" on-call keystone).
-- A critical alert that no one acknowledges within a rule's window is
-- escalated to a second tier of actions, so an incident can never be silently
-- missed — the property that turns a dashboard into an on-call safety net.

-- Mark an alert once it has been escalated (idempotent guard for the sweep).
ALTER TABLE alerts
    ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- Per-rule escalation config: after N seconds unacknowledged, fire these.
ALTER TABLE alert_rules
    ADD COLUMN IF NOT EXISTS escalate_after_s integer;
ALTER TABLE alert_rules
    ADD COLUMN IF NOT EXISTS escalation_actions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Supports the notifier's periodic "who hasn't been acked?" sweep.
CREATE INDEX IF NOT EXISTS alerts_escalation_idx
    ON alerts (opened_at)
    WHERE status = 'open' AND escalated_at IS NULL AND severity = 'critical';
