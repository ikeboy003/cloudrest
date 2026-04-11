// Media-type negotiation.
//
// Given a parsed Accept list and the set of media types the handler can
// produce, pick one. This is a pure function — it takes what the parser
// emitted and returns a single MediaTypeId, or an error.

import { err, ok, type Result } from '../../core/result';
import { mediaErrors, type CloudRestError } from '../../core/errors';
import type { MediaType, MediaTypeId } from './types';

export interface NegotiationRequest {
  /** The parsed Accept list, already sorted by quality + specificity. */
  readonly accept: readonly MediaType[];
  /** Media types the handler can produce, in preference order. */
  readonly offered: readonly MediaTypeId[];
  /** The literal Accept header string for error reporting. */
  readonly rawAcceptHeader: string;
}

/**
 * Pick the first offered media type that matches the client's Accept
 * list. Returns an error with the raw Accept header in the detail.
 *
 * COMPAT: `* / *` (id `any`) matches anything; the first offered type wins.
 */
export function negotiateOutputMedia(
  request: NegotiationRequest,
): Result<MediaTypeId, CloudRestError> {
  if (request.offered.length === 0) {
    return err(mediaErrors.notAcceptable(request.rawAcceptHeader));
  }

  if (request.accept.length === 0) {
    return err(mediaErrors.notAcceptable(request.rawAcceptHeader));
  }

  for (const candidate of request.accept) {
    if (candidate.id === 'any') {
      // First offered type wins under */*.
      const first = request.offered[0];
      if (first) return ok(first);
    }
    if (request.offered.includes(candidate.id)) {
      return ok(candidate.id);
    }
  }

  return err(mediaErrors.notAcceptable(request.rawAcceptHeader));
}
