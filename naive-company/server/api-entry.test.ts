/** The deployed entry point: what is decidable without a database, and what it does to one. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { libpqCompat, requestFrom } from "./api-entry.ts";

/**
 * A Postgres faithful enough to tell last-write-wins from a locked read.
 *
 * One row of JSON; values are copied in and out, because a real driver hands back a fresh parse and
 * never the stored object — sharing it would let the broken code pass. `select … for update` takes
 * a FIFO row lock that `commit`/`rollback` releases, and a transaction refuses every statement
 * after one of its own has failed (`25P02`), which is why the table creation has to sit outside it.
 */
const db = vi.hoisted(() => ({ created: false, row: null as string | null, queue: Promise.resolve() }));

vi.mock("pg", () => {
  const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
  class Client {
    private release: (() => void) | null = null;
    private inTx = false;
    private aborted = false;
    connect(): Promise<void> { return Promise.resolve(); }
    end(): Promise<void> { this.unlock(); return Promise.resolve(); }

    private unlock(): void {
      const release = this.release;
      this.release = null;
      this.inTx = false;
      this.aborted = false;
      release?.();
    }

    /** The row lock as a promise chain, so waiters are served in the order they arrived. */
    private async lock(): Promise<void> {
      if (this.release !== null) return;
      const ahead = db.queue;
      let done!: () => void;
      db.queue = new Promise<void>((resolve) => { done = resolve; });
      await ahead;
      this.release = done;
    }

    async query(sql: string, params: unknown[] = []): Promise<{ rows: { state: unknown }[] }> {
      if (this.aborted && sql !== "rollback" && sql !== "commit") {
        throw fail("25P02", "current transaction is aborted, commands ignored until end of transaction block");
      }
      if (sql === "begin") { this.inTx = true; return { rows: [] }; }
      if (sql === "commit" || sql === "rollback") { this.unlock(); return { rows: [] }; }
      if (sql.startsWith("create table")) { db.created = true; return { rows: [] }; }
      if (!db.created) { this.aborted = this.inTx; throw fail("42P01", `relation "${String(params[0])}" does not exist`); }
      if (sql.startsWith("select")) {
        if (sql.endsWith("for update")) {
          await this.lock();
          if (!this.inTx) this.unlock(); // autocommit: the lock lives as long as the statement
        }
        return { rows: db.row === null ? [] : [{ state: JSON.parse(db.row) as unknown }] };
      }
      if (sql.startsWith("insert")) { db.row ??= String(params[1]); return { rows: [] }; }
      if (sql.startsWith("update")) { db.row = String(params[1]); return { rows: [] }; }
      throw new Error(`the fake was handed sql it does not model: ${sql}`);
    }
  }
  return { Client };
});

/** One `res` double: the last status and body the handler wrote, and every header as it was set. */
const reply = () => {
  const written: { status?: number; body?: unknown } = {};
  const headers: Record<string, string | string[]> = {};
  const res = {
    status(code: number) { written.status = code; return res; },
    json(body: unknown) { written.body = body; },
    end() {}, write() {},
    setHeader(name: string, value: string | string[]) { headers[name] = value; },
  };
  return { res, written, headers };
};

const send = async (method: string, path: string, body?: unknown) => {
  const { res, written } = reply();
  await handler({ method, url: `/api/app?__path=${path}`, headers: { authorization: "Bearer dash" }, body }, res);
  return written;
};

describe("libpqCompat", () => {
  const url = "postgresql://u:p@pooler.test:5432/postgres?sslmode=require";

  it("asks the driver to read sslmode the way libpq does", () => {
    // Without this the driver verifies the chain for `require` and the connection fails against a
    // pooler whose certificate this process has no root for.
    expect(new URL(libpqCompat(url)).searchParams.get("uselibpqcompat")).toBe("true");
    expect(new URL(libpqCompat(url)).searchParams.get("sslmode")).toBe("require");
  });

  it("leaves a URL that says nothing about TLS alone", () => {
    const plain = "postgresql://u:p@db.test:5432/postgres";
    expect(libpqCompat(plain)).toBe(plain);
  });

  it("does not weaken a mode that asks to be verified", () => {
    // `uselibpqcompat` selects libpq's meaning for every mode, and libpq verifies for verify-full.
    const strict = libpqCompat("postgresql://u:p@db.test:5432/postgres?sslmode=verify-full");
    expect(new URL(strict).searchParams.get("sslmode")).toBe("verify-full");
  });
});

describe("the function itself", () => {
  beforeEach(() => {
    db.created = false;
    db.row = null;
    db.queue = Promise.resolve();
    process.env["DASHBOARD_TOKEN"] = "dash";
  });
  afterEach(() => {
    delete process.env["DASHBOARD_TOKEN"];
    delete process.env["DATABASE_URL"];
  });

  it("serves every path, and opens no database connection for a route that has no store in it", async () => {
    // `DATABASE_URL` is unset here, so any eager connect would answer 503 "the app database is
    // unavailable" instead — which is exactly what the one-function-per-route predecessor did to
    // every `/api/*` path, and what made the whole dashboard surface 404 on the deployment.
    expect(await send("GET", "/api/nothing")).toEqual({ status: 404, body: { error: "no such route" } });
  });

  it("gates the deployed surface: no token is 401, and no DASHBOARD_TOKEN at all is 503", async () => {
    // The deployment is a public URL. Anonymous curl read the CRM — names, domains, contacts and
    // their email addresses — from exactly this handler.
    const { res, written } = reply();
    await handler({ method: "GET", url: "/api/app?__path=/api/clients", headers: {} }, res);
    expect(written).toEqual({ status: 401, body: { error: "missing or invalid access token" } });

    delete process.env["DASHBOARD_TOKEN"];
    expect(await send("GET", "/api/clients")).toEqual({
      status: 503, body: { error: "not configured — set DASHBOARD_TOKEN" },
    });
    // Refused before any connection is opened: `DATABASE_URL` is unset, and neither answered 503
    // "the app database is unavailable".
  });

  it("threads the studio's environment and the password into the routes, and does without them", async () => {
    // Unset — a deployment the platform has not (yet) told about its studio — is the closed shape,
    // not an error: the gate screen shows what exists.
    const { res, written } = reply();
    await handler({ method: "GET", url: "/api/app?__path=/api/session", headers: {} }, res);
    expect(written).toEqual({ status: 200, body: { authenticated: false, studio_url: null, password_enabled: false } });

    process.env["NAIVE_STUDIO_URL"] = "https://app.usenaive.ai";
    process.env["NAIVE_APP_ID"] = "app_123";
    process.env["DASHBOARD_PASSWORD"] = "kq7m-x2rt-8bvn-pz4h";
    try {
      const shown = reply();
      await handler({ method: "GET", url: "/api/app?__path=/api/session", headers: {} }, shown.res);
      expect(shown.written).toEqual({
        status: 200,
        body: { authenticated: false, studio_url: "https://app.usenaive.ai/apps/app_123/open", password_enabled: true },
      });
      const entered = reply();
      await handler({ method: "POST", url: "/api/app?__path=/api/enter", headers: {}, body: { password: "kq7m-x2rt-8bvn-pz4h" } }, entered.res);
      expect(entered.written.status).toBe(303);
      // Two `Set-Cookie` headers reach the host as an array, never joined: the one that expires the
      // legacy unpartitioned cookie a returning browser still holds, then the live cookie — last,
      // because a browser without CHIPS sees one cookie named twice and keeps the last.
      const cookies = entered.headers["set-cookie"];
      expect(Array.isArray(cookies)).toBe(true);
      expect(cookies).toHaveLength(2);
      expect(cookies?.[0]).toBe("dashboard_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax; Secure");
      expect(cookies?.[1]).toContain("dashboard_session=dash; Path=/; HttpOnly; Secure; SameSite=None; Partitioned");
    } finally {
      delete process.env["NAIVE_STUDIO_URL"];
      delete process.env["NAIVE_APP_ID"];
      delete process.env["DASHBOARD_PASSWORD"];
    }
  });

  /**
   * The document is one jsonb row read-modify-written per request. Without the transaction that is
   * last-write-wins: eight parallel `create_lead` calls each answered 201 with a distinct client
   * and six survived — an agent's write vanishing with no error anywhere.
   */
  it("keeps every one of eight concurrent writes", async () => {
    process.env["DATABASE_URL"] = "postgresql://u:p@db.test:5432/postgres";
    const names = ["Alta", "Bluefin", "Cedar", "Dunbar", "Elmore", "Foxglove", "Granby", "Halvard"];

    const created = await Promise.all(names.map((name) =>
      send("POST", "/api/leads", {
        name, domain: `${name.toLowerCase()}.test`,
        contact: { name: "Jordan Lee", email: `jordan@${name.toLowerCase()}.test`, role: "Founder" },
      })));
    expect(created.map((r) => r.status)).toEqual(names.map(() => 201));

    const listed = await send("GET", "/api/clients");
    expect((listed.body as { name: string }[]).map((c) => c.name).sort()).toEqual([...names].sort());
    // Distinct ids too: eight rows, not one row written eight times.
    expect(new Set((listed.body as { id: string }[]).map((c) => c.id)).size).toBe(8);
  });

  it("creates the document on a fresh deployment without poisoning its own transaction", async () => {
    process.env["DATABASE_URL"] = "postgresql://u:p@db.test:5432/postgres";
    // The first request finds no table at all: the create has to happen outside the transaction,
    // or every statement after the failed one answers 25P02 and the request 503s.
    expect(await send("GET", "/api/clients")).toEqual({ status: 200, body: [] });
    expect(db.created).toBe(true);
  });
});

describe("requestFrom", () => {
  it("takes the path the rewrite states in __path, and does not leave __path in the query", () => {
    // One function serves every route, so the original path is the whole routing decision.
    const req = requestFrom({ method: "get", url: "/api/app?__path=/api/clients", headers: {} });
    expect(req.path).toBe("/api/clients");
    expect(req.query.get("__path")).toBeNull();
    expect(req.method).toBe("GET");
    expect(requestFrom({ url: "/api/app?__path=/mcp", headers: {} }).path).toBe("/mcp");
  });

  it("keeps the caller's own query parameters the host merged alongside it", () => {
    const req = requestFrom({ url: "/api/app?__path=/api/posts&state=pending", headers: {} });
    expect(req.path).toBe("/api/posts");
    expect(req.query.get("state")).toBe("pending");
  });

  it("falls back to req.url's own path, and drops a trailing slash", () => {
    expect(requestFrom({ url: "/api/clients", headers: {} }).path).toBe("/api/clients");
    expect(requestFrom({ url: "/api/app?__path=/api/clients/", headers: {} }).path).toBe("/api/clients");
    expect(requestFrom({ url: "/", headers: {} }).path).toBe("/");
  });

  it("lower-cases header names, takes the first value, and normalises the body to text", () => {
    const req = requestFrom({
      method: "POST",
      url: "/api/app?__path=/mcp",
      headers: { Authorization: "Bearer t", "x-multi": ["one", "two"] },
      body: { jsonrpc: "2.0" },
    });
    expect(req.headers.authorization).toBe("Bearer t");
    expect(req.headers["x-multi"]).toBe("one");
    expect(req.body).toBe('{"jsonrpc":"2.0"}');
    // No body is the empty string, not the object literal `{}` a GET never sent.
    expect(requestFrom({ url: "/api/app?__path=/api/clients", headers: {} }).body).toBe("");
  });
});
