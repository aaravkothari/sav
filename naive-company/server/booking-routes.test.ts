/**
 * The Bookings routes: appointment requests read from a mocked voice server, and the two POSTs
 * behind the operator gate. Nothing here reaches a real service or wakes a real agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appointmentRequests, mapLimit, maskPhone, requestRows, resetRequestsCache, scrubContact } from "./booking-routes.ts";
import { resetScriptRequests } from "./feedback.ts";
import { handleRequest, type ApiContext, type ApiRequest } from "./routes.ts";
import { emptyState, openStoreOver, type StoreState } from "./store.ts";
import type { Client } from "../seed/clients.ts";

const ENV = { AUTOOPS_VOICE_TOKEN: "voice-token", AUTOOPS_MCP_URL: "https://voice.test/mcp" };

const pat: Client = {
  id: "cli_pat", slug: "pats-garage", name: "Pat's Garage", domain: "patsgarage.com", stage: "proposal", services: [],
  contact: { name: "Pat Banks", email: "pat@patsgarage.com", role: "Owner" },
  notes: ["RECEPTIONIST: shop_id demo-shop · demo_url https://voice.test/demo/demo-shop · portal_url https://voice.test/portal/demo-shop?t=abcdef0123456789abcdef · preview"],
};

const detail = {
  shop_id: "demo-shop", name: "Demo Auto Works", demo: true, portal_url: "https://voice.test/portal/demo-shop?t=secret", business_phone: "+14155550000",
  calls: [{ id: "call-1", started_at: "2026-11-07T23:07:38Z", duration_sec: 89, outcome: "appointment_request", ended_reason: "customer-ended-call", flags: ["appointment_request", "vehicle_unclear"], summary: "Gon wants brakes; call back on +1 415 555 7890.", caller_number: "•••-7890" }],
  requests: [
    { id: "req-1", call_id: "call-1", customer_name: "Gon Freecss", callback_number: "+14155557890", vehicle: null, service: "brake repair", preferred_time: "tomorrow at 3 PM", notes: "email gon@x.com", status: "pending", created_at: "2026-11-07T23:08:52Z" },
    { id: "req-2", call_id: null, customer_name: "Vidat", callback_number: "•••-0123", vehicle: "2015 Toyota Camry", service: "oil change", preferred_time: "Tuesday", notes: null, status: "confirmed", created_at: "2026-11-07T22:46:33Z" },
  ],
};

function voice(shops: unknown[], details: Record<string, unknown>, fail: string[] = []) {
  const seen: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push(u);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer voice-token");
    if (u === "https://voice.test/api/shops") return Response.json({ shops });
    const id = decodeURIComponent(u.replace("https://voice.test/api/shops/", ""));
    if (fail.includes(id)) return new Response("no", { status: 500 });
    return Response.json(details[id]);
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

beforeEach(() => { resetRequestsCache(); resetScriptRequests(); });
afterEach(() => vi.unstubAllGlobals());

describe("appointment requests from the voice server", () => {
  it("reads only shops with requests, and sends the browser first names and masked numbers only", async () => {
    const v = voice([
      { shop_id: "demo-shop", appointment_requests: 2 },
      { shop_id: "quiet", appointment_requests: 0 },
    ], { "demo-shop": detail });
    const reply = await appointmentRequests([pat], ENV, v.fetcher, 1000);
    expect(v.seen).toEqual(["https://voice.test/api/shops", "https://voice.test/api/shops/demo-shop"]);
    expect(reply.configured).toBe(true);
    expect(reply.requests.map((r) => [r.caller, r.callback, r.status])).toEqual([["Gon", "•••-7890", "pending"], ["Vidat", "•••-0123", "confirmed"]]);
    expect(reply.requests[0]).toMatchObject({ shop: "Demo Auto Works", lead: "pats-garage", demo: true, flags: ["vehicle unclear"], notes: "email (email)" });
    expect(reply.requests[0]!.call).toMatchObject({ duration_sec: 89, ended_by: "caller", summary: "Gon wants brakes; call back on •••-7890." });
    expect(reply.requests[1]!.call).toBeNull();
    const wire = JSON.stringify(reply);
    for (const secret of ["Freecss", "4155557890", "portal", "secret", "req-1", "call-1", "demo-shop", "14155550000", "gon@x.com"]) expect([secret, wire.includes(secret)]).toEqual([secret, false]);
  });

  it("reads the CRM (and so takes the store's lock) only after every voice call", async () => {
    const v = voice([{ shop_id: "demo-shop", appointment_requests: 2 }], { "demo-shop": detail });
    let seenAtLoad = -1;
    const reply = await appointmentRequests(async () => { seenAtLoad = v.seen.length; return [pat]; }, ENV, v.fetcher, 1000);
    expect(seenAtLoad).toBe(2);
    expect(reply.requests[0]).toMatchObject({ lead: "pats-garage" });
  });

  it("caches for 30 s, and says which shops could not be read", async () => {
    const v = voice([{ shop_id: "a", appointment_requests: 1 }, { shop_id: "b", appointment_requests: 1 }], { a: detail }, ["b"]);
    const first = await appointmentRequests([], ENV, v.fetcher, 1000);
    expect(first.missing).toBe(1);
    expect(first.requests).toHaveLength(2);
    await appointmentRequests([], ENV, v.fetcher, 20_000);
    expect(v.seen).toHaveLength(3);
    await appointmentRequests([], ENV, v.fetcher, 40_000);
    expect(v.seen).toHaveLength(6);
  });

  it("answers configured: false without a token, and a sentence when the voice server is down", async () => {
    expect(await appointmentRequests([], {}, voice([], {}).fetcher)).toEqual({ configured: false, requests: [], missing: 0 });
    const down = (async () => { throw new Error("tunnel gone"); }) as unknown as typeof fetch;
    expect(await appointmentRequests([], ENV, down)).toMatchObject({ configured: true, requests: [], error: expect.stringMatching(/could not be reached/) });
  });

  it("never reads more than a few shops at once", async () => {
    let open = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 2));
      open -= 1;
    });
    expect(peak).toBe(4);
  });

  it("masks every phone shape it is given", () => {
    expect(maskPhone("+1 (415) 555-7890")).toBe("•••-7890");
    expect(maskPhone("•••-0123")).toBe("•••-0123");
    expect(maskPhone("")).toBeNull();
    expect(scrubContact("call 415.555.7890 or a@b.co, ref 2026")).toBe("call •••-7890 or (email), ref 2026");
    expect(requestRows({ name: "X", requests: [{ customer_name: "  Ann  Lee ", status: "weird" }] }, null)[0]).toMatchObject({ caller: "Ann", status: "pending", call: null });
  });
});

describe("the booking routes", () => {
  function fixture(over: Partial<ApiContext> = {}) {
    const state: StoreState = { ...emptyState(), clients: [structuredClone(pat)] };
    const store = openStoreOver(state, () => {});
    const ctx: ApiContext = {
      store: () => Promise.resolve(store), config: null, mcpToken: undefined, dashboardToken: undefined, dashboardPassword: undefined,
      studioUrl: undefined, appId: undefined, local: true, ...over,
    };
    const call = (method: string, path: string, body: unknown = "", headers: Record<string, string> = {}) => {
      const req: ApiRequest = { method, path, query: new URLSearchParams(), headers, body: typeof body === "string" ? body : JSON.stringify(body) };
      return handleRequest(req, ctx);
    };
    return { call, state };
  }

  it("files the feedback and says onboarding was not woken when this server has no platform key", async () => {
    const { call, state } = fixture();
    const reply = await call("POST", "/api/bookings/cli_pat/feedback", { greeting: "Pat's, how can I help?" });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ onboarding: "not_woken", onboarding_reason: expect.stringMatching(/not connected/), voice: "not_connected" });
    expect(state.clients[0]!.notes.at(-1)).toMatch(/^MEETING FEEDBACK: onboarding call with Pat's Garage, filed .*\nGreeting: Pat's, how can I help\?$/);
  });

  it("wakes client-manager through the platform when a key is set", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { call } = fixture({ config: { baseUrl: "https://platform.test", apiKey: "k", identityId: null, project: "p" } });
    expect((await call("POST", "/api/bookings/cli_pat/feedback", { hours: "Sat 9-1" })).body).toMatchObject({ onboarding: "woken" });
    expect(await call("POST", "/api/bookings/cli_pat/script")).toEqual({ status: 202, body: { requested: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).message.split("\n")[0]))
      .toEqual(["MEETING FEEDBACK: Pat's Garage", "WRITE MEETING SCRIPT: Pat's Garage"]);
  });

  it("refuses empty feedback, unknown shops and the wrong methods", async () => {
    const { call } = fixture();
    expect((await call("POST", "/api/bookings/cli_pat/feedback", { hours: " " })).status).toBe(400);
    expect((await call("POST", "/api/bookings/cli_pat/feedback", "{not json")).status).toBe(400);
    expect((await call("POST", "/api/bookings/cli_nope/feedback", { hours: "x" })).status).toBe(404);
    expect((await call("GET", "/api/bookings/cli_pat/feedback")).status).toBe(405);
    expect((await call("POST", "/api/bookings/requests")).status).toBe(405);
    expect((await call("POST", "/api/bookings/cli_pat/script")).status).toBe(503);
  });

  it("sits behind the operator gate", async () => {
    const { call, state } = fixture({ dashboardToken: "op-token", local: false });
    expect((await call("GET", "/api/bookings/requests")).status).toBe(401);
    expect((await call("POST", "/api/bookings/cli_pat/feedback", { hours: "x" })).status).toBe(401);
    expect(state.clients[0]!.notes).toHaveLength(1);
    // A cookie-held session from another site cannot write.
    expect((await call("POST", "/api/bookings/cli_pat/feedback", { hours: "x" }, { cookie: "dashboard_session=op-token", "sec-fetch-site": "cross-site" })).status).toBe(403);
  });
});
