/**
 * The **deployed** dashboard's whole server: one function behind `/api/app`, serving `/mcp` and
 * every `/api/*` route from the same document (ADR-0374).
 *
 * `server/index.ts` serves the identical route table for `pnpm serve`, over a JSON file. A deployed
 * app has no durable disk and no long-lived process, so this one keeps the document in the app
 * database the platform provisions for a `fullstack` app (`DATABASE_URL`, server-set) and owns it
 * for the length of one request: load once, hand `handleRequest` a store over `openStoreOver`,
 * write back once and only when something changed.
 *
 * One `pg.Client` per invocation, never a `Pool`: an instance serves one request and is frozen
 * between them, so a pooled connection is a leaked backend on the database. The connection is
 * opened lazily, on the first `ctx.store()` call, so `/api/chat`, `/api/agents` and `/api/social/*`
 * open none at all.
 *
 * The whole request is **one transaction over the locked document row**. It used to be a plain
 * read-modify-write, which for a single jsonb row is last-write-wins: eight parallel `create_lead`
 * calls each answered 200 and six clients survived, an agent's write vanishing with no error
 * anywhere. `select … for update` in `begin` holds the row for the length of the request, so the
 * next writer reads what the last one wrote. Serialising costs nothing here — the writers are one
 * operator and their own agents — and the upgrade is still real tables, which starts by replacing
 * this file's queries.
 */
import { Client } from "pg";
import { configFromEnv } from "./proxy.ts";
import { handleRequest, SSE_RETRY, type ApiRequest } from "./routes.ts";
import { emptyState, openStoreOver, type Store, type StoreState } from "./store.ts";

/** Replaced with the Vite-built public document by `build-api.mjs`. */
declare const PUBLIC_INDEX_HTML: string;

const TABLE = "agency_store";
const ROW = "singleton";

interface Request {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface Reply {
  status(code: number): Reply;
  json(body: unknown): void;
  end(body?: string): void;
  /** An array is several headers of that name (`set-cookie`), as on Node's own `ServerResponse`. */
  setHeader(name: string, value: string | string[]): void;
  write(chunk: string | Uint8Array): void;
}

/**
 * The platform hands us `...?sslmode=require`, which to libpq means "encrypt, do not assert a
 * chain" — the managed database terminates TLS at a pooler presenting a certificate this process
 * has no root for, so asserting one cannot succeed. node-postgres reads `sslmode` that way only
 * when asked to; left alone it verifies and fails with "self-signed certificate in certificate
 * chain". Asking here, rather than passing an `ssl` option, is the only thing that works: the
 * driver does `Object.assign({}, config, parse(connectionString))`, so anything the URL says about
 * TLS overrides an explicit option. Modes that *do* demand verification still get it.
 */
export function libpqCompat(url: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has("sslmode")) parsed.searchParams.set("uselibpqcompat", "true");
  return parsed.toString();
}

/**
 * Five seconds, not ten: the function's own ceiling is about ten, so a ten-second connect timeout
 * guarantees a bodiless gateway error instead of our own 503.
 */
async function connect(): Promise<Client> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is unset: the app database is not provisioned yet");
  const client = new Client({
    connectionString: libpqCompat(url),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  await client.connect();
  return client;
}

/**
 * Opens the request's transaction and returns the document, with the row locked until `commit`.
 *
 * Two round trips in the steady state — `begin`, then the locking select — and only on
 * `undefined_table` the table is created. That creation happens **outside** the transaction on
 * purpose: a failed statement aborts a Postgres transaction, so every later statement in it would
 * answer `25P02` instead of doing its work.
 *
 * A fresh deployment starts **empty** — an empty CRM is the truth about a new deployment, and a
 * populated one would be a lie about whose rows those are.
 */
async function begin(client: Client): Promise<StoreState> {
  const lockingSelect = `select state from ${TABLE} where id = $1 for update`;
  await client.query("begin");
  try {
    const { rows } = await client.query<{ state: StoreState }>(lockingSelect, [ROW]);
    if (rows[0]) return rows[0].state;
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
    await client.query("rollback");
    await client.query(`create table if not exists ${TABLE} (id text primary key, state jsonb not null)`);
    await client.query("begin");
  }
  await client.query(`insert into ${TABLE} (id, state) values ($1, $2) on conflict (id) do nothing`, [
    ROW,
    JSON.stringify(emptyState()),
  ]);
  // Re-read under the lock rather than trusting the insert: a concurrent request may have created
  // the row first, and its rows are as much the document as ours.
  const { rows } = await client.query<{ state: StoreState }>(lockingSelect, [ROW]);
  if (!rows[0]) throw new Error("the document row could not be created");
  return rows[0].state;
}

/**
 * The host states the original path in `__path` (its own rewrite semantics for `req.url` inside a
 * function are not something this file can assert), and merges the caller's own query parameters
 * alongside it. `req.url`'s pathname is the fallback, which is what a direct `/api/app` call gives.
 */
export function requestFrom(req: Request): ApiRequest {
  const url = new URL(req.url ?? "/", "http://app");
  const path = url.searchParams.get("__path") ?? url.pathname;
  url.searchParams.delete("__path");
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return {
    method: (req.method ?? "GET").toUpperCase(),
    path: path.length > 1 ? path.replace(/\/+$/, "") : path,
    query: url.searchParams,
    headers,
    body: req.body === undefined || req.body === null
      ? ""
      : typeof req.body === "string" ? req.body : JSON.stringify(req.body),
  };
}

/** The session relay: piped, not buffered, and opened with a retry hint so a drop is cheap. */
async function pipe(res: Reply, upstream: Response): Promise<void> {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.status(upstream.status);
  res.write(SSE_RETRY);
  try {
    if (upstream.body !== null) {
      const reader = upstream.body.getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read()) res.write(next.value);
    }
  } catch {
    // The browser reconnects on its own; there is no status left to change.
  }
  res.end();
}

/** A platform file's bytes (`GET /api/files/:id`): its headers are already set from the reply; piped, not buffered. */
async function sendFile(res: Reply, status: number, upstream: Response): Promise<void> {
  res.status(status);
  try {
    if (upstream.body !== null) {
      const reader = upstream.body.getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read()) res.write(next.value);
    }
  } catch {
    // The status and headers are gone already; a cut body is the browser's broken image, not a 5xx.
  }
  res.end();
}

export default async function handler(req: Request, res: Reply): Promise<void> {
  const open: { client: Client | null; state: StoreState | null; store: Store | null; dirty: boolean } = {
    client: null, state: null, store: null, dirty: false,
  };

  try {
    const reply = await handleRequest(requestFrom(req), {
      async store() {
        if (open.store === null) {
          open.client = await connect();
          open.state = await begin(open.client);
          open.store = openStoreOver(open.state, () => { open.dirty = true; });
        }
        return open.store;
      },
      config: configFromEnv(process.env),
      mcpToken: process.env["VETTA_MCP_TOKEN"],
      dashboardToken: process.env["DASHBOARD_TOKEN"],
      dashboardPassword: process.env["DASHBOARD_PASSWORD"],
      studioUrl: process.env["NAIVE_STUDIO_URL"],
      appId: process.env["NAIVE_APP_ID"],
      local: false,
      publicShell: () => Promise.resolve(PUBLIC_INDEX_HTML),
    });

    // Write and release inside the same transaction the read was taken in: the next writer's
    // `for update` unblocks only here, and unblocks onto what this request actually wrote.
    if (open.client !== null) {
      if (open.dirty) {
        await open.client.query(`update ${TABLE} set state = $2 where id = $1`, [ROW, JSON.stringify(open.state)]);
      }
      await open.client.query("commit");
    }
    for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
    if (reply.stream) return await pipe(res, reply.stream);
    if (reply.file) return await sendFile(res, reply.status, reply.file);
    if (reply.text !== undefined) return res.status(reply.status).end(reply.text);
    if (reply.body === undefined) return res.status(reply.status).end();
    return res.status(reply.status).json(reply.body);
  } catch (error) {
    // The driver's own message can name the database host and user, so it is logged, never sent.
    console.error(error);
    // Nothing half-written survives, and the lock is released for whoever is queued behind it.
    if (open.client !== null) await open.client.query("rollback").catch(() => {});
    return res.status(503).json({ error: "the app database is unavailable" });
  } finally {
    if (open.client !== null) await open.client.end();
  }
}
