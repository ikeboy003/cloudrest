// CloudREST Agent — a Cloudflare Agent that lets you ask questions
// about your Postgres data using natural language.
//
// RUNTIME: runs as a Durable Object on Cloudflare Workers. Uses the
// Vercel AI SDK to call an LLM with tools that query the database
// via Hyperdrive (the same connection CloudREST uses).
//
// The agent exposes four tools:
//   - list_tables:    discover available tables/views
//   - describe_table: get column info for a specific table
//   - query_data:     run a read-only SQL query (SELECT only)
//   - call_function:  invoke a Postgres function

import { routeAgentRequest } from 'agents';
import { AIChatAgent } from 'agents/ai-chat-agent';
import { streamText, tool } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import postgres from 'postgres';

// ── Types ─────────────────────────────────────────────────────────

interface AgentEnv {
  HYPERDRIVE: Hyperdrive;
  AI: Ai;
  AI_MODEL?: string;
  DB_SCHEMAS?: string;
  DataAgent: DurableObjectNamespace;
}

type AgentState = {
  messages: Array<{ role: string; content: string }>;
};

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Create a short-lived postgres client for a single tool invocation.
 * Hyperdrive pools the real TCP connections under the hood.
 */
function makeSql(env: AgentEnv) {
  return postgres(env.HYPERDRIVE.connectionString, {
    prepare: false,
    max: 1,
    idle_timeout: 5,
  });
}

/**
 * Run a read-only query inside a transaction with statement_timeout
 * and default_transaction_read_only to prevent mutations.
 */
async function readOnlyQuery(
  env: AgentEnv,
  query: string,
  params: (string | number | boolean | null)[] = [],
): Promise<Record<string, unknown>[]> {
  const sql = makeSql(env);
  try {
    const rows = await sql.begin('READ ONLY', async (tx) => {
      await tx.unsafe('SET LOCAL statement_timeout = 5000');
      return tx.unsafe(query, params);
    });
    return rows as Record<string, unknown>[];
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/**
 * Allowed schemas — defaults to 'public'.
 */
function allowedSchemas(env: AgentEnv): string[] {
  return (env.DB_SCHEMAS ?? 'public').split(',').map((s) => s.trim());
}

// ── Agent ─────────────────────────────────────────────────────────

export class DataAgent extends AIChatAgent<AgentEnv, AgentState> {
  initialState: AgentState = { messages: [] };

  async onChatMessage(onFinish: Parameters<AIChatAgent['onChatMessage']>[0]) {
    const env = this.env;
    const schemas = allowedSchemas(env);

    const modelId = env.AI_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

    const dataTools = {
      list_tables: tool({
        description:
          'List all tables and views in the database that are available to query. Returns table name, schema, type (table or view), and description.',
        parameters: z.object({
          schema: z
            .string()
            .optional()
            .describe(
              `Filter by schema name. Available schemas: ${schemas.join(', ')}`,
            ),
        }),
        execute: async ({ schema }) => {
          try {
            const targetSchemas =
              schema && schemas.includes(schema) ? [schema] : schemas;
            // Schema names come from our own config — safe to inline.
            const inList = targetSchemas
              .map((s) => `'${s.replace(/'/g, "''")}'`)
              .join(', ');
            const rows = await readOnlyQuery(
              env,
              `SELECT
                 schemaname AS schema,
                 tablename AS name,
                 'table' AS type,
                 obj_description((schemaname || '.' || tablename)::regclass) AS description
               FROM pg_tables
               WHERE schemaname IN (${inList})
               UNION ALL
               SELECT
                 schemaname AS schema,
                 viewname AS name,
                 'view' AS type,
                 obj_description((schemaname || '.' || viewname)::regclass) AS description
               FROM pg_views
               WHERE schemaname IN (${inList})
               ORDER BY schema, name`,
            );
            return { tables: rows };
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('list_tables error:', msg);
            return { error: msg };
          }
        },
      }),

      describe_table: tool({
        description:
          'Get detailed column information for a specific table or view. Returns column names, types, nullability, defaults, and constraints.',
        parameters: z.object({
          table: z.string().describe('Table or view name'),
          schema: z
            .string()
            .default('public')
            .describe('Schema name (default: public)'),
        }),
        execute: async ({ table, schema }) => {
          if (!schemas.includes(schema)) {
            return { error: `Schema '${schema}' is not accessible` };
          }
          const columns = await readOnlyQuery(
            env,
            `SELECT
               c.column_name AS name,
               c.data_type AS type,
               c.udt_name AS udt_type,
               c.is_nullable = 'YES' AS nullable,
               c.column_default AS default_value,
               c.character_maximum_length AS max_length,
               col_description(
                 ($1 || '.' || $2)::regclass,
                 c.ordinal_position
               ) AS description
             FROM information_schema.columns c
             WHERE c.table_schema = $1
               AND c.table_name = $2
             ORDER BY c.ordinal_position`,
            [schema, table],
          );

          // Also fetch primary key columns
          const pks = await readOnlyQuery(
            env,
            `SELECT a.attname AS column_name
             FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = ($1 || '.' || $2)::regclass
               AND i.indisprimary`,
            [schema, table],
          );

          // Fetch foreign keys
          const fks = await readOnlyQuery(
            env,
            `SELECT
               kcu.column_name,
               ccu.table_schema AS foreign_schema,
               ccu.table_name AS foreign_table,
               ccu.column_name AS foreign_column
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
             JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name
             WHERE tc.table_schema = $1
               AND tc.table_name = $2
               AND tc.constraint_type = 'FOREIGN KEY'`,
            [schema, table],
          );

          return {
            table: `${schema}.${table}`,
            columns,
            primary_keys: pks.map((r) => r.column_name),
            foreign_keys: fks,
          };
        },
      }),

      query_data: tool({
        description: `Run a read-only SQL SELECT query against the database. Only SELECT statements are allowed — no INSERT, UPDATE, DELETE, or DDL. Results are limited to 100 rows. Available schemas: ${schemas.join(', ')}`,
        parameters: z.object({
          sql: z
            .string()
            .describe(
              'A SELECT query to execute. Must be read-only. Use $1, $2, etc. for parameters.',
            ),
          params: z
            .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .default([])
            .describe('Query parameters (positional, matching $1, $2, etc.)'),
        }),
        execute: async ({ sql: query, params }) => {
          // Safety: reject anything that isn't a SELECT
          const normalized = query.trim().toUpperCase();
          if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
            return {
              error:
                'Only SELECT (and WITH ... SELECT) queries are allowed. No mutations permitted.',
            };
          }

          // Block obvious mutation keywords even inside CTEs
          const forbidden =
            /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY)\b/i;
          if (forbidden.test(query)) {
            return {
              error:
                'Query contains forbidden keywords. Only read-only queries are allowed.',
            };
          }

          try {
            // Wrap in a LIMIT to prevent runaway results
            const limited = `SELECT * FROM (${query}) AS __agent_q LIMIT 100`;
            const rows = await readOnlyQuery(env, limited, params);
            return {
              row_count: rows.length,
              rows,
              truncated: rows.length === 100,
            };
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return { error: msg };
          }
        },
      }),

      call_function: tool({
        description:
          'Call a Postgres function (RPC). The function must exist in one of the allowed schemas. Returns the function result.',
        parameters: z.object({
          function_name: z.string().describe('Name of the function to call'),
          schema: z
            .string()
            .default('public')
            .describe('Schema containing the function'),
          args: z
            .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .default({})
            .describe('Named arguments as key-value pairs'),
        }),
        execute: async ({ function_name, schema, args }) => {
          if (!schemas.includes(schema)) {
            return { error: `Schema '${schema}' is not accessible` };
          }

          // Validate function name to prevent injection
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(function_name)) {
            return { error: 'Invalid function name' };
          }

          const argNames = Object.keys(args);
          const argValues = Object.values(args);

          let call: string;
          if (argNames.length === 0) {
            call = `SELECT * FROM "${schema}"."${function_name}"()`;
          } else {
            const argList = argNames
              .map((name, i) => `"${name}" := $${i + 1}`)
              .join(', ');
            call = `SELECT * FROM "${schema}"."${function_name}"(${argList})`;
          }

          try {
            const rows = await readOnlyQuery(env, call, argValues);
            return { rows };
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return { error: msg };
          }
        },
      }),
    };

    const workersai = createWorkersAI({ binding: env.AI });
    const model = workersai(modelId as Parameters<typeof workersai>[0]);

    const result = streamText({
      model,
      system: `You are a helpful data assistant for a PostgreSQL database. You can explore tables, describe their structure, run read-only queries, and call database functions.

When the user asks a question about their data:
1. First discover what tables are available using list_tables
2. Understand the schema using describe_table
3. Write and execute SQL queries using query_data
4. Present results clearly with context

Always explain what you found. If a query returns no results, explain why and suggest alternatives. Format numbers and dates nicely. When showing tabular data, use markdown tables.

Available schemas: ${schemas.join(', ')}`,
      messages: this.messages,
      tools: dataTools,
      maxSteps: 10,
    });

    return result.toDataStreamResponse();
  }
}

// ── Worker entry point ────────────────────────────────────────────

export default {
  async fetch(request: Request, env: AgentEnv, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response('Not found', { status: 404 })
    );
  },
} satisfies ExportedHandler<AgentEnv>;
