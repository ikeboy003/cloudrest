// HMAC-SHA256 signature for outbound webhooks.
//
// The canonical signing payload is
//
//   timestamp + "." + table + "." + mutation + "." + body
//
// — NOT just the body. This stops a replay attack where a captured
// body is re-sent with a new timestamp. Every receiver that
// verifies the signature must reconstruct the same string and
// compare.
//
// The header value is `sha256=<hex>.<timestampIso>` so the
// receiver can read the timestamp without re-parsing the body.

export interface SignatureInput {
  readonly secret: string;
  readonly timestamp: string;
  readonly table: string;
  readonly mutation: string;
  readonly body: string;
}

export interface SignatureOutput {
  /** Value for `X-CloudREST-Signature` header. */
  readonly header: string;
  /** Raw hex digest — exposed for tests. */
  readonly hex: string;
}

/**
 * Compute the webhook HMAC-SHA256 signature. Returns both the
 * header value AND the bare hex digest so tests can assert on the
 * exact bytes.
 */
export async function signWebhook(
  input: SignatureInput,
): Promise<SignatureOutput> {
  const payload = `${input.timestamp}.${input.table}.${input.mutation}.${input.body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  );
  const view = new Uint8Array(sig);
  let hex = '';
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return {
    hex,
    header: `sha256=${hex}.${input.timestamp}`,
  };
}
