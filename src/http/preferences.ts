// Prefer header parser.
//
// RFC 7240 preference semantics matching PostgREST's
// ApiRequest/Preferences.hs. Tokens are case-insensitive. Duplicate keys
// keep the first occurrence (PostgREST-compatible).
//
// REGRESSION: `Prefer: tx=rollback` used to be silently dropped when the
// server config forbade tx override. The dropped value now appears in
// `invalidPrefs` so response finalization can emit a Warning header
// (lenient) or surface a 400 (strict). See critique finding #75.

export type ReturnPreference = 'full' | 'headersOnly' | 'minimal';
export type CountPreference = 'exact' | 'planned' | 'estimated';
export type ResolutionPreference = 'mergeDuplicates' | 'ignoreDuplicates';
export type TxPreference = 'commit' | 'rollback';
export type MissingPreference = 'default' | 'null';
export type HandlingPreference = 'strict' | 'lenient';

export interface Preferences {
  readonly preferRepresentation?: ReturnPreference;
  readonly preferCount?: CountPreference;
  readonly preferResolution?: ResolutionPreference;
  readonly preferTransaction?: TxPreference;
  readonly preferMissing?: MissingPreference;
  readonly preferHandling?: HandlingPreference;
  readonly preferTimezone?: string;
  readonly preferMaxAffected?: number;
  /**
   * Preference tokens from the client that were rejected (unknown key,
   * unknown value, or forbidden by server config). The response layer
   * turns this into Warning headers or, under strict handling, 400.
   */
  readonly invalidPrefs: readonly string[];
}

export interface ParsePreferencesOptions {
  /**
   * When false, `tx=` preferences are recorded as invalid regardless of
   * their value, even though the token itself is syntactically valid.
   * Set this when `config.database.txEnd` is `commit` or `rollback`
   * (without the `-allow-override` suffix).
   */
  readonly allowTxOverride: boolean;
}

/**
 * Parse the Prefer header(s) into a typed Preferences object.
 *
 * Accepts comma-separated values within a single header and also
 * repeated Prefer headers.
 */
export function parsePrefer(
  headers: Headers,
  options: ParsePreferencesOptions = { allowTxOverride: true },
): Preferences {
  const raw = headers.get('prefer');

  type Mutable = {
    preferRepresentation?: ReturnPreference;
    preferCount?: CountPreference;
    preferResolution?: ResolutionPreference;
    preferTransaction?: TxPreference;
    preferMissing?: MissingPreference;
    preferHandling?: HandlingPreference;
    preferTimezone?: string;
    preferMaxAffected?: number;
    invalidPrefs: string[];
  };
  const prefs: Mutable = { invalidPrefs: [] };

  if (!raw) return prefs;

  for (const rawToken of raw.split(',')) {
    const token = rawToken.trim();
    if (!token) continue;
    const eq = token.indexOf('=');
    const key = (eq < 0 ? token : token.slice(0, eq)).trim().toLowerCase();
    const rawValue = eq < 0 ? '' : token.slice(eq + 1).trim();
    const valueLower = rawValue.toLowerCase();

    switch (key) {
      case 'return':
        if (prefs.preferRepresentation !== undefined) break;
        if (valueLower === 'representation') prefs.preferRepresentation = 'full';
        else if (valueLower === 'headers-only') prefs.preferRepresentation = 'headersOnly';
        else if (valueLower === 'minimal') prefs.preferRepresentation = 'minimal';
        else prefs.invalidPrefs.push(token);
        break;

      case 'count':
        if (prefs.preferCount !== undefined) break;
        if (valueLower === 'exact' || valueLower === 'planned' || valueLower === 'estimated') {
          prefs.preferCount = valueLower;
        } else {
          prefs.invalidPrefs.push(token);
        }
        break;

      case 'resolution':
        if (prefs.preferResolution !== undefined) break;
        if (valueLower === 'merge-duplicates') prefs.preferResolution = 'mergeDuplicates';
        else if (valueLower === 'ignore-duplicates') prefs.preferResolution = 'ignoreDuplicates';
        else prefs.invalidPrefs.push(token);
        break;

      case 'tx':
        // REGRESSION: critique #75 — never silently drop tx= preferences.
        if (!options.allowTxOverride) {
          prefs.invalidPrefs.push(token);
          break;
        }
        if (prefs.preferTransaction !== undefined) break;
        if (valueLower === 'commit') prefs.preferTransaction = 'commit';
        else if (valueLower === 'rollback') prefs.preferTransaction = 'rollback';
        else prefs.invalidPrefs.push(token);
        break;

      case 'missing':
        if (prefs.preferMissing !== undefined) break;
        if (valueLower === 'default' || valueLower === 'null') prefs.preferMissing = valueLower;
        else prefs.invalidPrefs.push(token);
        break;

      case 'handling':
        if (prefs.preferHandling !== undefined) break;
        if (valueLower === 'strict' || valueLower === 'lenient') prefs.preferHandling = valueLower;
        else prefs.invalidPrefs.push(token);
        break;

      case 'timezone':
        if (prefs.preferTimezone !== undefined || !rawValue) break;
        if (isValidTimezone(rawValue)) {
          // IANA timezone names are case-sensitive.
          prefs.preferTimezone = rawValue;
        } else {
          prefs.invalidPrefs.push(token);
        }
        break;

      case 'max-affected':
        if (prefs.preferMaxAffected !== undefined || !valueLower) break;
        if (/^\d+$/.test(valueLower)) {
          prefs.preferMaxAffected = Number(valueLower);
        } else {
          prefs.invalidPrefs.push(token);
        }
        break;

      default:
        prefs.invalidPrefs.push(token);
    }
  }

  return prefs;
}

/**
 * Build the `Preference-Applied` response header value, or null when no
 * preferences were applied.
 *
 * `max-affected` only appears in Preference-Applied under
 * `handling=strict`, matching PostgREST.
 */
export function preferenceAppliedHeader(prefs: Preferences): string | null {
  const applied: string[] = [];

  if (prefs.preferResolution === 'mergeDuplicates') applied.push('resolution=merge-duplicates');
  else if (prefs.preferResolution === 'ignoreDuplicates') applied.push('resolution=ignore-duplicates');

  if (prefs.preferMissing) applied.push(`missing=${prefs.preferMissing}`);

  if (prefs.preferRepresentation === 'full') applied.push('return=representation');
  else if (prefs.preferRepresentation === 'headersOnly') applied.push('return=headers-only');
  else if (prefs.preferRepresentation === 'minimal') applied.push('return=minimal');

  if (prefs.preferCount) applied.push(`count=${prefs.preferCount}`);
  if (prefs.preferTransaction) applied.push(`tx=${prefs.preferTransaction}`);
  if (prefs.preferHandling) applied.push(`handling=${prefs.preferHandling}`);
  if (prefs.preferTimezone) applied.push(`timezone=${prefs.preferTimezone}`);
  if (prefs.preferMaxAffected !== undefined && prefs.preferHandling === 'strict') {
    applied.push(`max-affected=${prefs.preferMaxAffected}`);
  }

  return applied.length > 0 ? applied.join(', ') : null;
}

function isValidTimezone(tz: string): boolean {
  // `UTC` is the de-facto universal timezone and every real Postgres
  // backend accepts it, but several older Node versions omit it from
  // `Intl.supportedValuesOf('timeZone')`, and the cloudflare-workers
  // runtime has historically shipped with a partial IANA list. Allow
  // `UTC` (and the common case-normalized variants) explicitly up
  // front so `Prefer: timezone=UTC` is never silently rejected.
  if (tz === 'UTC' || tz === 'Etc/UTC' || tz === 'Zulu') return true;

  // Primary check: ask Intl whether the zone is valid. Rather than
  // relying on `supportedValuesOf` (which can return a partial list),
  // use the constructor — Postgres will validate the final name at
  // session-apply time anyway; this is a type check for obvious
  // typos.
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
