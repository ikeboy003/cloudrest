// RUNTIME: ambient declaration for the `postgres` package.
//
// The package ships its own types but they assume a Node runtime
// with Buffer / net APIs that don't exist in the Cloudflare Workers
// type graph. Declaring the minimal shape we use here lets
// `executor/client.ts` import it without dragging Node types in.
//
// INVARIANT: the rewrite only uses
// `SqlClient`'s two methods on the returned value. Keep the shape
// here narrow so a refactor doesn't accidentally call an
// unsupported method.

declare module 'postgres' {
  type SqlFactory = (
    connectionString: string,
    options?: Record<string, unknown>,
  ) => unknown;

  const postgres: SqlFactory;
  export default postgres;
}
