import { describe, expect, it, vi } from "vitest";
import { autoApprove, DAILY_SEND_CAP, hardLimit, isCrewAgent, ruleFor, type LimitContext, type ParkedSession, type PendingAction } from "./autoapprove.ts";
import { emptyState, openStoreOver, pacificDay } from "./store.ts";
import type { Client } from "../seed/clients.ts";

const session: ParkedSession = { id: "ses_r", agent_id: "agt_research", stop_reason: "awaiting_approval", metadata: { board: { card_id: "crd_mine" } } };
const crm = new Set(["owner@meissner.example"]);
const tool = (name: string, args: Record<string, unknown> = {}): PendingAction => ({ kind: "tool", name, tool_call_id: `tc_${name}`, args, read_people: true });

describe("ruleFor", () => {
  it("approves exactly the calls research makes", () => {
    expect(ruleFor(tool("monid.monid_run", { provider: "dataforseo", endpoint: "/serp/google-maps" }), session, crm)).toBe("Google Maps search");
    expect(ruleFor(tool("monid.monid_run", { provider: "hunterio", endpoint: "/domain-search" }), session, crm)).toBe("owner email lookup");
    expect(ruleFor(tool("autoops.provision_demo", { shop: { name: "Meissner", demo: true } }), session, crm)).toBe("free preview demo");
    expect(ruleFor(tool("board_write", { op: "comment", card_id: "crd_mine" }), session, crm)).toBe("note on its own card");
    expect(ruleFor(tool("dashboard.create_lead"), session, crm)).toBe("our CRM");
    expect(ruleFor(tool("agentmail.create_draft"), session, crm)).toBe("company inbox");
    expect(ruleFor(tool("email.send", { to: ["Owner@Meissner.example"] }), session, crm)).toBe("email to a CRM contact");
  });

  it("leaves everything else for a person", () => {
    expect(ruleFor(tool("monid.monid_run", { provider: "someone", endpoint: "/people/search" }), session, crm)).toBeNull();
    expect(ruleFor(tool("autoops.provision_demo", { shop: { name: "x", demo: false } }), session, crm)).toBeNull();
    expect(ruleFor(tool("autoops.provision_receptionist", { attach_phone_number: true }), session, crm)).toBeNull();
    expect(ruleFor(tool("board_write", { op: "comment", card_id: "crd_someone_elses" }), session, crm)).toBeNull();
    expect(ruleFor(tool("board_write", { op: "assign", card_id: "crd_mine" }), session, crm)).toBeNull();
    expect(ruleFor(tool("email.send", { to: ["owner@meissner.example", "stranger@elsewhere.example"] }), session, crm)).toBeNull();
    expect(ruleFor(tool("agentmail.send_draft", { draft_id: "d1" }), session, crm)).toBeNull();
    expect(ruleFor(tool("request_tools"), session, crm)).toBeNull();
    expect(ruleFor(tool("web_fetch", { url: "https://x" }), session, crm)).toBeNull();
    expect(ruleFor({ kind: "question", name: "ask_operator", tool_call_id: "q" }, session, crm)).toBeNull();
  });
});

const shop = (over: Partial<Client> = {}): Client => ({
  id: "cli_meissner", slug: "meissner-auto", name: "Meissner Auto", domain: "meissner.example", stage: "lead", services: [],
  contact: { name: "Pat", email: "owner@meissner.example", role: "Owner" }, notes: ["RECEPTIONIST: shop_id meissner-example, demo_url https://x"], ...over,
});
const limits = (over: Partial<LimitContext> = {}): LimitContext => ({ crmEmails: crm, clients: [shop()], sendsToday: 0, ...over });

describe("hardLimit (issue #30): never approved, whatever any rule says", () => {
  it("lets ordinary calls through", () => {
    expect(hardLimit(tool("monid.monid_run", { provider: "dataforseo", endpoint: "/serp/google-maps" }), limits())).toBeNull();
    expect(hardLimit(tool("agentmail.send_message", { to: "Owner@Meissner.example" }), limits())).toBeNull();
    expect(hardLimit(tool("agentmail.reply_to_message", { message_id: "m1" }), limits())).toBeNull();
    expect(hardLimit(tool("autoops.provision_receptionist", { shop_id: "meissner-example" }), limits())).toBeNull();
  });

  it("refuses a phone number purchase unless the shop shows a completed Stripe checkout", () => {
    const buy = tool("autoops.provision_receptionist", { shop_id: "meissner-example", attach_phone_number: true });
    expect(hardLimit(buy, limits())).toMatch(/phone number/);
    expect(hardLimit(buy, limits({ clients: [shop({ notes: [...shop().notes, "FREE WEEK STARTED: Meissner Auto\nsubscription_status: trialing"] })] }))).toMatch(/phone number/);
    expect(hardLimit(buy, limits({ clients: [shop({ notes: [...shop().notes, "PAID: checkout cs_live_123 complete"] })] }))).toBeNull();
    expect(hardLimit(buy, limits({ clients: [shop({ notes: [...shop().notes, "Stripe: subscription active"] })] }))).toBeNull();
    // Another shop's payment does not pay for this one.
    expect(hardLimit(buy, limits({ clients: [shop(), shop({ id: "cli_other", slug: "other", name: "Other", notes: ["PAID: yes"] })] }))).toMatch(/phone number/);
  });

  it("refuses Stripe live mode, request_tools, and sends outside the CRM", () => {
    expect(hardLimit(tool("stripe.create_payment_link", { livemode: true }), limits())).toMatch(/Stripe/);
    expect(hardLimit(tool("stripe.create_customer", { api_key: "sk_live_abc" }), limits())).toMatch(/Stripe/);
    expect(hardLimit(tool("stripe.create_customer", {}), limits())).toMatch(/Stripe/);
    expect(hardLimit(tool("stripe.create_customer", { livemode: false }), limits())).toBeNull();
    expect(hardLimit(tool("request_tools", { tools: ["x"] }), limits())).toMatch(/request_tools/);
    expect(hardLimit(tool("agentmail.send_message", { to: ["owner@meissner.example"], cc: ["stranger@else.example"] }), limits())).toMatch(/stranger@else.example/);
    expect(hardLimit(tool("agentmail.forward_message", { to: "stranger@else.example" }), limits())).toMatch(/not a CRM contact/);
    expect(hardLimit(tool("agentmail.reply_to_message", { to: "stranger@else.example" }), limits())).toMatch(/not a CRM contact/);
    expect(hardLimit(tool("agentmail.send_draft", { draft_id: "d1" }), limits())).toMatch(/draft/);
    expect(hardLimit(tool("agentmail.send_message", {}), limits())).toMatch(/no recipient/);
  });

  it("refuses every send once the daily cap is hit", () => {
    expect(hardLimit(tool("agentmail.send_message", { to: "owner@meissner.example" }), limits({ sendsToday: DAILY_SEND_CAP - 1 }))).toBeNull();
    expect(hardLimit(tool("agentmail.send_message", { to: "owner@meissner.example" }), limits({ sendsToday: DAILY_SEND_CAP }))).toMatch(/daily send cap/);
    expect(hardLimit(tool("agentmail.reply_to_message", { message_id: "m" }), limits({ sendsToday: DAILY_SEND_CAP }))).toMatch(/daily send cap/);
    expect(hardLimit(tool("dashboard.add_client_note"), limits({ sendsToday: DAILY_SEND_CAP }))).toBeNull();
  });

  it("knows this crew by seat name", () => {
    expect(isCrewAgent({ name: "research" })).toBe(true);
    expect(isCrewAgent({ name: "booking--meissner-auto" })).toBe(true);
    expect(isCrewAgent({ name: "ceo", metadata: { role: "orchestrator" } })).toBe(true);
    expect(isCrewAgent({ name: "someone-elses-bot" })).toBe(false);
  });
});

describe("autoApprove", () => {
  const roster = [{ id: "agt_research", name: "research" }, { id: "agt_foreign", name: "other-team-bot" }];
  const platform = (sessions: ParkedSession[]) => {
    const confirmed: Array<{ session: string; body: { tool_call_id: string; decision: string; reason: string } }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/sessions?status=idle&limit=100")) return new Response(JSON.stringify({ data: sessions }), { status: 200 });
      if (u.includes("/v1/agents?")) return new Response(JSON.stringify({ data: roster, has_more: false }), { status: 200 });
      const m = /\/v1\/sessions\/(\w+)\/tool_confirmations$/.exec(u);
      if (m) {
        confirmed.push({ session: m[1]!, body: JSON.parse(String(init?.body)) });
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return { confirmed, fetchImpl };
  };
  const config = { baseUrl: "https://api.example", apiKey: "k", identityId: null, project: "agency" };
  const parked: ParkedSession = {
    ...session,
    pending_actions: [
      tool("monid.monid_run", { provider: "dataforseo", endpoint: "/serp/google-maps" }),
      tool("web_fetch", { url: "https://x" }),
      tool("autoops.provision_receptionist", { shop_id: "meissner-example", attach_phone_number: true }),
    ],
  };

  it("approves an allowlisted call and anything else ordinary, and denies a purchase", async () => {
    const store = openStoreOver(emptyState(), () => {});
    const { confirmed, fetchImpl } = platform([parked]);
    const result = await autoApprove(config, store, new Date("2026-11-08T03:30:00Z"), fetchImpl);
    expect(result.left).toBe(0);
    expect(result.approved.map((a) => [a.tool, a.rule])).toEqual([
      ["monid.monid_run", "Google Maps search"],
      ["web_fetch", "approved everything"],
    ]);
    expect(result.denied.map((a) => a.tool)).toEqual(["autoops.provision_receptionist"]);
    expect(confirmed.map((c) => [c.body.tool_call_id, c.body.decision])).toEqual([
      ["tc_monid.monid_run", "allow"],
      ["tc_web_fetch", "allow"],
      ["tc_autoops.provision_receptionist", "deny"],
    ]);
    expect(confirmed[2]!.body.reason).toMatch(/hard limit/);
    expect(store.read().auto_approvals).toHaveLength(3);
  });

  it("ignores a foreign agent's hold entirely", async () => {
    const store = openStoreOver(emptyState(), () => {});
    const { confirmed, fetchImpl } = platform([{ ...parked, id: "ses_x", agent_id: "agt_foreign" }, { ...parked, id: "ses_y", agent_id: "agt_unknown" }]);
    const result = await autoApprove(config, store, new Date(), fetchImpl);
    expect(result).toMatchObject({ approved: [], denied: [], ignored: 6 });
    expect(confirmed).toHaveLength(0);
  });

  it("denies a send once the CRM's send notes reach the daily cap", async () => {
    const state = emptyState();
    state.clients.push(shop());
    const store = openStoreOver(state, () => {});
    const now = new Date();
    state.sends = { day: pacificDay(now), count: DAILY_SEND_CAP };
    const { confirmed, fetchImpl } = platform([{ ...session, pending_actions: [tool("agentmail.send_message", { to: "owner@meissner.example" })] }]);
    const result = await autoApprove(config, store, now, fetchImpl);
    expect(result.denied).toHaveLength(1);
    expect(confirmed[0]!.body.decision).toBe("deny");
  });

  it("leaves a question for a person, and says when the platform is rate-limiting", async () => {
    const store = openStoreOver(emptyState(), () => {});
    const asked = { ...session, pending_actions: [{ kind: "question", name: "ask_operator", tool_call_id: "q" }] };
    const { fetchImpl } = platform([asked]);
    expect(await autoApprove(config, store, new Date(), fetchImpl)).toEqual({ approved: [], denied: [], left: 1, ignored: 0 });
    const limited = vi.fn(async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    expect(await autoApprove(config, store, new Date(), limited)).toMatchObject({ approved: [], left: 0, rate_limited: true });
  });

  it("approves nothing while the company is paused", async () => {
    const store = openStoreOver(emptyState(), () => {});
    store.setCompany({ paused: true, changed_at: "x", interrupted: [], deployments: [] });
    const { confirmed, fetchImpl } = platform([parked]);
    expect(await autoApprove(config, store, new Date(), fetchImpl)).toMatchObject({ approved: [], left: 0 });
    expect(confirmed).toHaveLength(0);
  });
});

describe("the store counts sends by Pacific day", () => {
  it("counts OUTREACH SENT and REPLY SENT notes, and nothing else", () => {
    const state = emptyState();
    state.clients.push(shop());
    const store = openStoreOver(state, () => {});
    store.addClientNote("cli_meissner", "OUTREACH SENT: msg_1 to owner@meissner.example\n\nHi Pat,");
    store.addClientNote("cli_meissner", "REPLY SENT: msg_2");
    store.addClientNote("cli_meissner", "RESEARCH: busy shop");
    expect(store.sendsOn(new Date())).toBe(2);
    expect(store.sendsOn(new Date(Date.now() + 2 * 86_400_000))).toBe(0);
  });
});

