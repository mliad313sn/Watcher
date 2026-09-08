/**
 * Device configuration: normalisation, versioning and drift.
 *
 * Config backup is the whole of SolarWinds NCM and the reason Oxidized and
 * RANCID exist. The idea is trivial — fetch the running config on a
 * schedule, keep it if it changed, tell someone when it did — and the
 * execution is not, for one reason:
 *
 *   **A device's configuration is not the same twice, even when nothing
 *   changed.**
 *
 * `ntp clock-period 17179856`. `! Last configuration change at 09:14:02 by
 * admin`. A certificate's validity window. A counter in a banner. Diff two
 * captures taken a minute apart and a naive tool reports a change every
 * single night — and a drift alert that fires every night is one nobody
 * reads, which means the night it fires for a real reason nobody reads it
 * either.
 *
 * So normalisation is not a tidying step here, it is the feature. Everything
 * else in this file is bookkeeping around it.
 *
 * Pure functions, no I/O: the capture worker owns the transport, this owns
 * the meaning, and the tests can cover every vendor's noise exhaustively.
 */
import crypto from 'node:crypto';

/**
 * Per-vendor capture and normalisation.
 *
 * `volatile` matches whole lines that change on their own; `command` is what
 * we ask the device for. Both are the accumulated result of somebody being
 * paged at 2am by a diff that meant nothing.
 */
export const VENDOR_PROFILES = Object.freeze({
  'cisco-ios': {
    label: 'Cisco IOS / IOS-XE',
    command: 'show running-config',
    volatile: [
      /^! Last configuration change at .*/,
      /^! NVRAM config last updated.*/,
      /^ntp clock-period \d+$/,
      /^! Time: .*/,
      /^Building configuration\.\.\.$/,
      /^Current configuration : \d+ bytes$/,
      /^\s*!\s*$/,
    ],
  },
  'cisco-nxos': {
    label: 'Cisco NX-OS',
    command: 'show running-config',
    volatile: [
      /^!Time: .*/,
      /^!Running configuration last done at: .*/,
      /^!Command: .*/,
    ],
  },
  'juniper': {
    label: 'Juniper JunOS',
    command: 'show configuration | display set | no-more',
    volatile: [
      /^## Last commit: .*/,
      /^# Last changed: .*/,
    ],
  },
  'arista': {
    label: 'Arista EOS',
    command: 'show running-config',
    volatile: [
      /^! Command: .*/,
      /^! device: .*/,
      /^! boot system .*/,
    ],
  },
  'aruba': {
    label: 'HP / Aruba',
    command: 'show running-config',
    volatile: [
      /^; .*Configuration Editor.*/,
      /^Running configuration:$/,
    ],
  },
  'mikrotik': {
    label: 'MikroTik RouterOS',
    command: '/export',
    volatile: [
      /^# .* by RouterOS .*/,
      /^# software id = .*/,
      /^# model = .*/,
      /^# serial number = .*/,
    ],
  },
  'fortinet': {
    label: 'FortiOS',
    command: 'show full-configuration',
    volatile: [
      /^#config-version=.*/,
      /^#conf_file_ver=.*/,
      /^#buildno=.*/,
      /^#global_vdom=.*/,
    ],
  },
  generic: {
    label: 'Generic',
    command: 'show running-config',
    volatile: [],
  },
});

/**
 * Secrets that a captured configuration carries, and how they are replaced.
 *
 * This is the reason RSK-50 says the config store becomes the highest-value
 * secret in the product: a running-config contains SNMP communities, RADIUS
 * and TACACS keys, pre-shared keys, and password hashes. A backup archive
 * of the whole estate's configs is a better prize than any single device.
 *
 * Replacing every secret with a flat `<redacted>` protects the value but
 * loses something real: a rotated community string then produces an
 * identical config, so the one change an auditor most wants to see becomes
 * invisible. Hashing the secret instead would make rotation visible and hand
 * an attacker an offline guessing target — "public" does not survive a
 * dictionary for long.
 *
 * So the placeholder carries a KEYED fingerprint when a key is configured:
 * `<redacted:3f9a1c22>`, an HMAC truncated to eight hex characters. Rotation
 * shows as a change, the value never lands in the database, and guessing the
 * secret from the fingerprint needs the key. With no key configured the
 * placeholder is the flat form and rotation is invisible — stated here
 * rather than discovered.
 */
const SECRET_PATTERNS = [
  /* The general case: a keyword, an optional encoding type, then the secret
     as the LAST token on the line. Anchoring the secret to end-of-line is
     what keeps prose out of it — "description link to password reset
     service" leaves two tokens after the keyword and therefore does not
     match, while "username admin password 7 09414F0B1A" does. Anchoring the
     KEYWORD to line-start instead (the obvious first attempt) misses every
     line where it is not the first word, which is most of them. */
  [/^(.*?\b(?:enable\s+)?(?:password|passwd|secret|key)\s+(?:\d+\s+)?)(\S+)\s*$/i, 2],
  // SNMP communities are followed by RO/RW, so they need their own anchor.
  [/^(\s*snmp-server\s+community\s+)(\S+)/i, 2],
  [/^(\s*snmp-server\s+host\s+\S+\s+(?:version\s+\S+\s+)?)(\S+)/i, 2],
  /* FortiOS and friends put an encoding marker between the keyword and the
     value: "set psksecret ENC <base64>". Without the optional marker the
     marker itself is redacted and the secret is stored. */
  [/^(\s*set\s+(?:\S*(?:passwd|password|secret|key))\s+(?:ENC\s+|encrypted\s+)?)(\S+)/i, 2],
  // MikroTik style: password="…"
  [/^(.*\bpasswo?rd=)("?)([^"\s]+)("?)/i, 3],
];

/**
 * Replace secret material with a placeholder.
 *
 * @param {string} text
 * @param {string} [fingerprintKey] HMAC key; without it the placeholder is
 *   flat and a secret rotation is not visible in the diff.
 */
export function redactSecrets(text, fingerprintKey = '') {
  const mark = (secret) => (fingerprintKey
    ? `<redacted:${crypto.createHmac('sha256', fingerprintKey)
      .update(String(secret)).digest('hex').slice(0, 8)}>`
    : '<redacted>');

  return String(text ?? '').split('\n').map((line) => {
    for (const [pattern, group] of SECRET_PATTERNS) {
      const m = pattern.exec(line);
      if (!m) continue;
      // `group` is which capture holds the secret; everything else on the
      // line is kept so the configuration still reads.
      const secret = m[group];
      return line.slice(0, m.index + m[0].length - secret.length - trailingOf(m, group))
        + mark(secret)
        + line.slice(m.index + m[0].length - trailingOf(m, group));
    }
    return line;
  }).join('\n');
}

/** Characters of the match that follow the secret (a closing quote). */
function trailingOf(match, group) {
  return group === 3 && match[4] ? match[4].length : 0;
}

/**
 * Normalise a captured configuration so that "changed" means somebody
 * changed something.
 *
 * Order matters: redact before dropping volatile lines, so a secret on a
 * line we are about to drop is never carried in an intermediate value, and
 * trim trailing whitespace last so a line that becomes empty is caught.
 *
 * @param {string} text        the raw capture
 * @param {string} [vendor]    a key of VENDOR_PROFILES
 * @param {string[]} [extraVolatile] site-specific patterns, as regex sources
 * @param {string} [fingerprintKey] see redactSecrets
 */
export function normaliseConfig(text, vendor = 'generic', extraVolatile = [], fingerprintKey = '') {
  const profile = VENDOR_PROFILES[vendor] ?? VENDOR_PROFILES.generic;
  const extra = extraVolatile.map((p) => {
    try { return new RegExp(p); } catch { return null; }
  }).filter(Boolean);
  const volatile = [...profile.volatile, ...extra];

  return redactSecrets(text, fingerprintKey)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => !volatile.some((p) => p.test(line)))
    // A capture that begins or ends with blank lines is not a different
    // configuration from one that does not.
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
    // Runs of blank lines are formatting, not configuration.
    .replace(/\n{3,}/g, '\n\n');
}

/** Content address of a normalised configuration. */
export function configHash(normalised) {
  return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/**
 * A unified diff, without a dependency.
 *
 * Longest common subsequence over lines. Configurations are thousands of
 * lines and a full LCS matrix is O(n·m) in memory, so anything past the
 * bound falls back to a plain summary rather than allocating gigabytes to
 * pretty-print a diff nobody will read line by line anyway.
 */
export function diffConfigs(before, after, { maxLines = 20_000, context = 3 } = {}) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');

  if (a.length > maxLines || b.length > maxLines) {
    return {
      truncated: true,
      added: Math.max(0, b.length - a.length),
      removed: Math.max(0, a.length - b.length),
      hunks: [],
    };
  }

  // LCS lengths, rolling two rows — the table itself is never needed whole
  // for the counts, but the backtrack is, so keep the full table only when
  // the product is small enough to be worth it.
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ op: ' ', line: a[i], a: i, b: j }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ op: '-', line: a[i], a: i }); i++; }
    else { ops.push({ op: '+', line: b[j], b: j }); j++; }
  }
  while (i < a.length) ops.push({ op: '-', line: a[i], a: i++ });
  while (j < b.length) ops.push({ op: '+', line: b[j], b: j++ });

  const added = ops.filter((o) => o.op === '+').length;
  const removed = ops.filter((o) => o.op === '-').length;

  // Group changes into hunks with context, so the reader sees where in the
  // configuration a change landed rather than a naked pair of lines.
  const hunks = [];
  let current = null;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].op === ' ') {
      if (current && k - current.lastChange > context) { hunks.push(current); current = null; }
      else if (current) current.lines.push(ops[k]);
      continue;
    }
    if (!current) {
      const start = Math.max(0, k - context);
      current = { lines: ops.slice(start, k), lastChange: k };
    }
    current.lines.push(ops[k]);
    current.lastChange = k;
  }
  if (current) hunks.push(current);

  return {
    truncated: false,
    added,
    removed,
    hunks: hunks.map((h) => ({
      lines: h.lines.map(({ op, line }) => ({ op, line })),
    })),
  };
}

/**
 * Is this device drifting from what was approved?
 *
 * Three states, and the third is the one that matters: a device with no
 * approved baseline is NOT drifting — nobody has said what it should be —
 * and reporting it as drift makes the whole view noise on day one, which is
 * how the feature gets turned off in week two.
 */
export function driftStatus({ currentHash, baselineHash } = {}) {
  if (!baselineHash) return 'unapproved';
  if (!currentHash) return 'unknown';
  return currentHash === baselineHash ? 'compliant' : 'drifted';
}

/**
 * A one-line summary of what a capture changed, for an alert body.
 * "3 lines added, 1 removed" is what an operator needs at 2am; the diff is
 * what they need at 9am, and it is one click away in the console.
 */
export function changeSummary(diff) {
  if (!diff) return 'no change';
  if (diff.truncated) return `configuration replaced (too large to diff line by line)`;
  if (!diff.added && !diff.removed) return 'no change';
  const parts = [];
  if (diff.added) parts.push(`${diff.added} line${diff.added === 1 ? '' : 's'} added`);
  if (diff.removed) parts.push(`${diff.removed} line${diff.removed === 1 ? '' : 's'} removed`);
  return parts.join(', ');
}
