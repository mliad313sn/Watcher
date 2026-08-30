-- 009: SSO identity provenance.
-- Users provisioned just-in-time from an IdP (OIDC) or directory (LDAP) carry
-- their source; their password_hash is an unusable sentinel — the IdP is the
-- only password oracle for them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source text NOT NULL DEFAULT 'local';
