// Stage 16 — admin auth tests (critique #83).

import { describe, expect, it } from 'vitest';

import { constantTimeEquals, isAdminAuthorized } from '@/router/admin-auth';

describe('constantTimeEquals', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEquals('hello', 'hello')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(constantTimeEquals('hello', 'world')).toBe(false);
  });

  it('returns false for different-length strings', () => {
    expect(constantTimeEquals('hello', 'hello!')).toBe(false);
    expect(constantTimeEquals('short', 'muchlonger')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(constantTimeEquals('', '')).toBe(true);
    expect(constantTimeEquals('', 'x')).toBe(false);
  });
});

describe('isAdminAuthorized — fail closed', () => {
  it('returns false when no expected token is configured', () => {
    expect(isAdminAuthorized(undefined, 'Bearer anything')).toBe(false);
    expect(isAdminAuthorized('', 'Bearer anything')).toBe(false);
  });

  it('returns false when the Authorization header is missing', () => {
    expect(isAdminAuthorized('secret', null)).toBe(false);
  });

  it('returns false for non-Bearer schemes', () => {
    expect(isAdminAuthorized('secret', 'Token secret')).toBe(false);
  });

  it('returns true for a matching Bearer token', () => {
    expect(isAdminAuthorized('secret', 'Bearer secret')).toBe(true);
  });

  it('returns false for a mismatched Bearer token', () => {
    expect(isAdminAuthorized('secret', 'Bearer wrong')).toBe(false);
  });

  it('is case-insensitive on the Bearer scheme marker', () => {
    expect(isAdminAuthorized('secret', 'bearer secret')).toBe(true);
    expect(isAdminAuthorized('secret', 'BEARER secret')).toBe(true);
  });
});
