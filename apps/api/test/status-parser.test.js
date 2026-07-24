import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatusDat, normalizeObject } from '../src/modules/nagios/status-parser.js';

const SAMPLE = `########################################
#          NAGIOS STATUS FILE
########################################

info {
	created=1721800000
	version=4.5.0
	}

programstatus {
	nagios_pid=42
	daemon_mode=1
	}

hoststatus {
	host_name=core-sw-01
	current_state=0
	state_type=1
	plugin_output=PING OK - Packet loss = 0%, RTA = 0.42 ms
	performance_data=rta=0.42ms;3000;5000 pl=0%;80;100
	last_check=1721800100
	last_state_change=1721000000
	is_flapping=0
	problem_has_been_acknowledged=0
	scheduled_downtime_depth=0
	current_attempt=1
	max_attempts=3
	}

servicestatus {
	host_name=app-srv-01
	service_description=HTTP
	current_state=2
	state_type=1
	plugin_output=CRITICAL - Socket timeout after 10 seconds
	last_check=1721800110
	last_state_change=1721799000
	is_flapping=0
	problem_has_been_acknowledged=1
	scheduled_downtime_depth=0
	current_attempt=3
	max_attempts=3
	}
`;

test('parses hosts, services and program blocks', () => {
  const { hosts, services, program } = parseStatusDat(SAMPLE);
  assert.equal(hosts.length, 1);
  assert.equal(services.length, 1);
  assert.equal(program.nagios_pid, '42'); // untyped fields stay strings
});

test('extracts typed fields and values containing separators', () => {
  const { hosts } = parseStatusDat(SAMPLE);
  const host = hosts[0];
  assert.equal(host.host_name, 'core-sw-01');
  assert.equal(host.current_state, 0);
  assert.equal(host.state_type, 1);
  // value contains '=' and must survive first-'=' splitting
  assert.match(host.performance_data, /rta=0\.42ms/);
});

test('normalizeObject maps host block into stream shape', () => {
  const { hosts } = parseStatusDat(SAMPLE);
  const obj = normalizeObject(hosts[0], true);
  assert.deepEqual(
    { kind: obj.kind, host: obj.host, state: obj.state, hard: obj.hard, acknowledged: obj.acknowledged },
    { kind: 'host', host: 'core-sw-01', state: 0, hard: true, acknowledged: false },
  );
});

test('normalizeObject maps service block with ack flag', () => {
  const { services } = parseStatusDat(SAMPLE);
  const obj = normalizeObject(services[0], false);
  assert.equal(obj.kind, 'service');
  assert.equal(obj.service, 'HTTP');
  assert.equal(obj.state, 2);
  assert.equal(obj.acknowledged, true);
});
