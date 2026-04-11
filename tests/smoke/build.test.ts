import { describe, expect, it } from 'vitest';
import worker from '../../src/index';

describe('stage 0 scaffold', () => {
  it('exports a fetch handler', () => {
    expect(typeof worker.fetch).toBe('function');
  });

  it('returns 501 with a structured body', async () => {
    const response = await worker.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(501);
    expect(response.headers.get('content-type')).toBe('application/json');

    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('PGRST000');
    expect(body.message).toContain('not yet implemented');
  });
});
