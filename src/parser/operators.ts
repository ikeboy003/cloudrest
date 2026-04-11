// Operator parser — turns a `<op>.<value>` fragment into a typed Operation.
//
// COMPAT: The set of operators is a closed allowlist matching PostgREST.
// Unknown operator-shaped tokens (`[a-z]{2,12}`) produce PGRST100 rather
// than silently widening the query to an RPC param (catches typos like
// `ltee` or `eqq`).

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';
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

  // BUG FIX (#V): the old split used `remaining.indexOf('.')`, which
  // cut in the middle of a parenthesized operator argument. A typo
  // like `fts(english.word` (missing close paren) would produce
  // `opStr='fts(english'`, `val='word'` — neither of which matches any
  // branch — and then fall through to `ok(null)`, becoming an RPC
  // parameter. Track paren depth while searching for the split and
  // reject unbalanced shapes outright.
  const splitResult = findOpValueSplit(remaining);
  if (splitResult === 'unbalanced') {
    return err(
      parseErrors.queryParam(
        'filter',
        `unbalanced parentheses in operator expression "${rawValue}"`,
      ),
    );
  }
  if (splitResult === -1) {
    // BUG FIX (#AA10): once the value-side `not.` has been consumed,
    // the remainder MUST parse as an operator. `col=not.` (nothing
    // after) and `col=not.EQ.1` (unknown op) used to silently become
    // RPC params. Anything short of a valid op is an error.
    if (negated) {
      return err(
        parseErrors.queryParam(
          'filter',
          `"not." prefix requires a valid operator after it in "${rawValue}"`,
        ),
      );
    }
    // No `<op>.<value>` separator at all -> this can never be a filter.
    // Return null so the dispatcher treats the pair as an RPC parameter.
    // The old code used to run `tryParseOperation` here which would
    // reject bare lowercase values like `size=big` as "unknown operator"
    // because of the typo-detection regex. Bug fix per parser review.
    return ok(null);
  }

  const opStr = remaining.slice(0, splitResult);
  const val = remaining.slice(splitResult + 1);

  // Geospatial: `col=geo.dwithin(lat,lng,meters)` — opStr is "geo".
  if (opStr === 'geo') {
    const geo = parseGeoOperation(val);
    if (!geo.ok) return geo;
    if (geo.value === null) {
      if (negated) {
        return err(
          parseErrors.queryParam(
            'filter',
            `"not." prefix requires a valid operator after it in "${rawValue}"`,
          ),
        );
      }
      return ok(null);
    }
    return ok({ negated, operation: geo.value });
  }

  const operation = tryParseOperation(opStr, val);
  if (!operation.ok) return operation;
  if (operation.value === null) {
    // BUG FIX (#AA10): once `not.` was consumed, failing to recognize
    // the body is a parse error, not an RPC fallthrough.
    if (negated) {
      return err(
        parseErrors.queryParam(
          'filter',
          `"not." prefix requires a valid operator after it in "${rawValue}"`,
        ),
      );
    }
    return ok(null);
  }
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
  // BUG FIX (#19): operator parentheses are meaningful only for:
  //   - quantifiers `(any)` / `(all)` on QUANT_OPS
  //   - languages `(english)` etc. on FTS_OPS
  //
  // The old parser accepted `fts(any)`, `neq(any)`, `in(any)` etc. by
  // falling through with the parens silently stripped. The rewrite
  // refuses to strip parens from anything outside the two allowed
  // shapes. An unrecognized parenthesized token is an explicit error,
  // not a fallthrough.
  const parenMatch = opStr.match(/^([a-z]+)\(([^()]*)\)$/i);
  let base = opStr;
  let parenArg: string | undefined;
  if (parenMatch) {
    base = parenMatch[1]!;
    parenArg = parenMatch[2]!;
  }

  // Quantifier branch — only on QUANT_OPS, and only `(any)` / `(all)`.
  if (parenArg !== undefined && base in QUANT_OPS) {
    if (parenArg !== 'any' && parenArg !== 'all') {
      return err(
        parseErrors.queryParam(
          opStr,
          `quantifier "(${parenArg})" must be "(any)" or "(all)"`,
        ),
      );
    }
    if (base === 'eq' && val.toLowerCase() === 'null') {
      return err(
        parseErrors.queryParam(
          'eq',
          'eq.null always evaluates to false in SQL. Use is.null to check for NULL values.',
        ),
      );
    }
    return ok({
      type: 'opQuant',
      operator: QUANT_OPS[base]!,
      quantifier: parenArg as OpQuantifier,
      value: val,
    });
  }

  // FTS language branch — only on FTS_OPS, parens contain any language
  // identifier. CANNOT be a quantifier.
  if (parenArg !== undefined && base.toLowerCase() in FTS_OPS) {
    if (parenArg === '') {
      return err(
        parseErrors.queryParam(opStr, 'empty FTS language argument'),
      );
    }
    // BUG FIX (#19): `fts(any).word` used to parse with `language: 'any'`.
    // Reject `any` / `all` here so they cannot be confused with the
    // quantifier form, which is disallowed for FTS.
    if (parenArg === 'any' || parenArg === 'all') {
      return err(
        parseErrors.queryParam(
          opStr,
          `"${parenArg}" is a quantifier; FTS operators do not accept quantifiers`,
        ),
      );
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(parenArg)) {
      return err(
        parseErrors.queryParam(
          opStr,
          `invalid FTS language "${parenArg}"`,
        ),
      );
    }
    // BUG FIX (#AA8): `fts(english).` used to parse as an FTS query
    // with an empty search string. An empty FTS query is never
    // meaningful at the SQL level — reject it here.
    if (val === '') {
      return err(
        parseErrors.queryParam(opStr, 'FTS query cannot be empty'),
      );
    }
    return ok({
      type: 'fts',
      operator: FTS_OPS[base.toLowerCase()]!,
      language: parenArg,
      value: val,
    });
  }

  // Any other parenthesized operator is an error — do NOT silently strip.
  if (parenArg !== undefined) {
    return err(
      parseErrors.queryParam(
        opStr,
        `operator "${base}" does not accept parenthesized arguments`,
      ),
    );
  }

  // Non-parenthesized operators.
  if (base in QUANT_OPS) {
    if (base === 'eq' && val.toLowerCase() === 'null') {
      return err(
        parseErrors.queryParam(
          'eq',
          'eq.null always evaluates to false in SQL. Use is.null to check for NULL values.',
        ),
      );
    }
    return ok({
      type: 'opQuant',
      operator: QUANT_OPS[base]!,
      quantifier: undefined,
      value: val,
    });
  }

  if (base in SIMPLE_OPS) {
    return ok({ type: 'op', operator: SIMPLE_OPS[base]!, value: val });
  }

  if (base === 'in') {
    if (!val.startsWith('(') || !val.endsWith(')')) {
      return err(
        parseErrors.queryParam(
          'in',
          'in operator requires parentheses: in.(val1,val2,...)',
        ),
      );
    }
    const inner = val.slice(1, -1);
    if (inner === '') return ok({ type: 'in', values: [] });
    const split = splitInValues(inner, { context: 'in' });
    if (!split.ok) return split;
    return ok({ type: 'in', values: split.value });
  }

  if (base === 'is') {
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

  if (base === 'isdistinct') {
    return ok({ type: 'isDistinctFrom', value: val });
  }

  const lowerBase = base.toLowerCase();
  if (lowerBase in FTS_OPS) {
    // BUG FIX (#AA8): empty FTS value must error (parity with the
    // FTS-with-language branch above).
    if (val === '') {
      return err(
        parseErrors.queryParam(base, 'FTS query cannot be empty'),
      );
    }
    return ok({ type: 'fts', operator: FTS_OPS[lowerBase]!, value: val });
  }

  // COMPAT: a token composed of letters (length >= 2) looks like an
  // operator. If we didn't recognize it, it's a typo, not an RPC
  // param. Produce a helpful error instead of silently treating the
  // whole key=value as an RPC parameter.
  //
  // BUG FIX (#W): the old upper bound `{2,12}` was arbitrary and left
  // a hole for long typos (`reallyreallylong.val`). Drop the upper
  // bound.
  //
  // BUG FIX (#AA9): the old regex `^[a-z]{2,}$` only caught purely
  // lowercase names. `id=EQ.1` and `id=eQ.1` both fell through as
  // RPC params — brutal UX on relation reads. Match case-insensitively
  // so that any letter-only typo of any case is surfaced as an error.
  if (/^[a-zA-Z]{2,}$/.test(base)) {
    return err(parseErrors.queryParam(base, `unknown operator "${base}"`));
  }

  return ok(null);
}

/**
 * Parse a geo operation from the value side of `col=geo.<something>`.
 * Returns null for a malformed non-geo value (falls through to RPC
 * param handling).
 *
 * BUG FIX: the old parser matched `\(([^)]*)\)` for args, which stops
 * at the first `)`. WKT geometries like
 * `within(POLYGON((0 0,1 1,1 0,0 0)))` have nested parens and were
 * silently rejected. The rewrite tracks paren depth so the outer
 * operator args can contain arbitrarily nested parens.
 */
function parseGeoOperation(val: string): Result<Operation | null, CloudRestError> {
  const parsed = splitGeoOpAndArgs(val);
  if (!parsed) {
    return err(
      parseErrors.queryParam(
        'geo',
        `invalid geo operation: "geo.${val}". Expected: dwithin, within, intersects, nearby`,
      ),
    );
  }

  const operator = parsed.name as GeoOperator;
  const args = parsed.args;
  if (
    operator !== 'dwithin' &&
    operator !== 'within' &&
    operator !== 'intersects' &&
    operator !== 'nearby'
  ) {
    return err(
      parseErrors.queryParam(
        'geo',
        `invalid geo operation: "geo.${val}". Expected: dwithin, within, intersects, nearby`,
      ),
    );
  }

  if (operator === 'dwithin') {
    const parts = splitGeoCommaArgs(args).map((s: string) => s.trim());
    if (parts.length !== 3) {
      return err(
        parseErrors.queryParam(
          'geo.dwithin',
          'expected 3 arguments: geo.dwithin(lat,lng,meters)',
        ),
      );
    }
    // BUG FIX (#20): strict numeric parsing. Reject empty strings,
    // hex (0x10), scientific notation, trailing junk.
    const lat = strictParseFloat(parts[0]!);
    const lng = strictParseFloat(parts[1]!);
    const distance = strictParseFloat(parts[2]!);
    if (lat === null || lng === null || distance === null) {
      return err(
        parseErrors.queryParam(
          'geo.dwithin',
          'lat, lng, and meters must be numeric literals',
        ),
      );
    }
    // BUG FIX (#X): validate coordinate ranges and non-negative
    // distance. The planner / DB would otherwise receive nonsensical
    // inputs like `geo.dwithin(999,999,-5)` and either fail obscurely
    // or silently clip them.
    const rangeErr = validateLatLng('geo.dwithin', lat, lng);
    if (rangeErr) return rangeErr;
    if (distance < 0) {
      return err(
        parseErrors.queryParam(
          'geo.dwithin',
          `distance must be non-negative, got ${distance}`,
        ),
      );
    }
    return ok({ type: 'geo', operator, lat, lng, distance });
  }

  if (operator === 'nearby') {
    const parts = splitGeoCommaArgs(args).map((s: string) => s.trim());
    if (parts.length !== 2) {
      return err(
        parseErrors.queryParam('geo.nearby', 'expected 2 arguments: geo.nearby(lat,lng)'),
      );
    }
    const lat = strictParseFloat(parts[0]!);
    const lng = strictParseFloat(parts[1]!);
    if (lat === null || lng === null) {
      return err(
        parseErrors.queryParam('geo.nearby', 'lat and lng must be numeric literals'),
      );
    }
    // BUG FIX (#X): same range check as dwithin.
    const rangeErr = validateLatLng('geo.nearby', lat, lng);
    if (rangeErr) return rangeErr;
    return ok({ type: 'geo', operator, lat, lng });
  }

  if (!args.trim()) {
    return err(
      parseErrors.queryParam(`geo.${operator}`, 'GeoJSON or WKT argument required'),
    );
  }
  // BUG FIX (#Y): the GeoJSON/WKT branch used to accept any non-empty
  // string — `geo.within(not even geo)` slipped through. Do a cheap
  // structural sniff before handing off to the builder so typos
  // surface as PGRST100 here rather than as obscure DB errors.
  const trimmed = args.trim();
  if (!looksLikeGeoJsonOrWkt(trimmed)) {
    return err(
      parseErrors.queryParam(
        `geo.${operator}`,
        `argument does not look like GeoJSON or WKT: "${trimmed}"`,
      ),
    );
  }
  return ok({ type: 'geo', operator, lat: 0, lng: 0, geojson: trimmed });
}

/**
 * Validate that a geo lat/lng pair sits inside the legal WGS84 range.
 * Returns a parse error Result when either coordinate is out of range,
 * or `null` when the pair is valid.
 */
function validateLatLng(
  ctx: string,
  lat: number,
  lng: number,
): Result<Operation | null, CloudRestError> | null {
  if (lat < -90 || lat > 90) {
    return err(
      parseErrors.queryParam(
        ctx,
        `latitude out of range (-90..90): ${lat}`,
      ),
    );
  }
  if (lng < -180 || lng > 180) {
    return err(
      parseErrors.queryParam(
        ctx,
        `longitude out of range (-180..180): ${lng}`,
      ),
    );
  }
  return null;
}

/**
 * Cheap structural sniff for GeoJSON or WKT. A full validator lives at
 * the DB layer; this check only ensures the string has a plausible
 * shape so obvious typos fail at parse time.
 *
 * Accepts:
 *   - GeoJSON: starts with `{` and ends with `}`
 *   - WKT: starts with one of the canonical WKT geometry keywords
 */
function looksLikeGeoJsonOrWkt(raw: string): boolean {
  if (raw.startsWith('{') && raw.endsWith('}')) return true;
  const wktKeyword =
    /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i;
  return wktKeyword.test(raw);
}

/**
 * Split `<name>(<args>)` into the operator name and raw args string.
 * Tracks paren depth AND quote state so nested parens (WKT) and
 * quoted JSON string values (`{"name":"a)b"}`) are preserved.
 *
 * BUG FIX (#AA7): the old scan was paren-only, so a `)` inside a
 * JSON string value would close the geo op prematurely.
 *
 * Returns null if the shape doesn't match.
 */
function splitGeoOpAndArgs(val: string): { name: string; args: string } | null {
  const parenStart = val.indexOf('(');
  if (parenStart <= 0) return null;
  const name = val.slice(0, parenStart);
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) return null;

  let depth = 0;
  let i = parenStart;
  while (i < val.length) {
    const ch = val[i]!;
    if (ch === '"') {
      i = skipGeoQuoted(val, i, '"');
      continue;
    }
    if (ch === "'") {
      i = skipGeoQuoted(val, i, "'");
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        // Must be the last character — no trailing junk.
        if (i !== val.length - 1) return null;
        return { name, args: val.slice(parenStart + 1, i) };
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * Split a geo operation's args string on top-level commas, respecting
 * nested parens and quoted JSON string regions. Used to separate
 * lat/lng/meters style arguments even when one of them contains a
 * complex WKT expression or JSON payload.
 *
 * BUG FIX (#AA7): the old split was paren-aware only.
 */
function splitGeoCommaArgs(args: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < args.length) {
    const ch = args[i]!;
    if (ch === '"' || ch === "'") {
      const end = skipGeoQuoted(args, i, ch);
      current += args.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current !== '' || result.length > 0) result.push(current);
  return result;
}

/**
 * Walk past a JSON/WKT quoted region starting at `start`. Returns the
 * index one past the closing quote, or `str.length` if the quote
 * never closes. JSON does not use doubled-quote escape, but it does
 * use `\"` — honor that.
 */
function skipGeoQuoted(str: string, start: number, quoteChar: string): number {
  let i = start + 1;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === '\\' && i + 1 < str.length) {
      i += 2;
      continue;
    }
    if (ch === quoteChar) {
      return i + 1;
    }
    i += 1;
  }
  return str.length;
}

/**
 * Strict float parser. Accepts only an optional sign, digits, an
 * optional `.` followed by more digits. Rejects:
 *   - empty strings
 *   - hex / octal / binary (`0x10`, `0o7`)
 *   - scientific notation (`1e2`)
 *   - NaN / Infinity / arbitrary whitespace
 *   - trailing junk (`12abc`)
 */
function strictParseFloat(value: string): number | null {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Find the index of the first `.` in `str` that separates an operator
 * name from its value. Paren depth aware, so dots inside `fts(english)`
 * or `geo.dwithin(lat,lng,m)` argument lists do not split.
 *
 * Returns:
 *   - a non-negative index on success
 *   - `-1` when no unparenthesized dot exists at all
 *   - the literal string `'unbalanced'` when the expression has an
 *     unclosed `(` — which is always a malformed operator shape, not a
 *     valid bare value.
 */
function findOpValueSplit(str: string): number | -1 | 'unbalanced' {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) return 'unbalanced';
      continue;
    }
    if (ch === '.' && depth === 0) {
      return i;
    }
  }
  if (depth !== 0) return 'unbalanced';
  return -1;
}
