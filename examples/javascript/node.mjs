// CloudREST from Node.js using the built-in fetch API (Node 18+).
//
// Run:
//   node examples/javascript/node.mjs
//
// Assumes the example schema is loaded and CloudREST is running at
// http://localhost:8787 (override with CLOUDREST_URL).

const BASE = process.env.CLOUDREST_URL ?? 'http://localhost:8787';

async function json(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

// 1. Read with a filter
const cheap = await json('/books?price=lt.17&order=price.asc&select=title,price');
console.log('Books under $17:', cheap);

// 2. Embed a related resource
const withAuthors = await json('/books?id=eq.1&select=title,authors(name)');
console.log('\nBook with author:', withAuthors);

// 3. Aggregate via RPC
const topRated = await json('/rpc/top_rated_books?min_rating=4');
console.log('\nTop-rated books:', topRated);

// 4. Vector similarity search — CloudREST prepends a `distance` field automatically
const near = await json(
  '/books?' + new URLSearchParams({
    vector: '[0.1,0.2,0.3]',
    'vector.column': 'embedding',
    'vector.op': 'cosine',
    limit: '3',
    select: 'title',
  }),
);
console.log('\nNearest by cosine distance:', near);

// 5. Total count via Prefer header
const res = await fetch(`${BASE}/books?limit=1&select=title`, {
  headers: { Prefer: 'count=exact' },
});
console.log('\nTotal books:', res.headers.get('content-range'));
