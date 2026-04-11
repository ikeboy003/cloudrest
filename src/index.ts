// RUNTIME: Cloudflare Worker entry point.
//
// This is Stage 0 scaffolding. The real request lifecycle — route, parse,
// validate, plan, build, execute, respond, finalize — lands in later stages.
// See ARCHITECTURE.md for the request lifecycle and module ownership map.

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response(
      JSON.stringify({
        code: 'PGRST000',
        message: 'CloudREST rewrite: not yet implemented',
      }),
      {
        status: 501,
        headers: { 'content-type': 'application/json' },
      },
    );
  },
};
