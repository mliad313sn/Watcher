/**
 * Parser for Nagios Core's status.dat.
 *
 * The file is a sequence of blocks:
 *
 *   hoststatus {
 *       host_name=core-sw-01
 *       current_state=0
 *       ...
 *   }
 *
 * We extract hoststatus / servicestatus / programstatus blocks and keep only
 * the fields the platform uses. Values are '='-delimited; a value may itself
 * contain '=' so we split on the first occurrence only.
 */

const INT_FIELDS = new Set([
  'current_state', 'state_type', 'last_check', 'last_state_change',
  'last_hard_state_change', 'is_flapping', 'problem_has_been_acknowledged',
  'scheduled_downtime_depth', 'current_attempt', 'max_attempts', 'check_type',
]);

function parseBlockBody(body) {
  const obj = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    obj[key] = INT_FIELDS.has(key) ? Number(value) : value;
  }
  return obj;
}

/**
 * @param {string} text raw contents of status.dat
 * @returns {{hosts: object[], services: object[], program: object|null}}
 */
export function parseStatusDat(text) {
  const hosts = [];
  const services = [];
  let program = null;

  // Closing brace is written indented ("\t}") by Nagios — allow leading space.
  const blockRe = /^(\w+)\s*\{([\s\S]*?)^\s*\}/gm;
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    const [, type, body] = match;
    if (type === 'hoststatus') hosts.push(parseBlockBody(body));
    else if (type === 'servicestatus') services.push(parseBlockBody(body));
    else if (type === 'programstatus') program = parseBlockBody(body);
  }
  return { hosts, services, program };
}

/** Normalize a parsed block into the shape Watcher caches and streams. */
export function normalizeObject(block, isHost) {
  return {
    kind: isHost ? 'host' : 'service',
    host: block.host_name,
    service: isHost ? '' : (block.service_description ?? ''),
    state: block.current_state ?? 0,
    hard: (block.state_type ?? 1) === 1,
    attempt: block.current_attempt ?? 1,
    maxAttempts: block.max_attempts ?? 1,
    output: block.plugin_output ?? '',
    perfData: block.performance_data ?? '',
    lastCheck: block.last_check ?? 0,
    lastStateChange: block.last_state_change ?? 0,
    flapping: (block.is_flapping ?? 0) === 1,
    acknowledged: (block.problem_has_been_acknowledged ?? 0) === 1,
    inDowntime: (block.scheduled_downtime_depth ?? 0) > 0,
  };
}
