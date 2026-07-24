import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNextLink } from '../src/connectors/meraki.js';
import { expandCidr } from '@watcher/shared/discovery-engine';

test('meraki Link header pagination parsing', () => {
  const header = '<https://api.meraki.com/api/v1/organizations/1/devices?perPage=3&startingAfter=Q234>; rel=next, ' +
    '<https://api.meraki.com/api/v1/organizations/1/devices?perPage=3>; rel=first';
  assert.equal(
    parseNextLink(header),
    'https://api.meraki.com/api/v1/organizations/1/devices?perPage=3&startingAfter=Q234');
  assert.equal(parseNextLink('<https://x>; rel=prev'), null);
  assert.equal(parseNextLink(null), null);
});

test('expandCidr generates usable host addresses', () => {
  const hosts = expandCidr('192.168.1.0/30');
  assert.deepEqual(hosts, ['192.168.1.1', '192.168.1.2']);

  const wide = expandCidr('10.0.0.0/24');
  assert.equal(wide.length, 254);
  assert.equal(wide[0], '10.0.0.1');
  assert.equal(wide.at(-1), '10.0.0.254');
});

test('expandCidr rejects invalid input', () => {
  assert.throws(() => expandCidr('banana'));
  assert.throws(() => expandCidr('10.0.0.0/4'));
  assert.throws(() => expandCidr('999.0.0.0/24'));
});
