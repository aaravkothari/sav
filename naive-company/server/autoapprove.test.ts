import { describe, expect, it, vi } from "vitest";
import { autoApprove, ruleFor, type ParkedSession, type PendingAction } from "./autoapprove.ts";
import { emptyState, openStoreOver } from "./store.ts";

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

describe("autoApprove", () => {
  const parked = {
    ...session,
    pending_actions: [
      tool("monid.monid_run", { provider: "dataforseo", endpoint: "/serp/google-maps" }),
      tool("autoops.provision_receptionist", { attach_phone_number: true }),
    ],
  };
  const platform = () => {
    const confirmed: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/sessions?status=idle&limit=100")) return new Response(JSON.stringify({ data: [parked] }), { status: 200 });
      if (String(url).endsWith("/v1/sessions/ses_r/tool_confirmations")) {
        confirmed.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return { confirmed, fetchImpl };
  };
  const config = { baseUrl: "https://api.example", apiKey: "k", identityId: null, project: "agency" };

  it("approves every held tool call, labels each by its rule, and logs it", async () => {
    const store = openStoreOver(emptyState(), () => {});
    const { confirmed, fetchImpl } = platform();
    const result = await autoApprove(config, store, new Date("2026-11-08T03:30:00Z"), fetchImpl);
    expect(result.left).toBe(0);
    expect(result.approved.map((a) => [a.tool, a.rule])).toEqual([
      ["monid.monid_run", "Google Maps search"],
      ["autoops.provision_receptionist", "approved everything"],
    ]);
    expect(confirmed).toEqual([
      { tool_call_id: "tc_monid.monid_run", decision: "allow", reason: "Approved automatically by the dashboard: Google Maps search." },
      { tool_call_id: "tc_autoops.provision_receptionist", decision: "allow", reason: "Approved automatically by the dashboard: approved everything." },
    ]);
    expect(store.read().auto_approvals).toHaveLength(2);
  });

  it("leaves a question for a person, and says when the platform is rate-limiting", async () => {
    const store = openStoreOver(emptyState(), () => {});
    const asked = { ...session, pending_actions: [{ kind: "question", name: "ask_operator", tool_call_id: "q" }] };
    const once = vi.fn(async () => new Response(JSON.stringify({ data: [asked] }), { status: 200 })) as unknown as typeof fetch;
    expect(await autoApprove(config, store, new Date(), once)).toEqual({ approved: [], left: 1 });
    // The public site is public: the SEO seat's update_site waits for a person, like a question.
    const site = { ...session, pending_actions: [tool("dashboard.update_site", { site: { hero: {} } })] };
    const siteOnce = vi.fn(async () => new Response(JSON.stringify({ data: [site] }), { status: 200 })) as unknown as typeof fetch;
    expect(await autoApprove(config, store, new Date(), siteOnce)).toEqual({ approved: [], left: 1 });
    const limited = vi.fn(async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    expect(await autoApprove(config, store, new Date(), limited)).toEqual({ approved: [], left: 0, rate_limited: true });
  });

  it("approves nothing while the company is paused", async () => {
    const store = openStoreOver(emptyState(), () => {});
    store.setCompany({ paused: true, changed_at: "x", interrupted: [], deployments: [] });
    const { confirmed, fetchImpl } = platform();
    expect(await autoApprove(config, store, new Date(), fetchImpl)).toEqual({ approved: [], left: 0 });
    expect(confirmed).toHaveLength(0);
  });
});
