#!/usr/bin/env bash
# JWT authentication — mint a token locally and use it against CloudREST.
#
# Configure CloudREST with a JWT_SECRET in .dev.vars (or wrangler secret put JWT_SECRET):
#
#   JWT_SECRET=cloudrest-example-local-secret-32chars!
#
# Then run this script. It prints an authenticated token and uses it to call
# a mutation that would fail for the anonymous role.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"
: "${JWT_SECRET:=cloudrest-example-local-secret-32chars!}"
export JWT_SECRET

# Mint an HS256 JWT with role=authenticated and a 1-hour expiration.
TOKEN=$(node -e '
  const crypto = require("crypto");
  const secret = process.env.JWT_SECRET;
  const header = Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    role: "authenticated",
    sub: "example-user",
    exp: Math.floor(Date.now()/1000) + 3600
  })).toString("base64url");
  const data = header + "." + payload;
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  console.log(data + "." + sig);
')

echo "== Minted token =="
echo "$TOKEN"
echo

echo "== Anonymous — allowed to read =="
curl -sS "$CLOUDREST_URL/books?limit=1&select=title"
echo; echo

echo "== Anonymous — cannot mutate =="
curl -sS -X POST "$CLOUDREST_URL/reviews" \
  -H "Content-Type: application/json" \
  -d '{"book_id":1,"rating":5,"body":"anon attempt"}'
echo; echo

echo "== Authenticated — can mutate =="
ROW=$(curl -sS -X POST "$CLOUDREST_URL/reviews" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"book_id":1,"rating":5,"body":"auth example"}')
echo "$ROW"
echo

echo "== Cleanup =="
curl -sS -X DELETE "$CLOUDREST_URL/reviews?body=eq.auth%20example" \
  -H "Authorization: Bearer $TOKEN"
echo "done"

echo
echo "# To reuse this token in other scripts:"
echo "#   export CLOUDREST_JWT=$TOKEN"
