import { describe, expect, it } from 'vitest';

import {
  parsePrefer,
  preferenceAppliedHeader,
} from '../../../src/http/preferences';

function headersOf(prefer: string): Headers {
  const h = new Headers();
  h.set('prefer', prefer);
  return h;
}

describe('parsePrefer — return', () => {
  it('parses representation, headers-only, minimal', () => {
    expect(parsePrefer(headersOf('return=representation')).preferRepresentation).toBe(
      'full',
    );
    expect(parsePrefer(headersOf('return=headers-only')).preferRepresentation).toBe(
      'headersOnly',
    );
    expect(parsePrefer(headersOf('return=minimal')).preferRepresentation).toBe(
      'minimal',
    );
  });

  it('records unknown return values as invalid', () => {
    const p = parsePrefer(headersOf('return=banana'));
    expect(p.preferRepresentation).toBeUndefined();
    expect(p.invalidPrefs).toContain('return=banana');
  });
});

describe('parsePrefer — count', () => {
  it('parses exact/planned/estimated', () => {
    expect(parsePrefer(headersOf('count=exact')).preferCount).toBe('exact');
    expect(parsePrefer(headersOf('count=planned')).preferCount).toBe('planned');
    expect(parsePrefer(headersOf('count=estimated')).preferCount).toBe('estimated');
  });
});

describe('parsePrefer — tx (critique #75 regression)', () => {
  it('parses commit/rollback when allowed', () => {
    const allowed = { allowTxOverride: true };
    expect(parsePrefer(headersOf('tx=commit'), allowed).preferTransaction).toBe(
      'commit',
    );
    expect(parsePrefer(headersOf('tx=rollback'), allowed).preferTransaction).toBe(
      'rollback',
    );
  });

  // REGRESSION: critique #75 — tx=rollback must NOT be silently dropped
  // when the server forbids override. It belongs in invalidPrefs so the
  // response layer emits a Warning header (lenient) or a 400 (strict).
  it('records tx= in invalidPrefs when override is disallowed', () => {
    const forbidden = { allowTxOverride: false };
    const p = parsePrefer(headersOf('tx=rollback'), forbidden);
    expect(p.preferTransaction).toBeUndefined();
    expect(p.invalidPrefs).toContain('tx=rollback');
  });

  it('first value wins on duplicates', () => {
    const p = parsePrefer(headersOf('tx=rollback, tx=commit'));
    expect(p.preferTransaction).toBe('rollback');
  });
});

describe('parsePrefer — handling / resolution / missing', () => {
  it('parses handling strict/lenient', () => {
    expect(parsePrefer(headersOf('handling=strict')).preferHandling).toBe('strict');
    expect(parsePrefer(headersOf('handling=lenient')).preferHandling).toBe('lenient');
  });

  it('parses resolution merge/ignore duplicates', () => {
    expect(parsePrefer(headersOf('resolution=merge-duplicates')).preferResolution).toBe(
      'mergeDuplicates',
    );
    expect(parsePrefer(headersOf('resolution=ignore-duplicates')).preferResolution).toBe(
      'ignoreDuplicates',
    );
  });

  it('parses missing default/null', () => {
    expect(parsePrefer(headersOf('missing=default')).preferMissing).toBe('default');
    expect(parsePrefer(headersOf('missing=null')).preferMissing).toBe('null');
  });
});

describe('parsePrefer — timezone', () => {
  it('accepts a canonical IANA name', () => {
    const p = parsePrefer(headersOf('timezone=America/New_York'));
    expect(p.preferTimezone).toBe('America/New_York');
  });

  it('rejects obviously invalid timezone strings', () => {
    const p = parsePrefer(headersOf('timezone=not_a_zone'));
    expect(p.preferTimezone).toBeUndefined();
    expect(p.invalidPrefs).toContain('timezone=not_a_zone');
  });
});

describe('parsePrefer — max-affected', () => {
  // REGRESSION: old tests assert max-affected=0 is preserved, not coerced to falsy.
  it('preserves max-affected=0', () => {
    const p = parsePrefer(headersOf('max-affected=0'));
    expect(p.preferMaxAffected).toBe(0);
  });

  it('parses a positive integer', () => {
    expect(parsePrefer(headersOf('max-affected=42')).preferMaxAffected).toBe(42);
  });

  it('rejects non-integer max-affected', () => {
    const p = parsePrefer(headersOf('max-affected=1e2'));
    expect(p.preferMaxAffected).toBeUndefined();
    expect(p.invalidPrefs).toContain('max-affected=1e2');
  });
});

describe('parsePrefer — unknown keys', () => {
  it('records unknown keys as invalid', () => {
    const p = parsePrefer(headersOf('banana=peel'));
    expect(p.invalidPrefs).toContain('banana=peel');
  });
});

describe('preferenceAppliedHeader', () => {
  it('emits null when no preferences were applied', () => {
    expect(preferenceAppliedHeader({ invalidPrefs: [] })).toBeNull();
  });

  it('emits resolution and return in canonical form', () => {
    const header = preferenceAppliedHeader({
      invalidPrefs: [],
      preferResolution: 'mergeDuplicates',
      preferRepresentation: 'full',
    });
    expect(header).toContain('resolution=merge-duplicates');
    expect(header).toContain('return=representation');
  });

  // COMPAT: max-affected only surfaces under handling=strict.
  it('omits max-affected under lenient handling', () => {
    const header = preferenceAppliedHeader({
      invalidPrefs: [],
      preferHandling: 'lenient',
      preferMaxAffected: 5,
    });
    expect(header).toContain('handling=lenient');
    expect(header).not.toContain('max-affected');
  });

  it('includes max-affected under strict handling', () => {
    const header = preferenceAppliedHeader({
      invalidPrefs: [],
      preferHandling: 'strict',
      preferMaxAffected: 5,
    });
    expect(header).toContain('handling=strict');
    expect(header).toContain('max-affected=5');
  });
});
