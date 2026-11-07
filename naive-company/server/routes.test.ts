/**
 * The route table, tested without a socket or a database — which is the reason it moved out of
 * `server/index.ts`. Both callers (`pnpm serve` and the deployed function) run exactly this.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "./mcp.ts";
import { handleRequest, isLoopback, OPEN_LEADS_CAP, type ApiContext, type ApiRequest } from "./routes.ts";
import { LEAD_WINDOW_MS, LEADS_PER_WINDOW } from "./store.ts";
import { emptyState, openStoreOver, type Store, type StoreState } from "./store.ts";

afterEach(() => vi.unstubAllGlobals());

const lead = {
  name: "Summit Outdoor Co",
  domain: "summitoutdoor.example",
  contact: { name: "Jordan Lee", email: "jordan@summitoutdoor.example", role: "Founder" },
};

function fixture(overrides: Partial<ApiContext> = {}) {
  const state: StoreState = emptyState();
  let writes = 0;
  const store: Store = openStoreOver(state, () => { writes += 1; });
  const ctx: ApiContext = {
    store: () => Promise.resolve(store),
    config: null,
    mcpToken: "platform-token",
    // Unset by default, with `local: true`: `pnpm serve` for development is the one place the
    // `/api/*` gate is allowed to stand open, and every store test below is that case.
    dashboardToken: undefined,
    // Likewise unset: no password door, and no studio for the gate screen to send a browser to.
    dashboardPassword: undefined,
    studioUrl: undefined,
    appId: undefined,
    local: true,
    ...overrides,
  };
  const call = (method: string, path: string, body: unknown = "", headers: Record<string, string> = {}) => {
    const [pathname = path, search = ""] = path.split("?");
    const req: ApiRequest = {
      method,
      path: pathname,
      query: new URLSearchParams(search),
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    };
    return handleRequest(req, ctx);
  };
  return { call, state, store, writes: () => writes };
}

const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

describe("the store routes", () => {
  it("answers the app's own rows, and a fresh document is empty", async () => {
    const { call } = fixture();
    expect(await call("GET", "/api/clients")).toEqual({ status: 200, body: [] });
    expect(await call("GET", "/api/posts")).toEqual({ status: 200, body: [] });
  });

  it("files a lead, persists it, and refuses one that is missing its contact", async () => {
    const { call, writes } = fixture();
    const created = await call("POST", "/api/leads", lead);
    expect(created.status).toBe(201);
    // Two: the rate window's count and the row itself. Both are the same document, so the deployed
    // entry still writes it back once — `save()` there only marks the request dirty.
    expect(writes()).toBe(2);
    expect((await call("GET", "/api/clients")).body).toHaveLength(1);

    expect(await call("POST", "/api/leads", { name: "x" })).toEqual({
      status: 400,
      body: { error: "name, domain and contact {name, email} are required" },
    });
    // A body that is not JSON at all is a validation error, never a 502.
    expect((await call("POST", "/api/leads", "{oops")).status).toBe(400);
  });

  it("says a lead came from the site, whatever the body claims; only a signed-in operator's form says manual", async () => {
    const { call, state } = fixture({ dashboardToken: "dash-secret", local: false });
    const claimed = { ...lead, source: "referral", referredBy: "cli_victim" };
    await call("POST", "/api/leads", claimed);
    expect(state.clients.at(-1)).toMatchObject({ source: "site" });
    expect(state.clients.at(-1)?.referredBy).toBeUndefined();

    // An anonymous `manual` is a visitor's claim too.
    await call("POST", "/api/leads", { ...lead, contact: { ...lead.contact, email: "b@summitoutdoor.example" }, source: "manual" });
    expect(state.clients.at(-1)).toMatchObject({ source: "site" });

    await call("POST", "/api/leads", { ...lead, contact: { ...lead.contact, email: "c@summitoutdoor.example" }, source: "manual" }, { authorization: "Bearer dash-secret" });
    expect(state.clients.at(-1)).toMatchObject({ source: "manual" });
  });

  it("files a lead that came through a client's referral link as that client's referral, and a wrong code as a site lead", async () => {
    // A deployed app, so the caller is a visitor and not the open local gate.
    const { call, state, store } = fixture({ dashboardToken: "dash-secret", local: false });
    const referrer = store.createLead({ ...lead, name: "Acme Dental", domain: "acmedental.example", contact: { ...lead.contact, email: "o@acmedental.example" } });
    store.onboardClient(referrer.id);
    const code = store.referralCode(referrer.id)!;

    // A visitor's reply is the id alone either way, so it does not tell a good code from a bad one.
    const sent = await call("POST", "/api/leads", { ...lead, ref: code });
    expect(state.clients.at(-1)).toMatchObject({ source: "referral", referredBy: referrer.id });
    expect(sent.body).toEqual({ id: state.clients.at(-1)!.id });
    expect(state.clients.at(-1)).not.toHaveProperty("ref");

    await call("POST", "/api/leads", { ...lead, contact: { ...lead.contact, email: "x@summitoutdoor.example" }, ref: "not-a-code" });
    expect(state.clients.at(-1)).toMatchObject({ source: "site" });
    expect(state.clients.at(-1)?.referredBy).toBeUndefined();
  });

  it("puts a referral-link lead through the same rate limit as every other public lead", async () => {
    const { call, store } = fixture();
    const referrer = store.createLead({ ...lead, name: "Acme Dental", domain: "acmedental.example", contact: { ...lead.contact, email: "o@acmedental.example" } });
    store.onboardClient(referrer.id);
    const ref = store.referralCode(referrer.id)!;
    for (let i = 0; i < LEADS_PER_WINDOW; i += 1) {
      await call("POST", "/api/leads", { ...lead, contact: { ...lead.contact, email: `r${i}@summitoutdoor.example` }, ref });
    }
    expect((await call("POST", "/api/leads", { ...lead, contact: { ...lead.contact, email: "late@summitoutdoor.example" }, ref })).status).toBe(429);
  });

  it("stores only the form's fields, and gives a visitor the lead's id rather than the CRM row", async () => {
    const { call, state } = fixture({ dashboardToken: "dash-secret", local: false });
    const posted = await call("POST", "/api/leads", { ...lead, extra: "x", contact: { ...lead.contact, blob: "y".repeat(5000) } });
    expect(posted.status).toBe(201);
    const row = state.clients.at(-1)!;
    expect(posted.body).toEqual({ id: row.id });
    expect(row.contact).toEqual(lead.contact);
    expect(row).not.toHaveProperty("extra");
    // The dedupe reply is the id too: it never shows a visitor the agency's notes on that lead.
    row.notes.push("internal: budget is tight");
    expect(await call("POST", "/api/leads", lead)).toEqual({ status: 200, body: { id: row.id } });
    // The signed-in operator's form still gets the full row.
    expect((await call("POST", "/api/leads", lead, { authorization: "Bearer dash-secret" })).body).toMatchObject({ id: row.id, notes: ["internal: budget is tight"] });
  });

  it("also notifies the agency inbox after a public lead is safely in the CRM", async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        { id: "eml_1", address: "hello@founderframehq.com" },
        { id: "eml_2", address: "leads@founderframehq.com" },
      ] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    vi.stubGlobal("fetch", upstream);
    const { call, store } = fixture({
      config: { baseUrl: "https://api.example", apiKey: "secret", identityId: "idn_1", project: "agency" },
    });
    store.updateSite({ company: "Founder Frame", contact: { ...store.site().contact, email: "hello@founderframehq.com" } });

    expect((await call("POST", "/api/leads", lead)).status).toBe(201);
    expect(store.read().clients).toHaveLength(1);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls[0]?.[0]).toBe("https://api.example/v1/identities/idn_1/emails?limit=100");
    expect(upstream.mock.calls[1]?.[0]).toBe("https://api.example/v1/identities/idn_1/emails/eml_1/send");
    const init = upstream.mock.calls[1]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      to: ["leads@founderframehq.com"],
      subject: "New Founder Frame inquiry: Summit Outdoor Co",
    });

    // A repeated form post returns the existing lead and does not send another notification.
    expect((await call("POST", "/api/leads", lead)).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("bounds what the anonymous form may write: one open row per contact, a cap on open leads, a size on fields", async () => {
    const { call, writes, store } = fixture();
    expect((await call("POST", "/api/leads", lead)).status).toBe(201);
    // The same contact again, however it is cased, is the row already filed — not a second write.
    const again = await call("POST", "/api/leads", { ...lead, contact: { ...lead.contact, email: "Jordan@SummitOutdoor.example " } });
    expect(again.status).toBe(200);
    // Still the two the first lead cost: a repeat is neither a row nor a count against the window.
    expect(writes()).toBe(2);
    // Once the contact is worked past "lead" the address may file a new one.
    store.advanceClient((again.body as { id: string }).id);
    expect((await call("POST", "/api/leads", lead)).status).toBe(201);

    expect((await call("POST", "/api/leads", { ...lead, note: "x".repeat(2001) })).status).toBe(400);
    expect((await call("POST", "/api/leads", { ...lead, services: Array.from({ length: 11 }, () => "seo") })).status).toBe(400);

    for (let i = store.read().clients.filter((c) => c.stage === "lead").length; i < OPEN_LEADS_CAP; i += 1) {
      store.createLead({ ...lead, domain: `d${i}.example`, contact: { ...lead.contact, email: `p${i}@d${i}.example` } });
    }
    const full = await call("POST", "/api/leads", { ...lead, domain: "late.example", contact: { ...lead.contact, email: "late@late.example" } });
    expect(full.status).toBe(429);
    expect(full.headers?.["retry-after"]).toBe("86400");
    expect(store.read().clients).toHaveLength(OPEN_LEADS_CAP + 1);
  });

  /**
   * The cap alone bounds spend, not availability: 200 scripted pairs used to fill the inbox in one
   * burst and every real lead for the next twenty-four hours was answered `429`. No agent turn
   * fires on a lead, so what that costs is business, not money — which is why the answer is a rate
   * and its `retry-after` is an hour, not the inbox-full day.
   */
  it("rate-limits the anonymous form, so a burst cannot hold the inbox shut for a day", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const { call, store } = fixture();
      const file = (i: number) =>
        call("POST", "/api/leads", { ...lead, domain: `d${i}.example`, contact: { ...lead.contact, email: `p${i}@d${i}.example` } });
      for (let i = 0; i < LEADS_PER_WINDOW; i += 1) expect((await file(i)).status).toBe(201);

      const limited = await file(LEADS_PER_WINDOW);
      expect(limited.status).toBe(429);
      expect(limited.headers?.["retry-after"]).toBe(String(LEAD_WINDOW_MS / 1000));
      expect(store.read().clients).toHaveLength(LEADS_PER_WINDOW);

      // The next window admits again — the form is shut for an hour, never for the day.
      vi.setSystemTime(LEAD_WINDOW_MS);
      expect((await file(LEADS_PER_WINDOW)).status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances, onboards, and refuses to onboard a churned client", async () => {
    const { call, store } = fixture();
    const client = store.createLead(lead);
    expect(((await call("POST", `/api/clients/${client.id}/advance`)).body as { stage: string }).stage).toBe("proposal");
    const onboarded = await call("POST", `/api/clients/${client.id}/onboard`);
    expect(onboarded.status).toBe(200);
    // No key on this server, so no crew is provisioned and the report says so rather than lying.
    expect(onboarded.body).toMatchObject({ agents: null, client: { stage: "active" } });

    client.stage = "churned";
    expect(await call("POST", `/api/clients/${client.id}/onboard`)).toEqual({
      status: 409,
      body: { error: "a churned client cannot be onboarded" },
    });
    expect(await call("POST", "/api/clients/cli_missing/advance")).toEqual({
      status: 404,
      body: { error: "no such client" },
    });
  });

  it("patches a post, and says which of the two things it needed", async () => {
    const { call, store } = fixture();
    const client = store.createLead(lead);
    const post = store.createDraftPost({
      clientId: client.id, title: "t", summary: "s", body: "A complete, reviewed article.", kind: "article", channel: "blog", scheduledFor: "2026-01-05",
    })!;
    expect(((await call("PATCH", `/api/posts/${post.id}`, { status: "approved" })).body as { status: string }).status).toBe("approved");
    expect(await call("PATCH", `/api/posts/${post.id}`, {})).toEqual({
      status: 400,
      body: { error: "status or scheduledFor is required" },
    });
    expect(await call("PATCH", "/api/posts/post_missing", { status: "ready" })).toEqual({
      status: 404,
      body: { error: "no such post" },
    });
    // Without a key the publish is skipped, but the queue still moves.
    expect(((await call("POST", `/api/posts/${post.id}/post-now`)).body as { status: string }).status).toBe("posted");
  });

  it("publishes a blog article to the public feed without calling the social publisher", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const { call, store } = fixture({
      config: { baseUrl: "https://api.example", apiKey: "secret", identityId: "idn_1", project: "agency" },
    });
    const client = store.createLead(lead);
    const draft = store.createDraftPost({
      clientId: client.id, title: "GEO basics", summary: "A practical definition", body: "Full article",
      kind: "article", channel: "blog", scheduledFor: "2026-09-26",
    })!;
    expect((await call("GET", "/api/blog")).body).toEqual([]);
    expect((await call("POST", `/api/posts/${draft.id}/post-now`)).status).toBe(200);
    expect(await call("GET", "/api/blog")).toMatchObject({
      status: 200,
      body: [{ id: draft.id, title: "GEO basics", body: "Full article" }],
      headers: { "cache-control": "public, max-age=60" },
    });
    expect(upstream).not.toHaveBeenCalled();

    const unsafe = store.createDraftPost({
      clientId: client.id, title: "Industry benchmark", summary: "A 35% result with no source",
      body: "Our clients get this result in the first two weeks.", kind: "article", channel: "blog", scheduledFor: "2026-09-27",
    })!;
    expect(await call("POST", `/api/posts/${unsafe.id}/post-now`)).toEqual({
      status: 409,
      body: { error: expect.stringContaining("publication blocked") },
    });
  });

  it("names the method as the problem when the path exists but the verb does not", async () => {
    const { call } = fixture();
    for (const [method, path] of [["POST", "/api/clients"], ["GET", "/api/leads"], ["GET", "/api/posts/post_1"]] as const) {
      expect(await call(method, path)).toEqual({ status: 405, body: { error: "method not allowed" } });
    }
  });
});

describe("public discovery documents", () => {
  it("serves crawl directives, dynamic metadata, permanent articles, a complete sitemap, and an agency-readable llms file", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    const shell = '<!doctype html><html><head><title>Agency services</title><meta name="description" content="generic" /></head><body><div id="root"></div><script type="module" src="/assets/site.js"></script></body></html>';
    const { call, store } = fixture({ publicShell: () => Promise.resolve(shell) });
    store.updateSite({ company: "Founder Frame", contact: { ...store.site().contact, email: "hello@founderframehq.com" } });
    const company = store.createLead({ name: "Founder Frame", domain: "", contact: { name: "", email: "", role: "" } });
    const live = store.createDraftPost({ clientId: company.id, title: "A safer <title>", summary: "Useful & specific", body: "## Answer\n\nA **clear** answer.\n\n- First", kind: "article", channel: "blog", scheduledFor: "2026-10-04" })!;
    store.updatePost(live.id, { status: "posted" });
    const future = store.createDraftPost({ clientId: company.id, title: "Future draft", summary: "Not public", body: "Wait", kind: "article", channel: "blog", scheduledFor: "2026-10-06" })!;
    store.updatePost(future.id, { status: "posted" });
    const headers = { host: "founderframehq.com", "x-forwarded-proto": "https" };

    const home = await call("GET", "/", "", headers);
    expect(home.text).toContain("<title>Founder Frame —");
    expect(home.text).toContain('<link rel="canonical" href="https://founderframehq.com/"');

    const robots = await call("GET", "/robots.txt", "", headers);
    expect(robots).toMatchObject({ status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    expect(robots.text).toContain("Sitemap: https://founderframehq.com/sitemap.xml");
    expect(robots.text).toContain("Disallow: /app/");

    const sitemap = await call("GET", "/sitemap.xml", "", headers);
    expect(sitemap).toMatchObject({ status: 200, headers: { "content-type": "application/xml; charset=utf-8" } });
    expect(sitemap.text).toContain("<loc>https://founderframehq.com/</loc>");
    expect(sitemap.text).toContain(`<loc>https://founderframehq.com/blog/${live.id}</loc>`);
    expect(sitemap.text).not.toContain(future.id);

    const page = await call("GET", `/blog/${live.id}`, "", headers);
    expect(page).toMatchObject({ status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    expect(page.text).toContain("A safer &lt;title&gt;");
    expect(page.text).toContain(`<link rel="canonical" href="https://founderframehq.com/blog/${live.id}"`);
    expect(page.text).toContain("<h2>Answer</h2>");
    expect(page.text).not.toContain('src="/assets/site.js"');
    expect((await call("GET", `/blog/${future.id}`, "", headers)).status).toBe(404);

    const feed = await call("GET", "/api/blog", "", headers);
    expect(feed.body).toMatchObject([{ id: live.id, path: `/blog/${live.id}` }]);
    expect(JSON.stringify(feed.body)).not.toContain(future.id);

    const llms = await call("GET", "/llms.txt", "", headers);
    expect(llms).toMatchObject({ status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    expect(llms.text).toContain("# Founder Frame");
    expect(llms.text).toContain("mailto:hello@founderframehq.com");
    expect(llms.text).toContain(`https://founderframehq.com/blog/${live.id}`);
    vi.useRealTimers();
  });
});

describe("/mcp", () => {
  it("is the same document as /api/clients — an agent's write is what the UI reads", async () => {
    const { call } = fixture();
    const created = await call("POST", "/mcp", rpc("tools/call", {
      name: "create_lead",
      arguments: { name: "Bluefin", domain: "bluefin.example", contact_name: "Sam", contact_email: "sam@bluefin.example", contact_role: "VP" },
    }), { authorization: "Bearer platform-token" });
    expect(created.status).toBe(200);
    expect((await call("GET", "/api/clients")).body).toHaveLength(1);
  });

  it("refuses a missing or wrong bearer, and anything but POST", async () => {
    const { call } = fixture();
    expect(await call("POST", "/mcp", rpc("tools/list"))).toEqual({
      status: 401, body: { error: "missing or invalid bearer token" },
    });
    expect(await call("POST", "/mcp", rpc("tools/list"), { authorization: "Bearer nope" })).toMatchObject({ status: 401 });
    expect(await call("GET", "/mcp")).toEqual({ status: 405, body: { error: "POST only" } });
  });

  it("lets a bare GET fail with the store while the database is unreachable", async () => {
    const down = new Error("connect ECONNREFUSED");
    const { call } = fixture({ store: () => Promise.reject(down) });
    await expect(call("GET", "/mcp")).rejects.toBe(down);
  });

  it("accepts a token minted from Settings and answers a notification with a bodiless 202", async () => {
    const { call, store } = fixture();
    store.addMcpToken("desktop", hashToken("mcp_local"));
    const listed = await call("POST", "/mcp", rpc("tools/list"), { authorization: "Bearer mcp_local" });
    expect(listed.status).toBe(200);
    expect(await call("POST", "/mcp", rpc("notifications/initialized"), { authorization: "Bearer mcp_local" }))
      .toEqual({ status: 202 });
  });
});

describe("/api/mcp/tokens is local-only", () => {
  it("mints, lists and revokes on a local server", async () => {
    const { call } = fixture();
    expect(await call("GET", "/api/mcp/tokens")).toEqual({ status: 200, body: [] });
    const minted = await call("POST", "/api/mcp/tokens", { name: "desktop" });
    expect(minted.status).toBe(201);
    const { id, token } = minted.body as { id: string; token: string };
    expect(token).toMatch(/^mcp_/);
    expect((await call("GET", "/api/mcp/tokens")).body).toHaveLength(1);
    // The hash is kept, never the token: the list cannot hand it back.
    expect(JSON.stringify((await call("GET", "/api/mcp/tokens")).body)).not.toContain(token);
    expect(await call("DELETE", `/api/mcp/tokens/${id}`)).toEqual({ status: 200, body: { ok: true } });
    expect(await call("DELETE", `/api/mcp/tokens/${id}`)).toEqual({ status: 404, body: { error: "no such token" } });
    expect(await call("POST", "/api/mcp/tokens", {})).toEqual({ status: 400, body: { error: "name is required" } });
  });

  it("does not exist on the deployment, where an unauthenticated mint would hand out the agency", async () => {
    const { call } = fixture({ local: false, dashboardToken: "dash" });
    for (const [method, path] of [["GET", "/api/mcp/tokens"], ["POST", "/api/mcp/tokens"], ["DELETE", "/api/mcp/tokens/tok_1"]] as const) {
      expect(await call(method, path, { name: "x" }, { authorization: "Bearer dash" }))
        .toEqual({ status: 404, body: { error: "no such route" } });
    }
  });
});

/**
 * The whole reason this gate exists: the deployed dashboard was a public URL that answered every
 * `/api/*` route to anonymous curl — the CRM with its contacts' email addresses, the org's agent
 * roster with its system prompts, the content queue as a writable surface, and the session relay.
 */
describe("the /api/* gate", () => {
  const deployed = { local: false, dashboardToken: "dash" };
  const bearer = { authorization: "Bearer dash" };

  it("refuses an anonymous read of the CRM, and a wrong token, and admits the right one", async () => {
    const { call, store } = fixture(deployed);
    store.createLead(lead);
    const unauthenticated = await call("GET", "/api/clients");
    expect(unauthenticated).toEqual({ status: 401, body: { error: "missing or invalid access token" } });
    // Not one row of it, and not the contact's email address, leaves the server.
    expect(JSON.stringify(unauthenticated.body)).not.toContain("jordan@summitoutdoor.example");

    expect(await call("GET", "/api/clients", "", { authorization: "Bearer wrong" })).toMatchObject({ status: 401 });
    // A bare token without the scheme is not a credential either.
    expect(await call("GET", "/api/clients", "", { authorization: "dash" })).toMatchObject({ status: 401 });

    const allowed = await call("GET", "/api/clients", "", bearer);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toHaveLength(1);
  });

  /**
   * The public site's routes stand open on purpose: a visitor holds no bearer, the copy is what
   * the page shows anyway, and the contact form has to land as a lead or the site sells nothing.
   * Neither reads a row back — the lead is answered as created, and the CRM stays behind the gate.
   */
  it("leaves the site's copy and its contact form open to a visitor, and nothing else", async () => {
    const { call, store } = fixture(deployed);
    const copy = await call("GET", "/api/site");
    expect(copy.status).toBe(200);
    expect(copy.headers).toEqual({ "cache-control": "public, max-age=60" });
    expect((copy.body as { hero: { title: string } }).hero.title).toBeTruthy();
    store.updateSite({ company: "Acme Search", contact: { ...store.site().contact, email: "hello@acme.com" } });
    expect((await call("GET", "/api/site")).body).toMatchObject({ company: "Acme Search", contact: { email: "hello@acme.com" } });
    store.updateSite({ pricing: { ...store.site().pricing, subtitle: "$2,500 per month" } });
    expect((await call("GET", "/api/site")).body).toMatchObject({ company: "Your agency", contact: { email: "" } });
    expect(await call("PATCH", "/api/site", {})).toMatchObject({ status: 405 });
    expect(await call("GET", "/api/blog")).toMatchObject({ status: 200, body: [] });

    expect((await call("POST", "/api/leads", lead)).status).toBe(201);
    expect(await call("GET", "/api/leads")).toMatchObject({ status: 405 });
    // The row it made is still behind the gate.
    expect(await call("GET", "/api/clients")).toMatchObject({ status: 401 });
  });

  it("gates the writes too — the queue, the pipeline and a billable session alike", async () => {
    const { call, store, writes } = fixture(deployed);
    const client = store.createLead(lead);
    const before = writes();
    for (const [method, path] of [
      ["POST", `/api/clients/${client.id}/advance`],
      ["POST", `/api/clients/${client.id}/onboard`], ["PATCH", "/api/posts/post_1"],
      ["POST", "/api/posts/post_1/post-now"], ["POST", "/api/chat"], ["GET", "/api/chat/ses_1/stream"],
      ["GET", "/api/agents"], ["GET", "/api/social/accounts"],
    ] as const) {
      expect(await call(method, path, lead)).toMatchObject({ status: 401 });
    }
    // Nothing was written on the way to being refused.
    expect(writes()).toBe(before);
  });

  it("answers 503 on a deployment with no token configured — a missing credential is never open", async () => {
    const { call } = fixture({ local: false, dashboardToken: undefined });
    expect(await call("GET", "/api/clients")).toEqual({
      status: 503, body: { error: "not configured — set DASHBOARD_TOKEN" },
    });
    // An empty string is unset, not a token every caller can guess.
    expect(await call("GET", "/api/clients", "", { authorization: "Bearer " })).toMatchObject({ status: 503 });
    expect((await fixture({ local: false, dashboardToken: "" }).call("GET", "/api/posts")).status).toBe(503);
  });

  it("hides which routes exist, and leaves /mcp on its own separate bearer", async () => {
    const { call } = fixture(deployed);
    // 401 before the route table: an anonymous caller cannot even map the surface.
    expect(await call("GET", "/api/nothing")).toMatchObject({ status: 401 });
    // The agents' credential is not the operator's, and neither opens the other's door.
    expect(await call("GET", "/api/clients", "", { authorization: "Bearer platform-token" })).toMatchObject({ status: 401 });
    expect(await call("POST", "/mcp", rpc("tools/list"), { authorization: "Bearer platform-token" })).toMatchObject({ status: 200 });
    expect(await call("POST", "/mcp", rpc("tools/list"), bearer)).toMatchObject({ status: 401 });
  });

  it("lets a genuinely local pnpm serve through with nothing set, and never a deployment", async () => {
    expect((await fixture({ local: true, dashboardToken: undefined }).call("GET", "/api/clients")).status).toBe(200);
    // Local with a token set still enforces it — configuring one is asking for it to be checked.
    expect(await fixture({ local: true, dashboardToken: "dash" }).call("GET", "/api/clients")).toMatchObject({ status: 401 });
  });

  /**
   * THE ONE DOOR THROUGH THE GATE (`canonical-spec §29.7`).
   *
   * `DASHBOARD_TOKEN` is generated by the platform so that nobody has to invent one, and no route
   * anywhere returns an app secret — so there is no value for an operator to be asked for and none
   * for them to paste. The studio posts a two-minute ticket to `/api/enter` instead, and that route
   * trades it for the cookie the browser then carries on its own.
   */
  describe("the entry ticket is the way in, and the ticket is not the token", () => {
    const ticket = (expiresAt: number, token = "dash") =>
      `${expiresAt}.${createHmac("sha256", token).update(`vetta.app-entry.v1:${expiresAt}`).digest("base64url")}`;

    const enter = (body: string) =>
      fixture(deployed).call("POST", "/api/enter", body, { "content-type": "application/x-www-form-urlencoded" });

    it("trades a live ticket for an HttpOnly cookie and a redirect, and answers no body at all", async () => {
      const reply = await enter(new URLSearchParams({ ticket: ticket(Date.now() + 60_000) }).toString());
      expect(reply.status).toBe(303);
      expect(reply.body).toBeUndefined();
      // To the operator UI, which lives under `/app`; `/` is the public site and needs no cookie.
      expect(reply.headers?.["location"]).toBe("/app");
      // Deployed, the dashboard is also framed by the studio: a `Lax` cookie never reaches a framed
      // cross-site document, so it is `None` and partitioned per top-level site (CHIPS). Two headers,
      // not one joined: the first expires the pre-partitioning cookie a returning browser still holds,
      // and the session cookie comes SECOND — a browser without CHIPS ignores `Partitioned`, sees one
      // cookie named twice, and keeps the last header; the other order signed it straight out again.
      expect(reply.headers?.["set-cookie"]).toEqual([
        "dashboard_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax; Secure",
        `dashboard_session=dash; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${30 * 24 * 60 * 60}`,
      ]);
    });

    it("keeps a laptop's cookie Lax and not Secure: Partitioned needs Secure, and there is no frame", async () => {
      const reply = await fixture({ local: true, dashboardToken: "dash" })
        .call("POST", "/api/enter", new URLSearchParams({ ticket: ticket(Date.now() + 60_000) }).toString(), { "content-type": "application/x-www-form-urlencoded" });
      // One header, a string: a laptop never held the deployed cookie, so there is nothing to expire.
      expect(reply.headers?.["set-cookie"]).toBe(`dashboard_session=dash; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`);
    });

    /**
     * A browser that signed in before the cookie was partitioned keeps the old `Lax` cookie beside
     * the new one — same name, same path, so the jar sends both — and if the token has since been
     * rotated, the first value the server looked at was the stale one. Every value is tried, and a
     * request whose values are all stale is told to drop the old cookie.
     */
    describe("a legacy cookie beside the live one", () => {
      const both = "dashboard_session=stale-rotated-token; dashboard_session=dash";

      it("is in when ANY dashboard_session value is the token, whichever the browser sent first", async () => {
        const { call, store } = fixture(deployed);
        expect((await call("GET", "/api/clients", "", { cookie: both })).status).toBe(200);
        expect((await call("GET", "/api/clients", "", { cookie: "dashboard_session=dash; dashboard_session=stale" })).status).toBe(200);
        expect((await call("GET", "/api/session", "", { cookie: both })).body).toMatchObject({ authenticated: true });
        // The guard still applies to what the live value authenticates.
        const client = store.createLead(lead);
        expect((await call("POST", `/api/clients/${client.id}/advance`, "", { cookie: both, "sec-fetch-site": "same-origin" })).status).toBe(200);
        expect((await call("POST", `/api/clients/${client.id}/advance`, "", { cookie: both, "sec-fetch-site": "cross-site" })).status).toBe(403);
      });

      it("answers 401 and expires the legacy cookie when no value is the token", async () => {
        const reply = await fixture(deployed).call("GET", "/api/clients", "", { cookie: "dashboard_session=stale; dashboard_session=older" });
        expect(reply).toEqual({
          status: 401,
          body: { error: "missing or invalid access token" },
          headers: { "set-cookie": "dashboard_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax; Secure" },
        });
        // A single stale cookie earns the same header; a laptop's spells it without `Secure`.
        expect((await fixture(deployed).call("GET", "/api/clients", "", { cookie: "dashboard_session=nope" })).headers)
          .toEqual({ "set-cookie": "dashboard_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax; Secure" });
        expect((await fixture({ local: true, dashboardToken: "dash" }).call("GET", "/api/clients", "", { cookie: "dashboard_session=nope" })).headers)
          .toEqual({ "set-cookie": "dashboard_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax" });
        // No cookie at all is the plain 401: there is nothing to expire, and a bearer caller gets no jar.
        expect((await fixture(deployed).call("GET", "/api/clients")).headers).toBeUndefined();
        // `/api/session` reports the verdict and, as ever, sets nothing.
        const session = await fixture(deployed).call("GET", "/api/session", "", { cookie: "dashboard_session=stale" });
        expect(session.body).toMatchObject({ authenticated: false });
        expect(session.headers?.["set-cookie"]).toBeUndefined();
      });
    });

    it("takes the ticket from a JSON body too, because the host parses a form for us", async () => {
      expect((await enter(JSON.stringify({ ticket: ticket(Date.now() + 60_000) }))).status).toBe(303);
    });

    const badTickets = () => [
      ticket(Date.now() - 1),
      ticket(Date.now() + 60_000, "some-other-app-token"),
      `${Date.now() + 60_000}.not-a-mac`,
      "dash",
      "",
    ];

    it("refuses an expired ticket, a forged one and a bare token, and sets no cookie", async () => {
      for (const bad of badTickets()) {
        // A JSON caller gets the 403 and the sentence, as ever.
        const reply = await fixture(deployed).call("POST", "/api/enter", { ticket: bad });
        expect(reply.status, bad).toBe(403);
        expect(reply.headers?.["set-cookie"]).toBeUndefined();
      }
    });

    it("sends a refused form back to the gate screen with `entry=denied`, and still no cookie", async () => {
      // The studio's handoff and the gate screen's own form are top-level navigations: a 403 JSON
      // body would be the whole page, so a refused form lands on the sign-in screen with a sentence.
      for (const bad of badTickets()) {
        const reply = await enter(new URLSearchParams({ ticket: bad }).toString());
        expect(reply, bad).toEqual({ status: 303, headers: { location: "/app?entry=denied" } });
      }
    });

    it("opens every gated route for the cookie it set, with no header anywhere", async () => {
      const { call } = fixture(deployed);
      expect((await call("GET", "/api/clients", "", { cookie: "other=1; dashboard_session=dash" })).status).toBe(200);
      // A cookie that is not the token is still refused: the cookie is checked, not merely present.
      expect((await call("GET", "/api/clients", "", { cookie: "dashboard_session=nope" })).status).toBe(401);
    });

    /**
     * A `SameSite=None` cookie rides on cross-site requests too, which is what `Lax` used to
     * forbid. So a WRITE the cookie authenticates must come from this dashboard's own pages — framed
     * by the studio or not, the request is still same-origin to its own API.
     */
    describe("a cookie-authenticated write must be the dashboard's own", () => {
      const cookie = { cookie: "dashboard_session=dash" };
      /** A gated write: advancing a lead. Answers 200 with the advanced row, or is refused. */
      const advance = async (headers: Record<string, string>) => {
        const { call, store } = fixture(deployed);
        const client = store.createLead(lead);
        const reply = await call("POST", `/api/clients/${client.id}/advance`, "", headers);
        return { reply, stage: store.read().clients[0]?.stage };
      };

      it("passes the framed dashboard's own fetch, and the address bar", async () => {
        expect((await advance({ ...cookie, "sec-fetch-site": "same-origin" })).reply.status).toBe(200);
        expect((await advance({ ...cookie, "sec-fetch-site": "none" })).reply.status).toBe(200);
        // A browser too old for `sec-fetch-site` must at least name this host as its origin.
        expect((await advance({ ...cookie, host: "agency.example", origin: "https://agency.example" })).reply.status).toBe(200);
      });

      it("refuses a cross-site POST that arrived with the cookie, with a sentence and no write", async () => {
        for (const headers of [
          { ...cookie, "sec-fetch-site": "cross-site" },
          { ...cookie, "sec-fetch-site": "same-site" },
          { ...cookie, host: "agency.example", origin: "https://evil.example" },
          { ...cookie, host: "agency.example", origin: "not a url" },
          { ...cookie, host: "agency.example" },
          cookie,
        ]) {
          const { reply, stage } = await advance(headers);
          expect(reply, JSON.stringify(headers)).toEqual({ status: 403, body: { error: "cross-site request refused" } });
          expect(stage, JSON.stringify(headers)).toBe("lead");
        }
        const { call } = fixture(deployed);
        for (const method of ["PUT", "PATCH", "DELETE"]) {
          expect((await call(method, "/api/posts/post_1", {}, { ...cookie, "sec-fetch-site": "cross-site" })).status, method).toBe(403);
        }
      });

      it("treats every method but GET and HEAD as a write — a method outside any list is not a way round the guard", async () => {
        const { call } = fixture(deployed);
        for (const method of ["OPTIONS", "PROPFIND", "QUERY"]) {
          const crossSite = { ...cookie, host: "agency.example", origin: "https://evil.example" };
          expect(await call(method, "/api/agents", "", { ...cookie, "sec-fetch-site": "cross-site" }), method)
            .toEqual({ status: 403, body: { error: "cross-site request refused" } });
          expect((await call(method, "/api/agents", "", crossSite)).status, method).toBe(403);
          // Same-origin, the method reaches the route table and is judged there, not here.
          expect((await call(method, "/api/agents", "", { ...cookie, "sec-fetch-site": "same-origin" })).status, method).not.toBe(403);
        }
        expect((await call("HEAD", "/api/clients", "", { ...cookie, "sec-fetch-site": "cross-site" })).status).not.toBe(403);
      });

      it("asks nothing of a bearer, a read, or /api/enter — none of them is a cookie another site could spend", async () => {
        expect((await advance({ ...bearer, "sec-fetch-site": "cross-site" })).reply.status).toBe(200);
        const { call } = fixture(deployed);
        expect((await call("GET", "/api/clients", "", { ...cookie, "sec-fetch-site": "cross-site" })).status).toBe(200);
        expect((await call("GET", "/api/clients", "", cookie)).status).toBe(200);
        const handoff = await call("POST", "/api/enter", new URLSearchParams({ ticket: ticket(Date.now() + 60_000) }).toString(), {
          ...cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site",
        });
        expect(handoff.status).toBe(303);
        // The public site's contact form is not gated, so it is not this guard's either.
        expect((await call("POST", "/api/leads", lead, { ...cookie, "sec-fetch-site": "cross-site" })).status).toBe(201);
        // The wrong cookie is still the wrong cookie, before any question of origin.
        expect((await advance({ cookie: "dashboard_session=nope", "sec-fetch-site": "same-origin" })).reply.status).toBe(401);
      });
    });

    it("is the only /api route that runs before the gate, so it needs no credential to reach", async () => {
      expect((await enter("ticket=")).status).not.toBe(401);
    });
  });

  /**
   * THE SECOND DOOR: THE PASSWORD.
   *
   * The ticket needs a studio that can hand the browser back signed in; a colleague's browser, or
   * an operator signed out of the studio too, has none. `DASHBOARD_PASSWORD` is the one credential
   * the platform generates to be handed to a person (read off the studio's Access panel, audited),
   * and the gate screen posts it here as a plain form. It earns the identical cookie.
   */
  describe("the dashboard password is the other way in", () => {
    const withPassword = { ...deployed, dashboardPassword: "kq7m-x2rt-8bvn-pz4h" };
    const form = (fields: Record<string, string>) =>
      [new URLSearchParams(fields).toString(), { "content-type": "application/x-www-form-urlencoded" }] as const;

    it("trades the right password for the same cookie and the same redirect a ticket earns", async () => {
      const reply = await fixture(withPassword).call("POST", "/api/enter", ...form({ password: "kq7m-x2rt-8bvn-pz4h" }));
      expect(reply.status).toBe(303);
      expect(reply.body).toBeUndefined();
      expect(reply.headers?.["location"]).toBe("/app");
      // Expiring header first, session cookie second: the same order, for the same reason, as a ticket's.
      const [expiring, cookie] = reply.headers?.["set-cookie"] ?? [];
      // The cookie is the token, as for a ticket — never the password.
      expect(cookie).toContain("dashboard_session=dash");
      expect(cookie).not.toContain("kq7m");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure; SameSite=None; Partitioned");
      expect(expiring).toBe("dashboard_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax; Secure");
      // A JSON body works too, for the same reason the ticket's does.
      expect((await fixture(withPassword).call("POST", "/api/enter", { password: "kq7m-x2rt-8bvn-pz4h" })).status).toBe(303);
    });

    it("refuses a wrong password: back to the gate for a form, 403 for JSON, never a cookie", async () => {
      for (const wrong of ["kq7m-x2rt-8bvn-pz4H", "kq7m", "dash"]) {
        expect(await fixture(withPassword).call("POST", "/api/enter", ...form({ password: wrong })), wrong)
          .toEqual({ status: 303, headers: { location: "/app?entry=denied" } });
        const asJson = await fixture(withPassword).call("POST", "/api/enter", { password: wrong });
        expect(asJson, wrong).toEqual({ status: 403, body: { error: "that password did not check out" } });
      }
    });

    it("refuses every password when DASHBOARD_PASSWORD is unset — an absent door is not an open one", async () => {
      expect(await fixture(deployed).call("POST", "/api/enter", ...form({ password: "kq7m-x2rt-8bvn-pz4h" })))
        .toEqual({ status: 303, headers: { location: "/app?entry=denied" } });
      expect((await fixture(deployed).call("POST", "/api/enter", { password: "anything" })).status).toBe(403);
      // An empty password field is not a password: the body is read as a ticket, and there is none.
      expect((await fixture({ ...deployed, dashboardPassword: "" }).call("POST", "/api/enter", { password: "" })).status).toBe(403);
    });

    it("still needs the token, because the token is what the cookie carries", async () => {
      const reply = await fixture({ ...withPassword, dashboardToken: undefined }).call("POST", "/api/enter", { password: "kq7m-x2rt-8bvn-pz4h" });
      expect(reply).toMatchObject({ status: 503 });
    });
  });

  /**
   * WHAT THE GATE SCREEN ASKS FIRST. Ungated, cookie-free, and the same verdict the gate gives:
   * the screen renders nothing of the dashboard until this says `authenticated`.
   */
  describe("GET /api/session", () => {
    const studio = { ...deployed, studioUrl: "https://app.usenaive.ai/", appId: "app_123" };

    it("tells a signed-out browser which doors exist, and sets nothing", async () => {
      const reply = await fixture({ ...studio, dashboardPassword: "kq7m-x2rt-8bvn-pz4h" }).call("GET", "/api/session");
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({
        authenticated: false,
        studio_url: "https://app.usenaive.ai/apps/app_123/open",
        password_enabled: true,
      });
      expect(reply.headers?.["set-cookie"]).toBeUndefined();
      // Nothing secret rides along: not the token, not the password.
      expect(JSON.stringify(reply.body)).not.toMatch(/dash|kq7m/);
    });

    it("says authenticated for the cookie /api/enter set, and for the bearer — the gate's own check", async () => {
      const { call } = fixture(studio);
      expect((await call("GET", "/api/session", "", { cookie: "dashboard_session=dash" })).body).toMatchObject({ authenticated: true });
      expect((await call("GET", "/api/session", "", { authorization: "Bearer dash" })).body).toMatchObject({ authenticated: true });
      expect((await call("GET", "/api/session", "", { cookie: "dashboard_session=nope" })).body).toMatchObject({ authenticated: false });
      // A deployment with no token is closed, and says so the same way the gate does.
      expect((await fixture({ ...studio, dashboardToken: undefined }).call("GET", "/api/session")).body).toMatchObject({ authenticated: false });
      // A genuinely local `pnpm serve` with nothing set is in, because its gate stands open.
      expect((await fixture().call("GET", "/api/session")).body).toEqual({ authenticated: true, studio_url: null, password_enabled: false });
    });

    it("has no studio link unless both the studio and the app id are known, and no password door unless one is set", async () => {
      expect((await fixture(deployed).call("GET", "/api/session")).body).toEqual({ authenticated: false, studio_url: null, password_enabled: false });
      expect((await fixture({ ...deployed, studioUrl: "https://app.usenaive.ai" }).call("GET", "/api/session")).body).toMatchObject({ studio_url: null });
      expect((await fixture({ ...deployed, appId: "app_123" }).call("GET", "/api/session")).body).toMatchObject({ studio_url: null });
      expect((await fixture({ ...deployed, dashboardPassword: "" }).call("GET", "/api/session")).body).toMatchObject({ password_enabled: false });
    });

    it("is GET only, runs before the gate, and leaves every other route gated", async () => {
      const { call } = fixture(deployed);
      expect(await call("POST", "/api/session", {})).toMatchObject({ status: 405 });
      expect((await call("GET", "/api/session")).status).toBe(200);
      for (const path of ["/api/clients", "/api/posts", "/api/agents", "/api/sessions", "/api/nothing"]) {
        expect(await call("GET", path), path).toMatchObject({ status: 401 });
      }
    });
  });

  it("calls only a loopback peer local — `pnpm serve` binds every interface", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(address)).toBe(true);
    // A LAN peer and anything through a tunnel are not the developer this bypass is for, and an
    // unknown peer is not one either.
    for (const address of ["192.168.1.14", "10.0.0.7", "203.0.113.9", "::ffff:10.0.0.7", "", undefined]) {
      expect(isLoopback(address)).toBe(false);
    }
  });
});

describe("the platform routes", () => {
  const config = { baseUrl: "https://api.test", apiKey: "sk_test", identityId: "idn_1", project: "agency" };

  it("says the key is missing rather than swallowing it, and only for routes that need one", async () => {
    const { call } = fixture();
    expect(await call("GET", "/api/agents")).toEqual({
      status: 503, body: { error: "not configured — set NAIVE_API_KEY" },
    });
    expect(await call("GET", "/api/social/accounts")).toMatchObject({ status: 503 });
    // The store routes are the app's own database and keep working without any key at all.
    expect((await call("GET", "/api/clients")).status).toBe(200);
    expect(await call("GET", "/api/nothing")).toEqual({ status: 404, body: { error: "no such route" } });
  });

  it("proxies the agent roster with the key on the upstream request only", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "agt_1", name: "sales" }], has_more: false, next_cursor: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const { call } = fixture({ config });
    const reply = await call("GET", "/api/agents");
    expect(reply).toEqual({ status: 200, body: { data: [{ id: "agt_1", name: "sales" }], has_more: false, next_cursor: null } });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.test/v1/agents?limit=100", expect.objectContaining({ method: "GET" }));
    expect(JSON.stringify(reply.body)).not.toContain("sk_test");
  });

  /**
   * The platform pages at 20 and a real agency org has 600+ agents, so page one is not the roster:
   * `GET /api/agents` returned twenty rows and neither `sales` nor `client-manager` — the org's own
   * two agents — appeared in their own dashboard.
   */
  it("follows the cursor to the end of the roster, on the screen and for the agency chat", async () => {
    const pageOf = (rows: { id: string; name: string }[], next: string | null) =>
      new Response(JSON.stringify({ data: rows, has_more: next !== null, next_cursor: next }), { status: 200 });
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes("after=agt_20")
        ? pageOf([{ id: "agt_21", name: "sales" }, { id: "agt_22", name: "client-manager" }], null)
        : pageOf([{ id: "agt_20", name: "seo-writer--acme" }], "agt_20"));
    vi.stubGlobal("fetch", fetchImpl);
    const { call } = fixture({ config });

    const roster = (await call("GET", "/api/agents")).body as { data: { name: string }[] };
    expect(roster.data.map((a) => a.name)).toEqual(["seo-writer--acme", "sales", "client-manager"]);
    // 100 is the spec's ceiling, so the roster is read in as few round trips as the platform allows.
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.test/v1/agents?limit=100");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://api.test/v1/agents?limit=100&after=agt_20");

    // And the chat resolves `client-manager` off the second page instead of saying it does not exist.
    const created = await call("POST", "/api/chat", { message: "hi" });
    expect(created.status).not.toBe(503);
    const session = fetchImpl.mock.calls.find(([url]) => url.endsWith("/v1/sessions"));
    expect(JSON.parse(String(session?.[1]?.body))).toMatchObject({ agent_id: "agt_22" });
  });

  it("hands the session relay back as a stream instead of buffering it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("event: message.delta\ndata: {}\n\n", { status: 200 }),
    ));
    const { call } = fixture({ config });
    const reply = await call("GET", "/api/chat/ses_abc/stream");
    expect(reply.stream).toBeInstanceOf(Response);
    expect(reply.body).toBeUndefined();
  });

  /**
   * A tool held at `ask` parks the session with the blocked call in `pending_actions`, and until
   * this route existed the dashboard could not see one: the moment the whole approval gate exists
   * for reached the operator as silence, resolvable only from a terminal.
   */
  it("reads the sessions a parked approval lives in, and passes only the filters the platform declares", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const { call } = fixture({ config });
    expect((await call("GET", "/api/sessions?status=idle&agent_id=agt_1&secret=x")).status).toBe(200);
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1/sessions");
    expect([...url.searchParams]).toEqual([["limit", "100"], ["agent_id", "agt_1"], ["status", "idle"]]);
  });

  it("resolves a parked call, and reports what the platform answered rather than assuming", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "ses_1", pending_actions: [] }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const { call } = fixture({ config });
    const decided = { tool_call_id: "call_1", decision: "deny", reason: "not this client" };
    const reply = await call("POST", "/api/sessions/ses_1/tool_confirmations", decided);
    expect(reply).toEqual({ status: 202, body: { id: "ses_1", pending_actions: [] } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.test/v1/sessions/ses_1/tool_confirmations");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(decided);
  });

  it("reads what an agent has spent this period", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent_id: "agt_1", period: "day", spent_micro_usd: 1_250_000 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const { call } = fixture({ config });
    expect((await call("GET", "/api/agents/agt_1/spend")).body).toMatchObject({ spent_micro_usd: 1_250_000 });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.test/v1/agents/agt_1/spend");
  });

  /**
   * The home screen's context card: the setup answers live on the latest APPLIED install of this
   * project, so the route lists installs narrowed by project, picks the newest applied one, and
   * reads its context — the day-one lines ride along from that install's report.
   */
  it("reads this project's context from its latest applied install, and says when there is none", async () => {
    const installs = [
      { id: "bpi_old", status: "applied", applied_at: "2026-09-01T00:00:00Z", report: { intake: [] } },
      { id: "bpi_failed", status: "failed", applied_at: "2026-09-09T00:00:00Z", report: null },
      {
        id: "bpi_new", status: "applied", applied_at: "2026-09-08T00:00:00Z",
        report: {
          agents: [{ name: "sales", action: "created", id: "agt_1" }, { name: "site-builder", action: "refused", reason: "no host" }],
          intake: [{ name: "sales", action: "created", id: "ses_1" }, { name: "site-builder", action: "skipped", reason: "agent refused" }],
        },
      },
    ];
    const context = { object: "project_context", answers: [{ key: "offer", label: "What does your agency sell?", value: "Paid social" }] };
    const session = { id: "ses_1", status: "idle", stop_reason: "awaiting_approval", pending_actions: [{ tool_call_id: "c1" }] };
    const fetchImpl = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(new Response(JSON.stringify(
        url.includes("/context") ? context
        : url.endsWith("/v1/sessions/ses_1") ? session
        : { data: installs, has_more: false, next_cursor: null }), { status: 200 })));
    vi.stubGlobal("fetch", fetchImpl);
    const { call } = fixture({ config });
    const reply = await call("GET", "/api/context");
    expect(reply).toEqual({
      status: 200,
      body: {
        context,
        // The team is the agents the apply left standing — the refused one is not on it.
        team: [{ name: "sales", id: "agt_1" }],
        // Each opened intake is read by its own id, so it is found long after it left the recent list.
        intake: [
          { name: "sales", action: "created", id: "ses_1", session: { status: "idle", stop_reason: "awaiting_approval", waiting: true } },
          { name: "site-builder", action: "skipped", reason: "agent refused", session: null },
        ],
      },
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      expect.stringMatching(/^https:\/\/api\.test\/v1\/blueprints\/installs\?project=[\w-]+&limit=100$/),
      "https://api.test/v1/blueprints/installs/bpi_new/context",
      "https://api.test/v1/sessions/ses_1",
    ]);

    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null }), { status: 200 }));
    expect(await call("GET", "/api/context")).toEqual({ status: 404, body: { error: "no applied install for this project" } });
    // And without a key it is the same 503 as every platform-backed screen — "not configured", not an error.
    expect(await fixture().call("GET", "/api/context")).toMatchObject({ status: 503 });
  });

  it("answers 502 when the platform cannot be reached at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("econnrefused")));
    const { call } = fixture({ config });
    expect(await call("GET", "/api/agents")).toEqual({ status: 502, body: { error: "upstream unavailable" } });
  });
});

/**
 * `GET /api/files/:id` — the Studio screen's only way to a platform file. The browser never holds
 * the org's key, so the dashboard proxies the read — but only for an id a stored deliverable names,
 * behind the same gate as the queue itself.
 */
describe("the studio's file proxy", () => {
  const config = { baseUrl: "https://api.example", apiKey: "secret", identityId: "idn_1", project: "agency" };
  const studioPost = (store: Store, files: string[]) =>
    store.createDraftPost({ clientId: store.createLead({ name: "Acme", domain: "", contact: { name: "", email: "", role: "" } }).id,
      title: "Carafe", summary: "concept", kind: "concept", channel: "studio", scheduledFor: "2026-10-30", files })!;

  it("is behind the operator's gate like the queue", async () => {
    const { call, store } = fixture({ dashboardToken: "dash", local: false, config });
    studioPost(store, ["fil_glb1"]);
    expect(await call("GET", "/api/files/fil_glb1")).toMatchObject({ status: 401 });
    expect(await call("GET", "/api/files/fil_glb1/meta")).toMatchObject({ status: 401 });
  });

  it("serves only an id a deliverable names, and says not configured without a key", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const { call, store } = fixture({ config });
    studioPost(store, ["fil_glb1"]);
    expect(await call("GET", "/api/files/fil_other")).toEqual({ status: 404, body: { error: "no such file on a deliverable" } });
    expect(await call("GET", "/api/files/not-a-file")).toEqual({ status: 404, body: { error: "no such file on a deliverable" } });
    expect((await call("POST", "/api/files/fil_glb1")).status).toBe(405);
    expect(upstream).not.toHaveBeenCalled();

    const keyless = fixture();
    studioPost(keyless.store, ["fil_glb1"]);
    expect(await keyless.call("GET", "/api/files/fil_glb1")).toEqual({ status: 503, body: { error: "not configured — set NAIVE_API_KEY" } });
  });

  it("streams the platform's bytes with its type, and reads the name and type for the screen", async () => {
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
    const upstream = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(url.endsWith("?download=true")
      ? new Response(bytes, { status: 200, headers: { "content-type": "model/gltf-binary", "content-length": "4", "content-disposition": 'attachment; filename="carafe.glb"', "set-cookie": "x=1" } })
      : new Response(JSON.stringify({ id: "fil_glb1", object: "file", name: "carafe.glb", content_type: "model/gltf-binary", size_bytes: 4, session_id: "ses_1", sha256: "a".repeat(64) }), { status: 200 })));
    vi.stubGlobal("fetch", upstream);
    const { call, store } = fixture({ config });
    studioPost(store, ["fil_glb1"]);

    const reply = await call("GET", "/api/files/fil_glb1");
    expect(reply.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe("https://api.example/v1/files/fil_glb1?download=true");
    expect((upstream.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer secret" });
    expect(reply.headers).toEqual({
      "cache-control": "private, max-age=3600", "content-type": "model/gltf-binary", "content-length": "4",
      "content-disposition": 'attachment; filename="carafe.glb"',
    });
    expect(new Uint8Array(await reply.file!.arrayBuffer())).toEqual(bytes);
    expect(reply.body).toBeUndefined();

    expect(await call("GET", "/api/files/fil_glb1/meta")).toEqual({
      status: 200, body: { id: "fil_glb1", name: "carafe.glb", content_type: "model/gltf-binary", size_bytes: 4 },
    });
    expect(upstream.mock.calls[1]?.[0]).toBe("https://api.example/v1/files/fil_glb1");
  });

  it("passes a missing platform file on as 404 and anything else as 502", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { status: 404 })).mockResolvedValueOnce(new Response("{}", { status: 500 })));
    const { call, store } = fixture({ config });
    studioPost(store, ["fil_glb1"]);
    expect(await call("GET", "/api/files/fil_glb1")).toEqual({ status: 404, body: { error: "no such file" } });
    expect(await call("GET", "/api/files/fil_glb1")).toEqual({ status: 502, body: { error: "upstream unavailable" } });
  });

  it("approves a studio deliverable without posting it anywhere, and refuses to post one", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const { call, store } = fixture({ config });
    const post = studioPost(store, ["fil_glb1", "fil_png1"]);
    const approved = await call("PATCH", `/api/posts/${post.id}`, { status: "approved" });
    expect(approved).toMatchObject({ status: 200, body: { id: post.id, status: "approved", files: ["fil_glb1", "fil_png1"] } });
    const posted = await call("POST", `/api/posts/${post.id}/post-now`);
    expect(posted.status).toBe(409);
    expect(posted.body).toEqual({ error: expect.stringMatching(/studio deliverable is not posted anywhere/) });
    expect(store.read().posts.find((p) => p.id === post.id)?.status).toBe("approved");
    expect(upstream).not.toHaveBeenCalled();
  });
});
