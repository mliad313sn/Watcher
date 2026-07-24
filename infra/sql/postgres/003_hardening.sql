-- Watcher config-plane hardening migration (issues #5, #7, low-ops).

-- ── Forced password change for the seeded admin (issue #7) ──────────────────
-- New column defaults to false so API-created users aren't forced unless an
-- admin wants it; the shipped default admin/admin IS forced to rotate.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_change_required boolean NOT NULL DEFAULT false;

UPDATE users SET password_change_required = true
WHERE username = 'admin'
  AND tenant_id = '00000000-0000-0000-0000-000000000001';

-- ── Notification delivery log (issue #5) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_log (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id    uuid REFERENCES alerts(id) ON DELETE CASCADE,
    rule_id     uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
    channel     text NOT NULL,                 -- webhook | slack | email | log
    target      text NOT NULL DEFAULT '',      -- url / address dispatched to
    status      text NOT NULL,                 -- sent | failed | skipped
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_log_alert_idx ON notification_log (alert_id);
CREATE INDEX IF NOT EXISTS notification_log_time_idx  ON notification_log (created_at DESC);

-- ── Alert history retention support (low-ops) ───────────────────────────────
-- Postgres has no built-in TTL; index resolved_at so a periodic archival job
-- (cron / pg_cron) can prune old resolved alerts efficiently, e.g.:
--   DELETE FROM alerts WHERE status = 'resolved' AND resolved_at < now() - INTERVAL '180 days';
CREATE INDEX IF NOT EXISTS alerts_resolved_at_idx
    ON alerts (resolved_at) WHERE status = 'resolved';
