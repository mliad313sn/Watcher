-- 012: config-as-code needs a natural key on alert rules so an imported
-- bundle upserts by name instead of duplicating. Existing duplicates (e.g.
-- from repeated demo seeding) are collapsed to one survivor first.
DELETE FROM alert_rules a
USING alert_rules b
WHERE a.tenant_id = b.tenant_id
  AND a.name = b.name
  AND a.ctid < b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_tenant_name_key
    ON alert_rules (tenant_id, name);
