-- 008: alert assignment.
-- An operator claims an incident so the room knows who owns it — the single
-- highest-leverage coordination primitive in a NOC ("I've got db-cluster-01").
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

CREATE INDEX IF NOT EXISTS alerts_assignee_idx ON alerts (assignee_user_id)
  WHERE assignee_user_id IS NOT NULL;
