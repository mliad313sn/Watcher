/**
 * LDAP / Active Directory authentication.
 *
 * Two-phase: bind as the service account (or anonymously), search for the
 * user's DN, then bind AS THE USER with the supplied password — the directory
 * itself is the password oracle, Watcher never sees or stores hashes.
 * Group membership (memberOf) feeds the same role map as OIDC.
 *
 * Enabled when SSO_LDAP_URL is set; local users still work (checked first).
 */
import { parseRoleMap } from './sso.js';

export class LdapAuth {
  #cfg;

  constructor(cfg) {
    this.#cfg = cfg;
    this.roleFor = parseRoleMap(cfg.roleMap);
  }

  get enabled() { return Boolean(this.#cfg.url); }

  /**
   * @returns {Promise<null | {username, displayName, email, role}>}
   *   null = bad credentials / user unknown; throws only on directory outage.
   */
  async authenticate(username, password) {
    if (!this.enabled || !password) return null;
    // Never let LDAP injection through the filter.
    const safe = String(username).replace(/[*()\\\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

    const { Client } = await import('ldapts'); // lazy: only when configured
    const client = new Client({ url: this.#cfg.url, timeout: 8000, connectTimeout: 8000 });
    try {
      if (this.#cfg.bindDn) await client.bind(this.#cfg.bindDn, this.#cfg.bindPassword);
      const filter = this.#cfg.userFilter.replace('{username}', safe);
      const { searchEntries } = await client.search(this.#cfg.searchBase, {
        scope: 'sub', filter, attributes: ['dn', 'cn', 'mail', 'memberOf', this.#cfg.usernameAttr],
      });
      const entry = searchEntries[0];
      if (!entry) return null;

      // The user bind IS the password check.
      try { await client.bind(entry.dn, password); }
      catch { return null; }

      const groups = (Array.isArray(entry.memberOf) ? entry.memberOf : entry.memberOf ? [entry.memberOf] : [])
        .map((dn) => String(dn).match(/^cn=([^,]+)/i)?.[1] ?? String(dn));
      const role = this.roleFor(groups);
      if (!role) return null;

      const uname = entry[this.#cfg.usernameAttr] ?? username;
      return {
        username: String(Array.isArray(uname) ? uname[0] : uname).toLowerCase(),
        displayName: String(Array.isArray(entry.cn) ? entry.cn[0] : entry.cn ?? username),
        email: entry.mail ? String(Array.isArray(entry.mail) ? entry.mail[0] : entry.mail) : null,
        role,
      };
    } finally {
      await client.unbind().catch(() => {});
    }
  }
}
