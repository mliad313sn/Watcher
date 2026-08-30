/**
 * SSO — OpenID Connect (authorization-code flow) + group→role mapping.
 *
 * Works with any spec-compliant IdP (Keycloak, Authentik, Okta, Entra ID,
 * Google). Deliberately dependency-free: the ID token is not verified
 * locally against JWKS — instead the access token is presented to the IdP's
 * own userinfo endpoint over TLS, which is authoritative validation. Watcher
 * then issues its own session JWT, so the rest of the stack is unchanged.
 *
 * Users are provisioned just-in-time on first login (auth_source='oidc') with
 * the role derived from the IdP's group claim via SSO_ROLE_MAP.
 */
import crypto from 'node:crypto';

/**
 * Parse "group=role,group2=role2,*=viewer" into a matcher.
 * '*' is the default for authenticated users with no mapped group; when
 * absent, unmapped users are refused (deny-by-default).
 * @returns {(groups: string[]) => string|null}
 */
export function parseRoleMap(spec) {
  const entries = [];
  let fallback = null;
  for (const pair of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i === -1) continue;
    const group = pair.slice(0, i).trim();
    const role = pair.slice(i + 1).trim();
    if (!['admin', 'operator', 'viewer'].includes(role)) continue;
    if (group === '*') fallback = role;
    else entries.push([group, role]);
  }
  const WEIGHT = { admin: 3, operator: 2, viewer: 1 };
  return (groups) => {
    let best = null;
    for (const [group, role] of entries) {
      if (groups.includes(group) && (!best || WEIGHT[role] > WEIGHT[best])) best = role;
    }
    return best ?? fallback;
  };
}

/** Normalise the group claim: array, JSON string, or comma/space separated. */
export function extractGroups(claims, claimName) {
  const raw = claims?.[claimName];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p.map(String); } catch { /* not json */ }
    return raw.split(/[,\s]+/).filter(Boolean);
  }
  return [];
}

export class OidcClient {
  #cfg; #discovery = null; #discoveredAt = 0;

  constructor(cfg, { fetchImpl = fetch } = {}) {
    this.#cfg = cfg;
    this.fetch = fetchImpl;
    this.roleFor = parseRoleMap(cfg.roleMap);
  }

  get enabled() { return Boolean(this.#cfg.issuer && this.#cfg.clientId); }

  async #discover() {
    if (this.#discovery && Date.now() - this.#discoveredAt < 3600_000) return this.#discovery;
    const url = this.#cfg.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
    const res = await this.fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    this.#discovery = await res.json();
    this.#discoveredAt = Date.now();
    return this.#discovery;
  }

  /** Build the IdP authorization URL for a fresh state value. */
  async authUrl(state, redirectUri) {
    const d = await this.#discover();
    const p = new URLSearchParams({
      response_type: 'code',
      client_id: this.#cfg.clientId,
      redirect_uri: redirectUri,
      scope: this.#cfg.scope,
      state,
    });
    return `${d.authorization_endpoint}?${p}`;
  }

  /** Exchange the code, then fetch userinfo — the IdP validates the token. */
  async exchange(code, redirectUri) {
    const d = await this.#discover();
    const res = await this.fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.#cfg.clientId,
        client_secret: this.#cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
    const tokens = await res.json();
    if (!tokens.access_token) throw new Error('token exchange returned no access_token');

    const ui = await this.fetch(d.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!ui.ok) throw new Error(`userinfo failed: HTTP ${ui.status}`);
    return ui.json();
  }

  /** Map userinfo claims to a Watcher identity, or null when unauthorised. */
  identityFor(claims) {
    const username = claims.preferred_username || claims.email || claims.sub;
    if (!username) return null;
    const groups = extractGroups(claims, this.#cfg.groupClaim);
    const role = this.roleFor(groups);
    if (!role) return null; // no mapped group and no '*' fallback → deny
    return {
      username: String(username).toLowerCase(),
      displayName: claims.name || String(username),
      email: claims.email ?? null,
      role,
      groups,
    };
  }

  newState() { return crypto.randomBytes(24).toString('base64url'); }
}
