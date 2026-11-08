import { describe, expect, it, vi } from "vitest";
import { PIPELINE } from "../templates/receptionist.ts";
import { CANCELLED_NOTE, cancelRun, cleanBoard, groupRuns, pauseCompany, RESUME_MESSAGE, resumeCompany, runId, runState, startRun, sweepPaused, type Card } from "./runs.ts";
import { emptyState, openStoreOver } from "./store.ts";

const config = { baseUrl: "https://api.example", apiKey: "secret", identityId: null, project: "agency" };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** A fake platform: answers by method and path, records every call. */
function platform(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(config.baseUrl, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    const key = Object.keys(routes).find((k) => new RegExp(`^${k}$`).test(`${method} ${path}`));
    return key ? ok(routes[key]!(body)) : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("startRun", () => {
  it("puts one card per pipeline step on the CEO's board, chained, then asks the CEO to assign them", async () => {
    let n = 0;
    const { calls, fetchImpl } = platform({
      "POST /v1/boards": () => ({ id: "brd_1" }),
      "GET /v1/agents/agt_ceo/board\\?limit=100": () => ({ data: [], has_more: false }),
      "POST /v1/boards/brd_1/cards": () => ({ id: `crd_${++n}` }),
      "POST /v1/sessions": () => ({ id: "ses_ceo" }),
    });
    const now = new Date("2026-11-08T01:30:00Z");
    const started = await startRun(config, "agt_ceo", "Palo Alto shops", now, fetchImpl);

    expect(started).toEqual({ run: "run-202611080130", session_id: "ses_ceo", cards: PIPELINE.length, closed_before: 0 });
    expect(calls[0]).toEqual({ method: "POST", path: "/v1/boards", body: { agent_id: "agt_ceo" } });
    const cards = calls.filter((c) => c.path === "/v1/boards/brd_1/cards");
    expect(cards.map((c) => (c.body as { title: string }).title)).toEqual(PIPELINE.map((s) => `${s.title} (run-202611080130)`));
    expect((cards[1]!.body as { blocked_by: string[] }).blocked_by).toEqual(["crd_1"]);
    expect((calls.at(-1)!.body as { message: string }).message).toMatch(/Every other card on the board is closed/);
    const ceo = calls.at(-1)!;
    expect(ceo.path).toBe("/v1/sessions");
    expect((ceo.body as { agent_id: string; message: string }).agent_id).toBe("agt_ceo");
    expect((ceo.body as { message: string }).message).toContain("Goal: Palo Alto shops");
  });

  it("names a run by its UTC minute", () => {
    expect(runId(new Date("2026-11-08T09:05:59Z"))).toBe("run-202611080905");
  });
});

describe("groupRuns", () => {
  const card = (title: string, status: Card["status"], created = "2026-11-08T01:30:00Z"): Card => ({
    id: `crd_${title}`, title, body: "Goal: Palo Alto shops\n...", note: null, status, assignee: null,
    blocked_by: [], woken_session_id: null, created_at: created, updated_at: created,
  });

  it("groups cards by run, newest first, each as the six pipeline steps in order", () => {
    const runs = groupRuns([
      card("Find and qualify 3 shops (run-202611080130)", "done"),
      card("Draft intro emails (run-202611080130)", "doing"),
      card("Find and qualify 3 shops (run-202611090800)", "todo"),
      card("Something the CEO filed itself", "todo"),
    ]);
    expect(runs.map((r) => r.run)).toEqual(["run-202611090800", "run-202611080130"]);
    expect(runs[1]!.goal).toBe("Palo Alto shops");
    expect(runs[1]!.steps.map((s) => s.key)).toEqual(PIPELINE.map((s) => s.key));
    expect(runs[1]!.steps.map((s) => s.card?.status ?? null)).toEqual(["done", "doing", null, null, null, null]);
  });
});

describe("pause and resume", () => {
  it("interrupts what is running, pauses timers, and resuming wakes exactly those", async () => {
    const store = openStoreOver(emptyState(), () => {});
    const { calls, fetchImpl } = platform({
      "GET /v1/sessions\\?status=queued&limit=100": () => ({ data: [{ id: "ses_q" }] }),
      "GET /v1/sessions\\?status=running&limit=100": () => ({ data: [{ id: "ses_r" }] }),
      "POST /v1/sessions/ses_[qr]/interrupt": () => ({}),
      "GET /v1/deployments\\?limit=100": () => ({ data: [{ id: "dep_1", status: "active" }, { id: "dep_2", status: "paused" }], has_more: false }),
      "POST /v1/deployments/dep_1/(pause|resume)": () => ({}),
      "POST /v1/sessions/ses_[qr]/messages": () => ({}),
    });

    const paused = await pauseCompany(config, store, new Date("2026-11-08T02:00:00Z"), fetchImpl);
    expect(paused).toEqual({ paused: true, changed_at: "2026-11-08T02:00:00.000Z", interrupted: ["ses_q", "ses_r"], deployments: ["dep_1"] });
    expect(store.company().paused).toBe(true);
    // A timer that was already paused is not ours to resume.
    expect(calls.some((c) => c.path === "/v1/deployments/dep_2/pause")).toBe(false);

    calls.length = 0;
    const resumed = await resumeCompany(config, store, new Date("2026-11-08T03:00:00Z"), fetchImpl);
    expect(resumed.paused).toBe(false);
    expect(calls.filter((c) => c.path.endsWith("/messages")).map((c) => [c.path, c.body])).toEqual([
      ["/v1/sessions/ses_q/messages", { message: RESUME_MESSAGE }],
      ["/v1/sessions/ses_r/messages", { message: RESUME_MESSAGE }],
    ]);
    expect(calls.some((c) => c.path === "/v1/deployments/dep_1/resume")).toBe(true);
  });

  it("while paused, interrupts anything new; while running, touches nothing", async () => {
    const store = openStoreOver(emptyState(), () => {});
    const { calls, fetchImpl } = platform({
      "GET /v1/sessions\\?status=queued&limit=100": () => ({ data: [] }),
      "GET /v1/sessions\\?status=running&limit=100": () => ({ data: [{ id: "ses_new" }] }),
      "POST /v1/sessions/ses_new/interrupt": () => ({}),
    });
    expect((await sweepPaused(config, store, fetchImpl)).paused).toBe(false);
    expect(calls).toHaveLength(0);

    store.setCompany({ paused: true, changed_at: "x", interrupted: ["ses_old"], deployments: [] });
    expect((await sweepPaused(config, store, fetchImpl)).interrupted).toEqual(["ses_old", "ses_new"]);
  });
});

describe("a refused run", () => {
  it("says which step the platform refused, in the platform's words", async () => {
    const { fetchImpl } = platform({ "POST /v1/boards": () => ({ id: "brd_1" }), "GET /v1/agents/agt_ceo/board\\?limit=100": () => ({ data: [], has_more: false }) });
    const refuse = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith("/cards")
        ? new Response(JSON.stringify({ error: { code: "forbidden", message: "this key may not write boards" } }), { status: 403 })
        : fetchImpl(url, init)) as unknown as typeof fetch;
    await expect(startRun(config, "agt_ceo", "x", new Date(), refuse)).rejects.toThrow(
      'adding the "research" card: the platform answered 403 (forbidden: this key may not write boards)',
    );
  });
});

describe("cleaning up runs", () => {
  const T = "run-202611080142";
  const card = (id: string, title: string, status: Card["status"], extra: Partial<Card> = {}): Card => ({
    id, title, body: "Goal: Palo Alto", note: null, status, assignee: null, blocked_by: [],
    woken_session_id: null, created_at: "2026-11-08T01:42:00Z", updated_at: "2026-11-08T01:42:00Z", ...extra,
  });
  const board = [
    card("crd_r", `Find and qualify 3 shops (${T})`, "doing", { assignee: "agt_research", woken_session_id: "ses_r" }),
    card("crd_s", `Draft intro emails (${T})`, "blocked", { assignee: "agt_sales", blocked_by: ["crd_r"] }),
    card("crd_seed", "Find and qualify 3 shops", "todo"),
    card("crd_old", "You: Write down your pitch", "todo"),
    card("crd_done", "Already finished", "done"),
  ];
  const fake = () => platform({
    "POST /v1/boards": () => ({ id: "brd_1" }),
    "GET /v1/agents/agt_ceo/board\\?limit=100": () => ({ data: board, has_more: false }),
    "PATCH /v1/boards/brd_1/cards/crd_\\w+": () => ({}),
    "POST /v1/sessions/ses_r/cancel": () => ({}),
  });

  it("cancels a run last step first, unassigning each card and stopping the session it woke", async () => {
    const { calls, fetchImpl } = fake();
    expect(await cancelRun(config, "agt_ceo", T, fetchImpl)).toEqual({ run: T, closed: 2 });
    const writes = calls.filter((c) => c.method !== "GET" && c.path !== "/v1/boards").map((c) => c.path);
    expect(writes).toEqual(["/v1/boards/brd_1/cards/crd_s", "/v1/sessions/ses_r/cancel", "/v1/boards/brd_1/cards/crd_r"]);
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ assignee: null, status: "done", note: CANCELLED_NOTE });
  });

  it("cleans the whole board: every open card closed, finished ones left alone", async () => {
    const { calls, fetchImpl } = fake();
    expect(await cleanBoard(config, "agt_ceo", fetchImpl)).toEqual({ closed: 4 });
    expect(calls.some((c) => c.path.endsWith("/crd_done"))).toBe(false);
  });

  it("tells a running, stopped, finished and cancelled run apart", () => {
    const step = (status: Card["status"], extra: Partial<Card> = {}) => ({ key: "k", title: "t", owner: "o", card: card("c", "t", status, extra) });
    expect(runState([step("done"), step("doing", { assignee: "a" })])).toBe("active");
    expect(runState([step("done"), step("todo")])).toBe("stopped");
    expect(runState([step("done"), step("todo"), step("blocked", { assignee: "m" })])).toBe("stopped");
    expect(runState([step("todo", { assignee: "r" }), step("blocked", { assignee: "s" })])).toBe("active");
    expect(runState([step("done"), step("done")])).toBe("done");
    expect(runState([step("done"), step("done", { note: CANCELLED_NOTE })])).toBe("cancelled");
  });
});
