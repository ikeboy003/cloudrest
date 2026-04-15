// Build the `SELECT ... FROM cloudrest._cloudrest_changes` query
// the realtime poller issues on every tick.
//
// The poll query runs through `runQuery` with `SET LOCAL ROLE` +
// `request.jwt.claim.*` set, NOT a bare postgres.js connection.
// This module only RENDERS the query; the executor handles role /
// GUC threading.
//
// Every filter value reaches SQL via `SqlBuilder.addParam`.
// Table/schema names are inlined through `escapeIdent` — they come
// from the subscription, which the caller is expected to validate
// against the schema cache before reaching this function.

import { ok, type Result } from '@/core/result';
import type { CloudRestError } from '@/core/errors';
import { SqlBuilder } from '@/builder/sql';
import type { BuiltQuery } from '@/builder/types';
import type { Subscription } from './subscription';

export interface BuildPollInput {
  readonly subscription: Subscription;
  /** Maximum rows to return per poll. */
  readonly limit: number;
}

/**
 * Render the poll query. Shape:
 *
 *   SELECT id, occurred_at, schema_name, table_name, op, pk, tenant_claims
 *   FROM cloudrest._cloudrest_changes
 *   WHERE schema_name = $1 AND table_name = $2 AND id > $3
 *   ORDER BY id ASC
 *   LIMIT <limit>
 *
 * `since` defaults to 0 when the subscription says null — new
 * clients start from the beginning of the current log.
 */
export function buildPollQuery(
  input: BuildPollInput,
): Result<BuiltQuery, CloudRestError> {
  const builder = new SqlBuilder();
  const schemaParam = builder.addParam(input.subscription.schema);
  const tableParam = builder.addParam(input.subscription.table);
  const sinceParam = builder.addParam(input.subscription.since ?? 0);
  const limit = Math.max(1, Math.min(1000, input.limit));

  builder.write(
    'SELECT id, occurred_at, schema_name, table_name, op, pk, tenant_claims ',
  );
  builder.write('FROM cloudrest._cloudrest_changes ');
  builder.write(
    `WHERE schema_name = ${schemaParam} AND table_name = ${tableParam} AND id > ${sinceParam} `,
  );
  builder.write(`ORDER BY id ASC LIMIT ${limit}`);
  return ok(builder.toBuiltQuery());
}
