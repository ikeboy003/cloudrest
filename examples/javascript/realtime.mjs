// Subscribe to CloudREST realtime change events over Server-Sent Events.
//
// Prerequisites:
//   1. Load examples/schema.sql into your database.
//   2. Load examples/rls/changes_triggers.sql to attach the change-tracking
//      trigger to the `reviews` table.
//   3. Start CloudREST with REALTIME_ENABLED=true (the example wrangler.toml
//      already sets this).
//   4. Run:  node examples/javascript/realtime.mjs
//
// The script subscribes to changes on the `reviews` table, then inserts,
// updates, and deletes a test row to trigger events. You should see six
// console log lines: connection + INSERT + UPDATE + DELETE, then the
// second round of insert+delete from the cleanup pass.

const BASE = process.env.CLOUDREST_URL ?? 'http://localhost:8787';
const JWT = process.env.CLOUDREST_JWT;
if (!JWT) {
  console.error('Set CLOUDREST_JWT to an authenticated token. Run examples/curl/auth.sh to mint one.');
  process.exit(1);
}

// 1. Open the SSE stream
const sseRes = await fetch(`${BASE}/reviews`, {
  headers: { Accept: 'text/event-stream' },
});
if (!sseRes.ok || !sseRes.body) {
  console.error('SSE subscribe failed:', sseRes.status, await sseRes.text());
  process.exit(1);
}
console.log(`Subscribed to ${BASE}/reviews (SSE)`);

// Pipe the SSE stream to stdout in a readable form
(async () => {
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      try {
        const payload = JSON.parse(dataLine.slice(5).trim());
        console.log('event:', payload);
      } catch {
        console.log('raw:', raw);
      }
    }
  }
})();

// Helpers for mutations
const authed = (init = {}) => ({
  ...init,
  headers: {
    'Authorization': `Bearer ${JWT}`,
    'Content-Type': 'application/json',
    ...(init.headers ?? {}),
  },
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Give the SSE poller a moment to hand us the "connected" event
await sleep(1000);

// 2. Insert a new review
console.log('\n→ INSERT');
await fetch(`${BASE}/reviews`, authed({
  method: 'POST',
  body: JSON.stringify({ book_id: 1, rating: 5, body: 'realtime demo' }),
}));

await sleep(1500);

// 3. Update it
console.log('\n→ UPDATE');
await fetch(`${BASE}/reviews?body=eq.realtime%20demo`, authed({
  method: 'PATCH',
  body: JSON.stringify({ rating: 4 }),
}));

await sleep(1500);

// 4. Delete it
console.log('\n→ DELETE');
await fetch(`${BASE}/reviews?body=eq.realtime%20demo`, authed({
  method: 'DELETE',
}));

// Wait one more poll cycle so we see the DELETE event, then exit
await sleep(2000);
process.exit(0);
