// SSRF guard for webhook URLs.
//
// Reject every URL whose host resolves to a private / link-local /
// loopback / cloud-metadata / Cloudflare-internal range. The check is
// conservative — we block on IP address form alone. We do NOT do DNS
// resolution (Workers doesn't give us a sync DNS lookup), so a
// hostile server that responds with `dns.example.com CNAME 127.0.0.1`
// can still slip past the guard; defeating that requires a hop-by-hop
// redirect check, which the rewrite does by refusing redirects
// entirely (`redirect: 'manual'`).

/** Human-readable reason the URL was blocked. Null = allowed. */
export type SsrfBlockReason =
  | 'non-https'
  | 'invalid-url'
  | 'loopback'
  | 'link-local'
  | 'private-network'
  | 'cloud-metadata'
  | 'cloudflare-internal'
  | 'dns-suffix-blocked';

export interface SsrfCheckResult {
  readonly allowed: boolean;
  readonly reason: SsrfBlockReason | null;
}

const ALLOWED_RESULT: SsrfCheckResult = Object.freeze({
  allowed: true,
  reason: null,
});

function blocked(reason: SsrfBlockReason): SsrfCheckResult {
  return { allowed: false, reason };
}

// ----- Cloudflare address ranges --------------------------------------
//
// CF publishes its IP list at
// https://www.cloudflare.com/ips-v4/. We block the major /12 and
// /16 blocks as a safety net — webhooks that target another CF
// customer from inside a Worker are almost certainly a bug. A
// deployment that legitimately wants to call another CF tenant can
// do so via a public hostname and an IP that's outside the
// internal ranges below.
const CLOUDFLARE_V4_PREFIXES: readonly string[] = [
  '173.245.48.',
  '103.21.244.',
  '103.22.200.',
  '103.31.4.',
  '141.101.64.',
  '108.162.192.',
  '190.93.240.',
  '188.114.96.',
  '197.234.240.',
  '198.41.128.',
  '162.158.',
  '104.16.',
  '104.17.',
  '104.18.',
  '104.19.',
  '104.20.',
  '104.21.',
  '104.22.',
  '104.23.',
  '104.24.',
  '104.25.',
  '104.26.',
  '104.27.',
  '104.28.',
  '104.29.',
  '104.30.',
  '104.31.',
  '172.64.',
  '131.0.72.',
];

// ----- Host classification --------------------------------------------

/** Entry point — call this with the full URL, not the hostname. */
export function checkWebhookUrl(raw: string): SsrfCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return blocked('invalid-url');
  }
  if (parsed.protocol !== 'https:') return blocked('non-https');
  return checkHost(parsed.hostname.toLowerCase());
}

function checkHost(host: string): SsrfCheckResult {
  // Loopback by name
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return blocked('loopback');
  }

  // Some runtimes preserve `[` / `]` on the URL.hostname; strip
  // them before classification.
  const hostBare =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  // IPv6 loopback / unspecified / dual-form.
  if (
    hostBare === '::1' ||
    hostBare === '0:0:0:0:0:0:0:1' ||
    hostBare === '::'
  ) {
    return blocked('loopback');
  }

  // IPv4
  const ipv4 = parseIpv4(hostBare);
  if (ipv4 !== null) {
    return classifyIpv4(ipv4);
  }

  // IPv6 prefix classification. `fe80::/10` is link-local;
  // `fc00::/7` is unique-local (private). The first hex group of
  // the address tells us the prefix — shorthand forms like
  // `fc00::1` still start with `fc00`.
  if (hostBare.includes(':')) {
    const firstGroup = hostBare.split(':')[0]!.toLowerCase();
    if (/^fe[89ab]/.test(firstGroup)) return blocked('link-local');
    if (/^f[cd]/.test(firstGroup)) return blocked('private-network');
  }

  // Cloud metadata names
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata.goog'
  ) {
    return blocked('cloud-metadata');
  }

  // DNS suffix filter — a hostname that LOOKS internal should be
  // rejected even if it doesn't parse as an IP.
  if (
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    host.endsWith('.lan')
  ) {
    return blocked('dns-suffix-blocked');
  }

  return ALLOWED_RESULT;
}

function parseIpv4(host: string): readonly [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
  ] as const;
  for (const p of parts) {
    if (!Number.isFinite(p) || p < 0 || p > 255) return null;
  }
  return parts;
}

function classifyIpv4(
  parts: readonly [number, number, number, number],
): SsrfCheckResult {
  const [a, b] = parts;
  // Loopback 127.0.0.0/8
  if (a === 127) return blocked('loopback');
  // Unspecified / this-host
  if (a === 0) return blocked('loopback');
  // Link-local 169.254.0.0/16
  if (a === 169 && b === 254) {
    // 169.254.169.254 is AWS / Azure IMDS.
    if (parts[2] === 169 && parts[3] === 254) {
      return blocked('cloud-metadata');
    }
    return blocked('link-local');
  }
  // Private 10/8
  if (a === 10) return blocked('private-network');
  // Private 172.16/12
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) {
    return blocked('private-network');
  }
  // Private 192.168/16
  if (a === 192 && b === 168) return blocked('private-network');
  // Carrier-grade NAT 100.64/10
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) {
    return blocked('private-network');
  }

  // Cloudflare-internal ranges
  const asDotted = parts.join('.') + '.';
  for (const prefix of CLOUDFLARE_V4_PREFIXES) {
    if (asDotted.startsWith(prefix)) return blocked('cloudflare-internal');
  }

  return ALLOWED_RESULT;
}
