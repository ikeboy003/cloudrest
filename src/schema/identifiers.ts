// Thin re-export of the builder's identifier helpers so schema-level
// code (introspection, cache hydration) does not have to import from
// `builder/` directly. Keeps the "builder is below schema" layering
// clean.

export {
  escapeIdent,
  escapeIdentList,
  pgFmtLit,
  qualifiedColumnToSql,
  qualifiedIdentifierToSql,
} from '@/builder/identifiers';
