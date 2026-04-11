// Stage 16 — CORS decision tests.

import { describe, expect, it } from 'vitest';

import {
  applyCorsToResponse,
  decideCors,
  renderPreflight,
} from '@/router/cors';

describe('decideCors — null allowedOrigins means DENY (#54)', () => {
  it('refuses every origin when config is null', () => {
    const d = decideCors({ allowedOrigins: null }, 'https://evil.example');
    expect(d.allowed).toBe(false);
    expect(d.allowOrigin).toBeNull();
  });
});

describe('decideCors — wildcard', () => {
  it('allows any origin and does NOT require Vary', () => {
    const d = decideCors({ allowedOrigins: ['*'] }, 'https://any.example');
    expect(d.allowed).toBe(true);
    expect(d.allowOrigin).toBe('*');
    expect(d.vary).toBe(false);
  });
});

describe('decideCors — explicit list (#55)', () => {
  it('echoes a matching origin and sets Vary', () => {
    const d = decideCors(
      { allowedOrigins: ['https://a.example', 'https://b.example'] },
      'https://a.example',
    );
    expect(d.allowed).toBe(true);
    expect(d.allowOrigin).toBe('https://a.example');
    expect(d.vary).toBe(true);
  });

  it('rejects a non-matching origin', () => {
    const d = decideCors(
      { allowedOrigins: ['https://a.example'] },
      'https://evil.example',
    );
    expect(d.allowed).toBe(false);
  });
});

describe('renderPreflight', () => {
  it('returns 403 when the decision is denied', () => {
    const r = renderPreflight(
      { allowed: false, allowOrigin: null, vary: false },
      'GET',
      null,
    );
    expect(r.status).toBe(403);
  });

  it('returns 204 with every Access-Control header when allowed', () => {
    const r = renderPreflight(
      { allowed: true, allowOrigin: 'https://a.example', vary: true },
      'GET',
      'Authorization, Content-Type',
    );
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://a.example',
    );
    expect(r.headers.get('Vary')).toBe('Origin');
    expect(r.headers.get('Access-Control-Allow-Methods')).toBe('GET');
    expect(r.headers.get('Access-Control-Allow-Headers')).toContain(
      'Authorization',
    );
  });
});

describe('applyCorsToResponse — Vary on non-wildcard (#55)', () => {
  it('adds Vary: Origin to a response that already has other Vary values', () => {
    const original = new Response('{}', {
      status: 200,
      headers: { Vary: 'Accept' },
    });
    const modified = applyCorsToResponse(original, {
      allowed: true,
      allowOrigin: 'https://a.example',
      vary: true,
    });
    expect(modified.headers.get('Vary')).toBe('Accept, Origin');
  });

  it('does not duplicate Vary: Origin when already present', () => {
    const original = new Response('{}', {
      status: 200,
      headers: { Vary: 'Origin' },
    });
    const modified = applyCorsToResponse(original, {
      allowed: true,
      allowOrigin: 'https://a.example',
      vary: true,
    });
    expect(modified.headers.get('Vary')).toBe('Origin');
  });
});
