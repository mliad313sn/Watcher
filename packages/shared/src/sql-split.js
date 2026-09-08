/**
 * Splitting a SQL file into statements.
 *
 * Needed because the migration runner has to send statements one at a time:
 * TimescaleDB refuses to create a continuous aggregate inside a transaction
 * block, and everything in one simple-query message *is* an implicit
 * transaction block. Sending the file whole therefore works right up until
 * the first continuous aggregate, which is the second file we ship.
 *
 * Splitting on `;` is the obvious approach and it is wrong in three ways
 * that all fail silently — the statement is truncated mid-string and either
 * errors confusingly or, worse, runs as something else:
 *
 *   · dollar quoting — `CREATE FUNCTION … $$ BEGIN … ; … END; $$` contains
 *     semicolons that are body text, and the tag may be named (`$fn$`);
 *   · string literals — `'a;b'`, including doubled quotes (`'it''s'`);
 *   · comments — `-- drop everything;` and `/* … ; … *​/`.
 *
 * So this is a small scanner rather than a regex. Pure, and tested against
 * each of those cases, because a migration runner that mangles one statement
 * in a hundred is worse than not having one.
 */

/**
 * @param {string} sql
 * @returns {string[]} statements, comments and blank runs removed, no
 *   trailing semicolons
 */
export function splitStatements(sql) {
  const text = String(sql ?? '');
  const out = [];
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    // line comment
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    // block comment (Postgres nests them)
    if (c === '/' && text[i + 1] === '*') {
      i = endOfBlockComment(text, i);
      continue;
    }
    // single-quoted string; '' is an escaped quote, not a terminator
    if (c === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (text[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    // double-quoted identifier
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i++;
      i++;
      continue;
    }
    // dollar quoting, tagged or not
    if (c === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? text.length : close + tag[0].length;
        continue;
      }
    }
    if (c === ';') {
      const statement = text.slice(start, i);
      if (statement.trim()) out.push(statement.trim());
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }

  const tail = text.slice(start);
  if (tail.trim()) out.push(tail.trim());

  // Strip anything that was only a comment, and the file's own transaction
  // control — the runner owns the transaction boundary so that a half-applied
  // file cannot be recorded as applied.
  return out
    .map((s) => stripLeadingComments(s))
    .filter((s) => s.length > 0)
    .filter((s) => !/^(BEGIN|COMMIT|END|START\s+TRANSACTION)$/i.test(s.trim()));
}

/**
 * Index just past a block comment starting at `at`.
 * Postgres nests them, so the first `*​/` is not necessarily the end — which
 * is the bug this exists to avoid being written twice.
 */
function endOfBlockComment(text, at) {
  let depth = 1;
  let i = at + 2;
  while (i < text.length && depth > 0) {
    if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; continue; }
    if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; continue; }
    i++;
  }
  return i;
}

/** A statement may be preceded by comments; they are not part of it. */
function stripLeadingComments(statement) {
  let s = statement;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
    } else if (s.startsWith('/*')) {
      const end = endOfBlockComment(s, 0);
      s = end >= s.length ? '' : s.slice(end);
    }
    if (s === before) break;
  }
  return s.trim();
}

/**
 * Statements TimescaleDB will not run inside a transaction block.
 *
 * The list is short and specific rather than "anything mentioning
 * timescaledb", because being wrong in the permissive direction means a
 * migration applies outside a transaction and can half-succeed.
 */
export function requiresAutocommit(statement) {
  const s = statement.replace(/\s+/g, ' ').toLowerCase();
  return /create\s+materialized\s+view.*timescaledb\.continuous/.test(s)
    || s.includes('add_continuous_aggregate_policy')
    || s.includes('add_retention_policy')
    || s.includes('add_compression_policy')
    || s.includes('create_hypertable')
    || s.includes('add_dimension');
}
