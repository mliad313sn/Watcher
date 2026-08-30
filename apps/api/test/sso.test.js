import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoleMap, extractGroups, OidcClient } from '../src/modules/auth/sso.js';

test('parseRoleMap maps groups to roles, highest role wins', () => {
  const roleFor = parseRoleMap('noc=operator,watcher-admins=admin,*=viewer');
  assert.equal(roleFor(['watcher-admins', 'noc']), 'admin');
  assert.equal(roleFor(['noc']), 'operator');
  assert.equal(roleFor(['unrelated']), 'viewer'); // '*' fallback
});

test('parseRoleMap denies by default without a * fallback', () => {
  const roleFor = parseRoleMap('noc=operator');
  assert.equal(roleFor(['random-team']), null);
  assert.equal(roleFor([]), null);
});

test('parseRoleMap ignores malformed pairs and invalid roles', () => {
  const roleFor = parseRoleMap('noc=operator,bogus,x=superuser,*=viewer');
  assert.equal(roleFor(['x']), 'viewer'); // 'superuser' dropped, falls back
  assert.equal(roleFor(['noc']), 'operator');
});

test('extractGroups handles array, JSON string, and separated formats', () => {
  assert.deepEqual(extractGroups({ groups: ['a', 'b'] }, 'groups'), ['a', 'b']);
  assert.deepEqual(extractGroups({ groups: '["a","b"]' }, 'groups'), ['a', 'b']);
  assert.deepEqual(extractGroups({ groups: 'a, b c' }, 'groups'), ['a', 'b', 'c']);
  assert.deepEqual(extractGroups({}, 'groups'), []);
  assert.deepEqual(extractGroups({ groups: 42 }, 'groups'), []);
});

test('OidcClient full flow against a mock IdP (discovery→auth URL→exchange→identity)', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(String(url));
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return ok({
        authorization_endpoint: 'https://idp.example/auth',
        token_endpoint: 'https://idp.example/token',
        userinfo_endpoint: 'https://idp.example/userinfo',
      });
    }
    if (String(url) === 'https://idp.example/token') {
      const params = new URLSearchParams(opts.body);
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('code'), 'the-code');
      assert.equal(params.get('client_secret'), 's3cret');
      return ok({ access_token: 'at-123' });
    }
    if (String(url) === 'https://idp.example/userinfo') {
      assert.equal(opts.headers.Authorization, 'Bearer at-123');
      return ok({ preferred_username: 'Dana.NOC', name: 'Dana', email: 'dana@example.org',
                  groups: ['noc', 'staff'] });
    }
    throw new Error('unexpected fetch ' + url);
  };

  const client = new OidcClient({
    issuer: 'https://idp.example', clientId: 'watcher', clientSecret: 's3cret',
    scope: 'openid profile email', groupClaim: 'groups', roleMap: 'noc=operator',
  }, { fetchImpl });

  assert.ok(client.enabled);
  const url = await client.authUrl('st4te', 'https://watcher.example/api/auth/sso/callback');
  assert.match(url, /^https:\/\/idp\.example\/auth\?/);
  assert.match(url, /state=st4te/);
  assert.match(url, /client_id=watcher/);

  const claims = await client.exchange('the-code', 'https://watcher.example/api/auth/sso/callback');
  const identity = client.identityFor(claims);
  assert.equal(identity.username, 'dana.noc'); // lowered
  assert.equal(identity.role, 'operator');     // from 'noc' group

  // Unmapped user with no fallback is refused.
  assert.equal(client.identityFor({ preferred_username: 'x', groups: ['sales'] }), null);
});
