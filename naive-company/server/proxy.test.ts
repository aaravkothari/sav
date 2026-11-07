import { describe, expect, it, vi } from "vitest";
import { ACTIVE_TEMPLATE, TEMPLATES } from "../templates/active";
import { AGENCY_IDENTITY } from "../templates/blank";
import { PROJECT } from "../templates/index";
import { collect, configFromEnv, listAgents, provisionClientAgents, proxyFetch, upstreamFor } from "./proxy";

describe("upstreamFor", () => {
  it("does not map the agent roster, which is paged and cannot be relayed one page at a time", () => {
    expect(upstreamFor("GET", "/api/agents", null)).toBeNull();
  });

  it("maps chat to session create and the stream to an SSE relay", () => {
    expect(upstreamFor("POST", "/api/chat", null)).toEqual({ method: "POST", path: "/v1/sessions" });
    expect(upstreamFor("GET", "/api/chat/ses_abc/stream", null)).toEqual({
      method: "GET", path: "/v1/sessions/ses_abc/stream", sse: true,
    });
    expect(upstreamFor("GET", "/api/chat/not-a-session/stream", null)).toBeNull();
  });

  it("resolves a held call and answers a question on their own sibling routes", () => {
    expect(upstreamFor("POST", "/api/sessions/ses_1/tool_confirmations", null)).toEqual({
      method: "POST", path: "/v1/sessions/ses_1/tool_confirmations",
    });
    expect(upstreamFor("POST", "/api/sessions/ses_1/answers", null)).toEqual({
      method: "POST", path: "/v1/sessions/ses_1/answers",
    });
    expect(upstreamFor("GET", "/api/sessions/ses_1/answers", null)).toBeNull();
  });

  it("forwards the parked-session filters and drops anything else", () => {
    const query = new URLSearchParams({ stop_reason: "awaiting_approval", agent_id: "agt_1", limit: "5", foo: "bar" });
    expect(upstreamFor("GET", "/api/sessions", null, query)).toEqual({
      method: "GET",
      path: "/v1/sessions?limit=100&agent_id=agt_1&stop_reason=awaiting_approval",
    });
  });

  it("routes social paths through the client identity", () => {
    expect(upstreamFor("POST", "/api/social/portal", "idn_1")).toEqual({ method: "POST", path: "/v1/identities/idn_1/social/portal" });
  });

  it("refuses social paths without an identity, traversal, and unknown routes", () => {
    expect(upstreamFor("POST", "/api/social/portal", null)).toBeNull();
    expect(upstreamFor("GET", "/api/social/../secrets", "idn_1")).toBeNull();
    expect(upstreamFor("GET", "/api/nope", "idn_1")).toBeNull();
  });
});

describe("configFromEnv", () => {
  it("is null without a key, and trims the base url's trailing slash", () => {
    expect(configFromEnv({})).toBeNull();
    expect(configFromEnv({ NAIVE_API_KEY: "k", NAIVE_API_URL: "https://x.test/" })).toEqual({
      apiKey: "k",
      baseUrl: "https://x.test",
      identityId: null,
      project: PROJECT,
    });
  });

  /**
   * Measured on staging: the install is filed under the customer's slug (`ws12-staging-blank`) and
   * the dashboard asked for `project=agency`, so `/api/context` was a 404 on every deployed install.
   * The platform writes the install's own project as `NAIVE_PROJECT`; the declaration's name is
   * only the fallback for a laptop `naive up`, which files under it.
   */
  it("reads the install's project from NAIVE_PROJECT and falls back to the declaration's name", () => {
    expect(configFromEnv({ NAIVE_API_KEY: "k", NAIVE_PROJECT: "ws12-staging-blank" })?.project).toBe("ws12-staging-blank");
    expect(configFromEnv({ NAIVE_API_KEY: "k" })?.project).toBe(PROJECT);
  });
});

describe("proxyFetch", () => {
  it("attaches the key upstream only", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    await proxyFetch({ apiKey: "k", baseUrl: "https://x.test", identityId: null, project: "agency" }, { method: "GET", path: "/v1/agents" }, null, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://x.test/v1/agents", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ authorization: "Bearer k" }),
    }));
  });
});

describe("listAgents", () => {
  const config = { apiKey: "k", baseUrl: "https://x.test", identityId: null, project: "agency" };
  const page = (rows: { id: string; name: string }[], next: string | null) =>
    new Response(JSON.stringify({ data: rows, has_more: next !== null, next_cursor: next }), { status: 200 });

  it("follows the cursor to the end — the platform pages at 20 and an agency org has hundreds", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const after = new URL(String(url)).searchParams.get("after");
      if (after === null) return page([{ id: "agt_1", name: "sales" }], "agt_1");
      if (after === "agt_1") return page([{ id: "agt_2", name: "client-manager" }], "agt_2");
      return page([{ id: "agt_3", name: "seo-writer--acme" }], null);
    });
    expect(await listAgents(config, fetchImpl as typeof fetch)).toEqual([
      { id: "agt_1", name: "sales" },
      { id: "agt_2", name: "client-manager" },
      { id: "agt_3", name: "seo-writer--acme" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // 100 is the spec's per-page ceiling; asking for less is more round trips for the same rows.
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://x.test/v1/agents?limit=100");
  });

  it("stops at the last page, and answers null rather than a partial roster when a page fails", async () => {
    const one = vi.fn(async () => page([{ id: "agt_1", name: "sales" }], null));
    expect(await listAgents(config, one as typeof fetch)).toHaveLength(1);
    expect(one).toHaveBeenCalledTimes(1);

    // A half-read roster silently means "that agent does not exist", which is the bug, not a fix.
    let calls = 0;
    const flaky = vi.fn(async () =>
      (calls += 1) === 1 ? page([{ id: "agt_1", name: "sales" }], "agt_1") : new Response("nope", { status: 503 }));
    expect(await listAgents(config, flaky as typeof fetch)).toBeNull();
  });

  it("reads the timers the same way — a timer on an unread page is an agent shown with none", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const after = new URL(String(url)).searchParams.get("after");
      return after === null ? page([{ id: "dep_1", name: "a" }], "dep_1") : page([{ id: "dep_2", name: "b" }], null);
    });
    expect(await collect(config, "/v1/deployments", fetchImpl as typeof fetch)).toHaveLength(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://x.test/v1/deployments?limit=100");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe("https://x.test/v1/deployments?limit=100&after=dep_1");
  });
});

describe("provisionClientAgents", () => {
  const config = { apiKey: "k", baseUrl: "https://x.test", identityId: null, project: "agency" };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  /** Named, not "the active one": the mechanism is the blueprint's and must hold for either template. */
  const crew = TEMPLATES["seo-geo"].crew;
  type Call = [url: URL | RequestInfo, init?: RequestInit | undefined];
  const posted = (impl: { mock: { calls: Call[] } }, match: RegExp) =>
    impl.mock.calls.filter(([url, init]) => init?.method === "POST" && match.test(String(url)));
  /** `POST /v1/agents` — the agent itself. */
  const creates = (impl: { mock: { calls: Call[] } }) => posted(impl, /\/v1\/agents$/);
  /** `POST /v1/agents/{id}/identities` — the persona grant, which is a call of its own (§22). */
  const grants = (impl: { mock: { calls: Call[] } }) => posted(impl, /\/v1\/agents\/[\w-]+\/identities$/);
  /** `PATCH /v1/agents/{id}` — the declaration re-asserted on a member that already exists. */
  const patches = (impl: { mock: { calls: Call[] } }) =>
    impl.mock.calls.filter(([url, init]) => init?.method === "PATCH" && /\/v1\/agents\/[\w-]+$/.test(String(url)));

  it("provisions the active template's crew when none is named", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "GET" ? json({ data: [] }) : json({ id: "agt_new" }));
    const reports = await provisionClientAgents(config, "acme", fetchImpl as typeof fetch);
    expect(reports?.map((r) => r.name)).toEqual(ACTIVE_TEMPLATE.crew.map((one) => `${one.name}--acme`));
  });

  it("creates the missing agents and patches the declaration onto existing ones", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "GET" ? json({ data: [{ id: "agt_1", name: "seo-writer--acme" }] }) : json({ id: "agt_new" }));
    expect(await provisionClientAgents(config, "acme", fetchImpl as typeof fetch, crew)).toEqual([
      { name: "seo-writer--acme", action: "unchanged" },
      { name: "geo-optimizer--acme", action: "created" },
      { name: "audit-runner--acme", action: "created" },
    ]);
    // Two creates only — the existing agent is patched, not re-posted. (The persona grants below
    // are POSTs too, and are counted separately.)
    const posts = creates(fetchImpl);
    expect(posts).toHaveLength(2);
    expect(patches(fetchImpl).map(([url]) => String(url))).toEqual(["https://x.test/v1/agents/agt_1"]);
    const bodies = posts.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies.map((b) => b.name)).toEqual(["geo-optimizer--acme", "audit-runner--acme"]);
    // POST /v1/agents requires model and budget, and every one of these fields is the template's:
    // the server holds no crew, no prompt and no model of its own any more.
    for (const body of bodies) {
      const member = crew.find((one) => String(body.name).startsWith(`${one.name}--`));
      expect(member).toBeDefined();
      expect(body.model).toBe(member?.model);
      expect(body.budget).toEqual(member?.budget);
      expect(body.system).toBe(member?.system);
      expect(String(body.system)).toMatch(/never send or publish anything yourself/);
      expect(body.tools).toMatchObject({ default_config: { permission: "deny" } });
      // The persona is NOT in this body: `POST /v1/agents` declares no `identity` field and strips
      // what it does not declare, so a body carrying one reads as a grant and is none.
      expect(body).not.toHaveProperty("identity");
    }
  });

  /**
   * The grant, and the reason this function makes a second call at all.
   *
   * `POST /v1/agents` declares no `identity` field and strips what it does not declare, so posting
   * the member's declaration verbatim creates an agent that holds no persona — and says nothing
   * about it. An agent with no persona is offered NOTHING from a connected account, so every
   * `googlesearchconsole.*` and `googleanalytics.*` name in this crew's allow-list would resolve to
   * an empty list on every turn: the crew reads the client's own numbers, or it is `web_search`
   * with extra prompts.
   */
  it("grants every member the persona its declaration names, created or already there", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "GET" ? json({ data: [{ id: "agt_1", name: "seo-writer--acme" }] }) : json({ id: "agt_new" }));
    const reports = await provisionClientAgents(config, "acme", fetchImpl as typeof fetch, crew);
    expect(reports?.map((r) => r.action)).toEqual(["unchanged", "created", "created"]);
    // One per member: the one that already existed, by its roster id, and the two just created, by
    // the id the create answered with. The grant is idempotent, so re-asserting it on the existing
    // member is how a crew provisioned before this persona existed stops running as nobody.
    expect(grants(fetchImpl).map(([url]) => String(url))).toEqual([
      "https://x.test/v1/agents/agt_1/identities",
      "https://x.test/v1/agents/agt_new/identities",
      "https://x.test/v1/agents/agt_new/identities",
    ]);
    for (const [, init] of grants(fetchImpl)) {
      expect(JSON.parse(String(init?.body))).toEqual({ identity: AGENCY_IDENTITY });
    }
    // And it is the template's persona, not one the server picked: every crew member declares it.
    expect(crew.map((one) => one.identity)).toEqual(crew.map(() => AGENCY_IDENTITY));
  });

  it("slugs a member's `handoffs` list like its name, so the chain stays inside one client's crew", async () => {
    // The template writes `audit-runner → seo-writer → geo-optimizer`; the platform resolves a
    // handoff target by agent name, and this client's writer is `seo-writer--acme`, not the seat.
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "GET" ? json({ data: [] }) : json({ id: "agt_new" }));
    await provisionClientAgents(config, "acme", fetchImpl as typeof fetch, crew);
    const bodies = creates(fetchImpl).map(([, init]) => JSON.parse(String(init?.body)) as { name: string; handoffs: unknown });
    expect(bodies.map((b) => [b.name, b.handoffs])).toEqual([
      ["seo-writer--acme", ["geo-optimizer--acme"]],
      ["geo-optimizer--acme", false],
      ["audit-runner--acme", ["seo-writer--acme"]],
    ]);
  });

  it("re-asserts the declaration on a crew that already exists, so an old crew gains the chain", async () => {
    // A crew provisioned before the template declared `handoffs` has neither the field nor the
    // tools; only a write can give it them. `PATCH /v1/agents/:id` mints a version only when
    // something differs, so the same call on a crew that already matches is `unchanged`.
    const roster = crew.map(({ name }, i) => ({ id: `agt_${i}`, name: `${name}--acme`, current_version: 1 }));
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return json({ data: roster });
      if (init?.method !== "PATCH") return json({ id: "agt_new" });
      const id = /\/v1\/agents\/(agt_\d)$/.exec(String(url))?.[1];
      // Only the writer drifted; the other two already carry what the declaration says.
      return json({ id, current_version: id === "agt_0" ? 2 : 1 });
    });
    const reports = await provisionClientAgents(config, "acme", fetchImpl as typeof fetch, crew);
    expect(reports).toEqual([
      { name: "seo-writer--acme", action: "updated" },
      { name: "geo-optimizer--acme", action: "unchanged" },
      { name: "audit-runner--acme", action: "unchanged" },
    ]);
    expect(creates(fetchImpl)).toHaveLength(0);
    const bodies = patches(fetchImpl).map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    // The whole declaration, slugged like a create — and without the name: a patch renames nothing.
    expect(bodies.map((b) => [b.handoffs, b.name])).toEqual([
      [["geo-optimizer--acme"], undefined],
      [false, undefined],
      [["seo-writer--acme"], undefined],
    ]);
    for (const [i, body] of bodies.entries()) {
      expect(body.system).toBe(crew[i]?.system);
      expect(body.tools).toEqual(crew[i]?.tools);
      expect(body).not.toHaveProperty("identity");
    }
    // The grant lands on the roster id, as before.
    expect(grants(fetchImpl).map(([url]) => String(url))).toEqual(roster.map((a) => `https://x.test/v1/agents/${a.id}/identities`));
  });

  it("reports a member `failed` when the persona does not land, however well the agent was created", async () => {
    // The agent exists and its toolset reads perfectly; it can reach no connected account. Calling
    // that `created` is precisely how this went unnoticed, so it is reported as the failure it is.
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return json({ data: [] });
      return /\/identities$/.test(String(url)) ? new Response("{}", { status: 404 }) : json({ id: "agt_new" });
    });
    const reports = await provisionClientAgents(config, "acme", fetchImpl as typeof fetch, crew);
    expect(reports?.every((r) => r.action === "failed")).toBe(true);
    expect(creates(fetchImpl)).toHaveLength(crew.length);
  });

  it("still re-grants the persona on a standing seat whose PATCH was refused", async () => {
    // A refused PATCH must cost the declaration and nothing else. The seat is still there, and the
    // grant is a call of its own (§22) that this function re-asserts on every onboard — so giving
    // up on the whole member would let one unsupported or 5xx PATCH take back the connected
    // accounts a working crew already had, which is a strictly worse outcome than not patching.
    const roster = crew.map(({ name }, i) => ({ id: `agt_${i}`, name: `${name}--acme`, current_version: 1 }));
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return json({ data: roster });
      return init?.method === "PATCH" ? new Response("{}", { status: 500 }) : json({ ok: true });
    });
    const reports = await provisionClientAgents(config, "acme", fetchImpl as typeof fetch, crew);
    // Reported for what it is: the declaration did not land on any of them.
    expect(reports).toEqual(roster.map(({ name }) => ({ name, action: "failed" })));
    expect(grants(fetchImpl).map(([url]) => String(url))).toEqual(roster.map((a) => `https://x.test/v1/agents/${a.id}/identities`));
    // And nothing was created to route around the refusal: the seats already exist.
    expect(creates(fetchImpl)).toHaveLength(0);
  });

  it("keeps a crew the new template does not declare, and never deletes it", async () => {
    // The switch rule: WIDEN, NEVER NARROW. This is `seo-geo` → a template that declares no crew at
    // all: every agent the old template provisioned is reported and left exactly as it is. An
    // agent is deleted only by an explicit `removed:` tombstone, exactly as in the reconciler.
    const roster = [
      ...crew.map(({ name }, i) => ({ id: `agt_${i}`, name: `${name}--acme` })),
      { id: "agt_y", name: "seo-writer--other-client" },
    ];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "GET" ? json({ data: roster }) : json({ id: "agt_new" }));
    // A template that declares no per-client crew (`blank` did, before it gained the receptionist).
    const reports = await provisionClientAgents(config, "acme", fetchImpl as typeof fetch, []);
    expect(reports).toEqual(crew.map(({ name }) => ({ name: `${name}--acme`, action: "kept" })));
    // Another client's crew is not this client's business, and nothing was written at all.
    expect(reports?.map((r) => r.name)).not.toContain("seo-writer--other-client");
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method !== "GET")).toHaveLength(0);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
  });

  it("sees a crew that is past page one, instead of creating it again under the same name", async () => {
    // The whole point: an agency with a few clients pushes its older crews off page one, and the
    // previous read of page one alone re-posted every one of them on each onboard.
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "GET") return json({ id: "agt_new" });
      return new URL(String(url)).searchParams.get("after") === null
        ? new Response(JSON.stringify({ data: [{ id: "agt_1", name: "sales" }], has_more: true, next_cursor: "agt_1" }))
        : new Response(JSON.stringify({
            data: crew.map(({ name }, i) => ({ id: `agt_${i + 2}`, name: `${name}--acme` })),
            has_more: false,
            next_cursor: null,
          }));
    });
    const reports = await provisionClientAgents(config, "acme", fetchImpl as typeof fetch, crew);
    expect(reports?.every((r) => r.action === "unchanged")).toBe(true);
    expect(creates(fetchImpl)).toHaveLength(0);
  });

  it("answers null when the roster cannot be read, failed when a create is refused", async () => {
    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(await provisionClientAgents(config, "acme", down as unknown as typeof fetch)).toBeNull();

    const refusing = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "GET" ? json({ data: [] }) : new Response("{}", { status: 402 }));
    const reports = await provisionClientAgents(config, "acme", refusing as typeof fetch, crew);
    expect(reports?.length).toBe(crew.length);
    expect(reports?.every((r) => r.action === "failed")).toBe(true);
  });
});
