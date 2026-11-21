import { badRequest } from './http.js';

/**
 * Guard for the ad-hoc read-only query console.
 *
 * The API also runs as a least-privilege database account, but that account
 * needs DDL rights for migrations, so this guard is a required second layer.
 * It permits exactly one statement and rejects write/administrative keywords.
 */
const READ_ONLY_START = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i;
const WRITE_KEYWORD =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|REPLACE|CALL|LOAD|INTO\s+OUTFILE)\b/i;

export function assertReadOnlySql(input: string): string {
  const sql = input.trim().replace(/;+\s*$/, '');
  if (!sql) throw badRequest('Enter a read-only SQL statement.');
  if (sql.includes(';')) throw badRequest('Only one read-only statement is allowed.');
  if (!READ_ONLY_START.test(sql)) {
    throw badRequest('Only read-only statements (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH) are permitted.');
  }
  if (WRITE_KEYWORD.test(sql)) {
    throw badRequest(
      'The statement contains a write or administrative keyword. Use the dedicated migration/backup endpoints.',
    );
  }
  return sql;
}
