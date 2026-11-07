/**
 * The local dashboard server: serves the built static app from `dist/` and answers `/mcp` and
 * `/api/*` from `server/routes.ts` — the same route table the deployed function runs, over the
 * JSON file store instead of the app database. The org API key stays in this process
 * (`NAIVE_API_KEY`); the browser only ever talks to `/api/*`.
 *
 * Run: `pnpm build && pnpm serve` (node's own type stripping; zero deps).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { isOperatorPath, operatorRedirect } from "../site/routing.ts";
import { configFromEnv } from "./proxy.ts";
import { handleRequest, isLoopback, SSE_RETRY, type ApiContext, type ApiReply } from "./routes.ts";
import { openStore } from "./store.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const store = openStore(join(root, "data", "store.json"));
/** Local runs mint their own tokens from Settings; the platform's bearer is injected on the deploy. */
const base = {
  store: () => Promise.resolve(store),
  config: configFromEnv(process.env),
  mcpToken: process.env.VETTA_MCP_TOKEN,
  /** Optional here and required on the deploy: only a loopback caller may go without it. */
  dashboardToken: process.env.DASHBOARD_TOKEN,
  /** All three are the platform's to write on a deploy; unset here, the gate screen has no door but the token. */
  dashboardPassword: process.env.DASHBOARD_PASSWORD,
  studioUrl: process.env.NAIVE_STUDIO_URL,
  appId: process.env.NAIVE_APP_ID,
  publicShell: () => readFile(join(root, "dist", "site-shell.html"), "utf8"),
};

/**
 * `local` is decided per request, not per process: this server binds every interface, so a LAN peer
 * or a tunnel reaches it too, and only a loopback peer is the developer the `/api/*` bypass is for.
 */
const contextFor = (req: IncomingMessage): ApiContext =>
  ({ ...base, local: isLoopback(req.socket.remoteAddress) });

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".woff2": "font/woff2",
};

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });

async function relay(res: ServerResponse, upstream: Response): Promise<void> {
  res.writeHead(upstream.status, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(SSE_RETRY);
  if (upstream.body !== null) {
    const reader = upstream.body.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) res.write(next.value);
  }
  res.end();
}

/** A platform file's bytes (`GET /api/files/:id`), piped with the headers the route kept — not SSE. */
async function sendFile(res: ServerResponse, status: number, upstream: Response, headers: ApiReply["headers"]): Promise<void> {
  res.writeHead(status, headers ?? {});
  if (upstream.body !== null) {
    const reader = upstream.body.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) res.write(next.value);
  }
  res.end();
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  const reply = await handleRequest({
    method: (req.method ?? "GET").toUpperCase(),
    path: url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname,
    query: url.searchParams,
    headers,
    body: await readBody(req),
  }, contextFor(req));

  if (reply.stream) return relay(res, reply.stream);
  if (reply.file) return sendFile(res, reply.status, reply.file, reply.headers);
  if (reply.text !== undefined) return void res.writeHead(reply.status, reply.headers ?? {}).end(reply.text);
  // `/api/enter` answers with a cookie and a `location` and nothing else. An array value is several
  // headers of one name, which is how Node's `writeHead` takes it: `set-cookie` cannot be joined.
  if (reply.body === undefined) return void res.writeHead(reply.status, reply.headers ?? {}).end();
  return send(res, reply.status, reply.body, reply.headers);
}

/**
 * Two doors out of one `dist/`: the public site is `index.html`, the operator dashboard is
 * `app/index.html`, and a deep link under `/app` falls back to the latter so a reload of `/app/crm`
 * is the dashboard and not the site. The old root operator paths are sent to `/app`.
 */
async function handleStatic(res: ServerResponse, path: string): Promise<void> {
  const legacy = operatorRedirect(path);
  if (legacy !== null) return void res.writeHead(302, { location: legacy }).end();
  const clean = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, "dist", clean === "/" ? "index.html" : clean);
  try {
    const content = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(await readFile(join(root, "dist", isOperatorPath(clean) ? "app/index.html" : "site-shell.html")));
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handled = url.pathname === "/mcp" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/blog/") || ["/", "/robots.txt", "/sitemap.xml", "/llms.txt"].includes(url.pathname)
    ? handleApi(req, res, url)
    : handleStatic(res, url.pathname);
  handled.catch(() => send(res, 502, { error: "upstream unavailable" }));
});

const port = Number(process.env.PORT ?? 8789);
server.listen(port, () => console.log(`dashboard on :${port} (${base.config === null ? "no NAIVE_API_KEY — store routes only" : "platform mode"})`));
