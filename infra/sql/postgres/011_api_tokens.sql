-- 011: scoped API tokens for automation (CI, scripts, integrations).
-- Only a SHA-256 of the secret is stored — the plaintext is shown once at
-- creation and never recoverable. Role caps what the token may do, exactly
-- like a user session; tokens can never out-rank their creator.
CREATE TABLE IF NOT EXISTS api_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name         text NOT NULL,
    token_hash   text NOT NULL UNIQUE,     -- sha256 hex of the secret
    role         user_role NOT NULL DEFAULT 'viewer',
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    expires_at   timestamptz               -- NULL = does not expire
);

CREATE INDEX IF NOT EXISTS api_tokens_tenant_idx ON api_tokens (tenant_id);
