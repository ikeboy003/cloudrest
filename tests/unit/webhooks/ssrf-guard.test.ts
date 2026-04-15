// SSRF guard tests.

import { describe, expect, it } from 'vitest';

import { checkWebhookUrl } from '@/webhooks/ssrf-guard';

describe('checkWebhookUrl — scheme', () => {
  it('rejects non-https schemes', () => {
    expect(checkWebhookUrl('http://example.com').reason).toBe('non-https');
    expect(checkWebhookUrl('ftp://example.com').reason).toBe('non-https');
  });

  it('rejects malformed URLs', () => {
    expect(checkWebhookUrl('not-a-url').reason).toBe('invalid-url');
  });

  it('allows an ordinary https URL', () => {
    expect(checkWebhookUrl('https://api.example.com/hook').allowed).toBe(true);
  });
});

describe('checkWebhookUrl — loopback', () => {
  it('rejects localhost', () => {
    expect(checkWebhookUrl('https://localhost/').reason).toBe('loopback');
    expect(checkWebhookUrl('https://foo.localhost/').reason).toBe('loopback');
  });

  it('rejects 127.0.0.0/8', () => {
    expect(checkWebhookUrl('https://127.0.0.1/').reason).toBe('loopback');
    expect(checkWebhookUrl('https://127.5.5.5/').reason).toBe('loopback');
  });

  it('rejects 0.0.0.0', () => {
    expect(checkWebhookUrl('https://0.0.0.0/').reason).toBe('loopback');
  });
});

describe('checkWebhookUrl — link-local and metadata', () => {
  it('rejects 169.254.0.0/16', () => {
    expect(checkWebhookUrl('https://169.254.1.1/').reason).toBe('link-local');
  });

  it('rejects 169.254.169.254 as cloud-metadata', () => {
    expect(checkWebhookUrl('https://169.254.169.254/').reason).toBe(
      'cloud-metadata',
    );
  });

  it('rejects metadata.google.internal', () => {
    expect(
      checkWebhookUrl('https://metadata.google.internal/').reason,
    ).toBe('cloud-metadata');
  });
});

describe('checkWebhookUrl — private ranges', () => {
  it('rejects 10.0.0.0/8', () => {
    expect(checkWebhookUrl('https://10.0.0.1/').reason).toBe(
      'private-network',
    );
  });

  it('rejects 172.16.0.0/12', () => {
    expect(checkWebhookUrl('https://172.16.0.1/').reason).toBe(
      'private-network',
    );
    expect(checkWebhookUrl('https://172.31.255.255/').reason).toBe(
      'private-network',
    );
    // 172.15 is public.
    expect(checkWebhookUrl('https://172.15.0.1/').allowed).toBe(true);
  });

  it('rejects 192.168.0.0/16', () => {
    expect(checkWebhookUrl('https://192.168.1.1/').reason).toBe(
      'private-network',
    );
  });

  it('rejects 100.64.0.0/10 (CGNAT)', () => {
    expect(checkWebhookUrl('https://100.64.0.1/').reason).toBe(
      'private-network',
    );
  });
});

describe('checkWebhookUrl — Cloudflare-internal ranges', () => {
  it('rejects 104.16.0.0/12', () => {
    expect(checkWebhookUrl('https://104.16.0.1/').reason).toBe(
      'cloudflare-internal',
    );
  });

  it('rejects 172.64.0.0/13', () => {
    expect(checkWebhookUrl('https://172.64.0.1/').reason).toBe(
      'cloudflare-internal',
    );
  });
});

describe('checkWebhookUrl — DNS suffix filter', () => {
  it('rejects .internal hostnames', () => {
    expect(checkWebhookUrl('https://svc.internal/').reason).toBe(
      'dns-suffix-blocked',
    );
  });
  it('rejects .local hostnames', () => {
    expect(checkWebhookUrl('https://svc.local/').reason).toBe(
      'dns-suffix-blocked',
    );
  });
});

describe('checkWebhookUrl — IPv6', () => {
  it('rejects ::1 loopback', () => {
    expect(checkWebhookUrl('https://[::1]/').reason).toBe('loopback');
  });
  it('rejects fe80 link-local', () => {
    expect(checkWebhookUrl('https://[fe80::1]/').reason).toBe('link-local');
  });
  it('rejects fc00 unique-local', () => {
    expect(checkWebhookUrl('https://[fc00::1]/').reason).toBe(
      'private-network',
    );
  });
});
