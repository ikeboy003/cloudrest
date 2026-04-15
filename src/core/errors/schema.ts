// Schema cache errors — PGRST2xx.
//
// PostgREST emits these when the schema cache cannot satisfy a
// request — ambiguous or missing relationships, missing RPC functions,
// unknown tables, unknown columns. Status 300 is used for "Multiple
// Choices" on ambiguous relationships (PostgREST convention).

import { makeError, type CloudRestError } from './types';

export const schemaErrors = {
  ambiguousRelationship(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST200',
      message: 'Ambiguous relationship between resources',
      details: detail,
      httpStatus: 300,
    });
  },

  ambiguousRpc(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST201',
      message: 'Ambiguous RPC function',
      details: detail,
      httpStatus: 300,
    });
  },

  noRelationship(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST202',
      message: 'No relationship found between resources',
      details: detail,
      httpStatus: 400,
    });
  },

  noRpc(name: string, schema: string, suggestion: string | null = null): CloudRestError {
    return makeError({
      code: 'PGRST203',
      message: `Function "${name}" not found in schema "${schema}"`,
      hint: suggestion ? `Did you mean "${suggestion}"?` : null,
      httpStatus: 404,
    });
  },

  columnNotFound(
    column: string,
    table: string,
    suggestion: string | null = null,
  ): CloudRestError {
    return makeError({
      code: 'PGRST204',
      message: `Column "${column}" not found in "${table}"`,
      hint: suggestion ? `Did you mean "${suggestion}"?` : null,
      httpStatus: 400,
    });
  },

  tableNotFound(
    table: string,
    _schema: string,
    suggestion: string | null = null,
  ): CloudRestError {
    return makeError({
      code: 'PGRST205',
      message: `Could not find the relation "${table}" in the schema cache`,
      hint: suggestion
        ? `Did you mean "${suggestion}"? If a new relation was created, try reloading the schema cache.`
        : 'If a new relation was created in the database, try reloading the schema cache.',
      httpStatus: 404,
    });
  },

  mutationNotAllowed(table: string, mutation: string): CloudRestError {
    return makeError({
      code: 'PGRST119',
      message: `${mutation} is not allowed on "${table}"`,
      httpStatus: 405,
    });
  },
};
