// Stage 7 — app-settings prelude rendering.
//
// Closes gap: `config.database.appSettings` and `extraSearchPath`
// must land on the prelude as `SELECT set_config($1, $2, true), ...`.
// Every value is a bind param so a hostile setting value cannot
// inject SQL via `set_config('x', ')')--', true)`.

import { describe, expect, it } from 'vitest';

import { buildAppSettingsPrelude } from '@/executor/app-settings';

describe('buildAppSettingsPrelude — search_path', () => {
  it('issues a search_path set_config for the exposed schemas', () => {
    const built = buildAppSettingsPrelude({
      schemas: ['public', 'analytics'],
      extraSearchPath: [],
      appSettings: {},
    });
    expect(built).not.toBeNull();
    expect(built!.sql).toContain('set_config($1, $2, true)');
    expect(built!.params[0]).toBe('search_path');
    expect(built!.params[1]).toContain('"public"');
    expect(built!.params[1]).toContain('"analytics"');
  });

  it('appends extraSearchPath entries after the exposed schemas', () => {
    const built = buildAppSettingsPrelude({
      schemas: ['public'],
      extraSearchPath: ['extensions'],
      appSettings: {},
    });
    const sp = built!.params[1] as string;
    expect(sp).toMatch(/"public".*"extensions"/);
  });

  it('double-quotes identifiers so special characters are escaped', () => {
    const built = buildAppSettingsPrelude({
      schemas: ['my"schema'],
      extraSearchPath: [],
      appSettings: {},
    });
    // Double quotes inside identifiers are doubled.
    expect(built!.params[1]).toBe('"my""schema"');
  });
});

describe('buildAppSettingsPrelude — appSettings', () => {
  it('emits one set_config entry per app-setting key', () => {
    const built = buildAppSettingsPrelude({
      schemas: ['public'],
      extraSearchPath: [],
      appSettings: {
        'app.jwt_secret': 'supersecret',
        'app.feature_flag': 'on',
      },
    });
    // search_path + two app settings = three set_config entries + 6 params
    const matches = built!.sql.match(/set_config/g) ?? [];
    expect(matches.length).toBe(3);
    expect(built!.params.length).toBe(6);
    expect(built!.params).toContain('app.jwt_secret');
    expect(built!.params).toContain('supersecret');
  });

  it('binds the value as a parameter (no injection via hostile value)', () => {
    const built = buildAppSettingsPrelude({
      schemas: ['public'],
      extraSearchPath: [],
      appSettings: {
        'app.evil': "')--; DROP TABLE users;--",
      },
    });
    // The hostile value appears in params, not in the SQL string.
    expect(built!.sql).not.toContain('DROP TABLE');
    expect(built!.params).toContain("')--; DROP TABLE users;--");
  });
});

describe('buildAppSettingsPrelude — empty', () => {
  it('returns null when there is nothing to issue', () => {
    const built = buildAppSettingsPrelude({
      schemas: [],
      extraSearchPath: [],
      appSettings: {},
    });
    expect(built).toBeNull();
  });
});
