// Barrel for the Stage 8 behavior test — re-exports config + schema
// fixtures so the test file stays focused on behavior, not fixture
// wiring.

export { makeTestConfig } from './config';
export { makeTable, makeSchema, BOOKS_SCHEMA } from './schema';
