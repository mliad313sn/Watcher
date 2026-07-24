-- Development seed: default tenant + admin user.
-- Password is "admin" hashed with scrypt (N=16384,r=8,p=1) — format matches
-- apps/api/src/modules/auth/password.js: scrypt$<salt-hex>$<hash-hex>.
-- CHANGE THIS IN PRODUCTION.

INSERT INTO tenants (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'default')
ON CONFLICT DO NOTHING;

INSERT INTO users (tenant_id, username, display_name, role, password_hash)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'admin',
    'Administrator',
    'admin',
    'scrypt$9b808675fb98b417c6f87bf921abad31$fbd23831006fe260113f5d7c42edec933437aa3c0e17e92d996a7b8f84b039f5'
)
ON CONFLICT DO NOTHING;

INSERT INTO dashboards (tenant_id, name, shared, is_default)
VALUES ('00000000-0000-0000-0000-000000000001', 'Network Operations', true, true)
ON CONFLICT DO NOTHING;
