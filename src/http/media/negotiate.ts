// Media-type negotiation.
//
// Given a parsed Accept list and the set of media types the handler can
// produce, pick one. This is a pure function — it takes what the parser
// emitted and returns a single MediaTypeId, or an error.

import { err, ok, type Result } from '../../core/result';
import { mediaErrors, type CloudRestError } from '../../core/errors';
import { lookupById, type MediaType, type MediaTypeId } from './types';

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
 * COMPAT: `*` / `*` (id `any`) matches anything; the first offered
 * type wins. `type/*` (e.g. `application/*`) matches any offered
 * type whose registry entry shares the top-level type.
 *
 * BUG FIX (#GG12): q=0 entries are now honored as explicit
 * exclusions — an offered type that matches a q=0 entry is skipped
 * even under a later wildcard match, so
 * `Accept: application/json;q=0, (star)/(star)` will NOT select
 * `json` even though it is the first offered type.
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

  // Collect excluded concrete ids and excluded top-level types from
  // q=0 entries so wildcard matches cannot re-select them.
  const excludedIds = new Set<MediaTypeId>();
  const excludedTypes = new Set<string>();
  let excludedAny = false;
  for (const candidate of request.accept) {
    if (candidate.quality > 0) continue;
    if (candidate.id === 'any' && !candidate.typeWildcard) {
      excludedAny = true;
      continue;
    }
    if (candidate.typeWildcard) {
      excludedTypes.add(candidate.type);
      continue;
    }
    excludedIds.add(candidate.id);
  }

  const isOfferedExcluded = (id: MediaTypeId): boolean => {
    if (excludedIds.has(id)) return true;
    if (excludedAny) return true;
    if (excludedTypes.size > 0) {
      const def = lookupById(id);
      if (def && excludedTypes.has(def.type)) return true;
    }
    return false;
  };

  for (const candidate of request.accept) {
    if (candidate.quality <= 0) continue; // explicit exclusion — not a match

    if (candidate.id === 'any' && !candidate.typeWildcard) {
      // `*/*`: first offered type wins, but skip any that were
      // explicitly excluded by q=0.
      for (const offered of request.offered) {
        if (!isOfferedExcluded(offered)) return ok(offered);
      }
      continue;
    }

    if (candidate.typeWildcard) {
      // `type/*`: first offered type whose registry entry has a
      // matching top-level type wins (minus exclusions).
      for (const offered of request.offered) {
        if (isOfferedExcluded(offered)) continue;
        const def = lookupById(offered);
        if (def && def.type === candidate.type) return ok(offered);
      }
      continue;
    }

    if (request.offered.includes(candidate.id) && !isOfferedExcluded(candidate.id)) {
      return ok(candidate.id);
    }
  }

  return err(mediaErrors.notAcceptable(request.rawAcceptHeader));
}
