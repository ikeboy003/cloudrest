// Error factories, grouped by subsystem.
//
// INVARIANT: This file is a thin barrel only. Adding a new error means
// editing the appropriate namespace file under core/errors/, not this file.
// If a namespace is missing, create it — do not add a flat factory here.
//
// Usage:
//
//     import { parseErrors, authErrors, type CloudRestError } from '@/core/errors';
//     return err(parseErrors.queryParam('order', 'expected column'));

export type { CloudRestError, ErrorCode, ErrorVerbosity } from './errors/types';
export { applyVerbosity } from './errors/types';

export { parseErrors } from './errors/parse';
export { mediaErrors } from './errors/media';
export { schemaErrors } from './errors/schema';
export { authErrors } from './errors/auth';
export { mutationErrors } from './errors/mutation';
export { serverErrors, sqlStateToHttpStatus } from './errors/server';
export { fuzzyFind } from './errors/suggest';
