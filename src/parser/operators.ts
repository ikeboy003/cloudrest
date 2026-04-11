// Operator parser — turns a `<op>.<value>` fragment into a typed Operation.
//
// COMPAT: The set of operators is a closed allowlist matching PostgREST.
// Unknown operator-shaped tokens (`[a-z]{2,12}`) produce PGRST100 rather
// than silently widening the query to an RPC param (catches typos like
// `ltee` or `eqq`).

import { err, ok, type Result } from '../core/result';
import { parseErrors, type CloudRestError } from '../core/errors';
import { splitInValues } from './tokenize';
import type {
  FtsOperator,
  GeoOperator,
  IsVal,
  OpExpr,
  OpQuantifier,
  Operation,
  QuantOperator,
  SimpleOperator,
} from './types/filter';

const QUANT_OPS: Record<string, QuantOperator> = {
  eq: 'eq',
  gte: 'gte',
  gt: 'gt',
  lte: 'lte',
  lt: 'lt',
  like: 'like',
  ilike: 'ilike',
  match: 'match',
  imatch: 'imatch',
};

const SIMPLE_OPS: Record<string, SimpleOperator> = {
  neq: 'neq',
  cs: 'cs',
  cd: 'cd',
  ov: 'ov',
  sl: 'sl',
  sr: 'sr',
  nxr: 'nxr',
  nxl: 'nxl',
  adj: 'adj',
};

const FTS_OPS: Record<string, FtsOperator> = {
  fts: 'fts',
  plfts: 'plfts',
  phfts: 'phfts',
  wfts: 'wfts',
};

const IS_VALUES: Record<string, IsVal> = {
  null: 'null',
  not_null: 'not_null',
  true: 'true',
  false: 'false',
  unknown: 'unknown',
};

/**
 * Parse a `<op>.<value>` expression. Returns:
 *   - Ok(OpExpr) for a successful parse
 *   - Err(CloudRestError) for a well-formed-looking but invalid op
 *   - Ok(null) when the value is NOT a filter (handler treats as RPC param)
 *
 * The `null` success case is load-bearing: `?page=123` should NOT be
 * rejected as a bad filter; it is simply an RPC parameter.
 */
export function parseOpExpr(
  rawValue: string,
): Result<OpExpr | null, CloudRestError> {
  let negated = false;
  let remaining = rawValue;

  if (remaining.startsWith('not.')) {
    negated = true;
    remaining = remaining.slice(4);
  }

  const dotIdx = remaining.indexOf('.');
  if (dotIdx === -1) {
    const operation = tryParseOperation(remaining, '');
    if (!operation.ok) return operation;
    if (operation.value === null) return ok(null);
    return ok({ negated, operation: operation.value });
  }

  const opStr = remaining.slice(0, dotIdx);
  const val = remaining.slice(dotIdx + 1);

  // Geospatial: `col=geo.dwithin(lat,lng,meters)` — opStr is "geo".
  if (opStr === 'geo') {
    const geo = parseGeoOperation(val);
    if (!geo.ok) return geo;
    if (geo.value === null) return ok(null);
    return ok({ negated, operation: geo.value });
  }

  const operation = tryParseOperation(opStr, val);
  if (!operation.ok) return operation;
  if (operation.value === null) return ok(null);
  return ok({ negated, operation: operation.value });
}

/**
 * Parse one operator-and-value fragment. Returns null when the token
 * does not look like an operator at all.
 */
function tryParseOperation(
  opStr: string,
  val: string,
): Result<Operation | null, CloudRestError> {
  // Quantifier: `eq(any)`, `lt(all)`, etc.
  const quantMatch = opStr.match(/^(\w+)\((any|all)\)$/);
  let quantifier: OpQuantifier | undefined;
  let actualOp = opStr;
  if (quantMatch) {
    actualOp = quantMatch[1]!;
    quantifier = quantMatch[2] as OpQuantifier;
  }

  if (actualOp in QUANT_OPS) {
    // COMPAT: `eq.null` always evaluates false in SQL; PostgREST rejects
    // it with a hint pointing to `is.null`. Catch it here before the
    // operation reaches the builder.
    if (actualOp === 'eq' && val.toLowerCase() === 'null') {
      return err(
        parseErrors.queryParam(
          'eq',
          'eq.null always evaluates to false in SQL. Use is.null to check for NULL values.',
        ),
      );
    }
    return ok({
      type: 'opQuant',
      operator: QUANT_OPS[actualOp]!,
      quantifier,
      value: val,
    });
  }

  if (actualOp in SIMPLE_OPS) {
    return ok({ type: 'op', operator: SIMPLE_OPS[actualOp]!, value: val });
  }

  if (actualOp === 'in') {
    if (!val.startsWith('(') || !val.endsWith(')')) {
      return err(
        parseErrors.queryParam(
          'in',
          'in operator requires parentheses: in.(val1,val2,...)',
        ),
      );
    }
    const inner = val.slice(1, -1);
    if (inner.trim() === '') return ok({ type: 'in', values: [] });
    return ok({ type: 'in', values: splitInValues(inner) });
  }

  if (actualOp === 'is') {
    const lowered = val.toLowerCase();
    if (lowered in IS_VALUES) {
      return ok({ type: 'is', value: IS_VALUES[lowered]! });
    }
    return err(
      parseErrors.queryParam(
        'is',
        `invalid is value: "${val}" (expected null, true, false, unknown, or not_null)`,
      ),
    );
  }

  if (actualOp === 'isdistinct') {
    return ok({ type: 'isDistinctFrom', value: val });
  }

  const lowerOp = actualOp.toLowerCase();
  if (lowerOp in FTS_OPS) {
    return ok({ type: 'fts', operator: FTS_OPS[lowerOp]!, value: val });
  }

  const ftsLangMatch = actualOp.match(/^(fts|plfts|phfts|wfts)\((\w+)\)$/i);
  if (ftsLangMatch) {
    return ok({
      type: 'fts',
      operator: FTS_OPS[ftsLangMatch[1]!.toLowerCase()]!,
      language: ftsLangMatch[2]!,
      value: val,
    });
  }

  // COMPAT: `[a-z]{2,12}` tokens look like operators; if we didn't
  // recognize them, it's a typo, not an RPC param. Produce a helpful
  // error instead of silently treating the whole key=value as an RPC
  // parameter.
  if (/^[a-z]{2,12}$/.test(actualOp)) {
    return err(parseErrors.queryParam(actualOp, `unknown operator "${actualOp}"`));
  }

  return ok(null);
}

/**
 * Parse a geo operation from the value side of `col=geo.<something>`.
 * Returns null for a malformed non-geo value (falls through to RPC
 * param handling).
 */
function parseGeoOperation(val: string): Result<Operation | null, CloudRestError> {
  const match = val.match(/^(dwithin|within|intersects|nearby)\(([^)]*)\)$/);
  if (!match) {
    return err(
      parseErrors.queryParam(
        'geo',
        `invalid geo operation: "geo.${val}". Expected: dwithin, within, intersects, nearby`,
      ),
    );
  }

  const operator = match[1]! as GeoOperator;
  const args = match[2]!;

  if (operator === 'dwithin') {
    const parts = args.split(',').map((s) => s.trim());
    if (parts.length !== 3) {
      return err(
        parseErrors.queryParam(
          'geo.dwithin',
          'expected 3 arguments: geo.dwithin(lat,lng,meters)',
        ),
      );
    }
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    const distance = Number(parts[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(distance)) {
      return err(
        parseErrors.queryParam(
          'geo.dwithin',
          'lat, lng, and meters must be numbers',
        ),
      );
    }
    return ok({ type: 'geo', operator, lat, lng, distance });
  }

  if (operator === 'nearby') {
    const parts = args.split(',').map((s) => s.trim());
    if (parts.length !== 2) {
      return err(
        parseErrors.queryParam('geo.nearby', 'expected 2 arguments: geo.nearby(lat,lng)'),
      );
    }
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return err(parseErrors.queryParam('geo.nearby', 'lat and lng must be numbers'));
    }
    return ok({ type: 'geo', operator, lat, lng });
  }

  if (!args.trim()) {
    return err(
      parseErrors.queryParam(`geo.${operator}`, 'GeoJSON or WKT argument required'),
    );
  }
  return ok({ type: 'geo', operator, lat: 0, lng: 0, geojson: args });
}
