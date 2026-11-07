/**
 * The one end-to-end test of the company's wiring: the CEO delegates, agents return results, the
 * board tracks progress, and external actions wait for a person. Offline and free: it plays the
 * same crew and `PIPELINE` that `naive up` applies, against the local board in `sim/runtime.ts`.
 */
import { describe, expect, it } from "vitest";
import config from "../naive.config.ts";
import { PIPELINE } from "../templates/receptionist.ts";
import { mockCeo, mockHandlers } from "./mock-agents.ts";
import { CEO, LocalCompany } from "./runtime.ts";

const OWNERS = PIPELINE.map((step) => step.owner);

describe("the company", () => {
  it("CEO delegates, agents report back, progress is tracked, sends are approval-gated", () => {
    const company = new LocalCompany(mockCeo, mockHandlers);

    // 1. Trigger: the CEO puts the pipeline on its board and hands each card to its owner.
    let progress = company.start("Sign up our first auto repair shop in Austin, TX");
    expect(company.cards.map((c) => c.assignee)).toEqual(OWNERS);
    const assigned = company.events.filter((e) => e.type === "card.assigned");
    expect(assigned.every((e) => e.from === CEO.name)).toBe(true);

    // 2. Research returned a result; outreach is parked on an approval; nothing downstream started.
    expect(company.byKey("research").status).toBe("done");
    expect((company.byKey("research").result as { leads: unknown[] }).leads).toHaveLength(3);
    expect(company.byKey("outreach").status).toBe("blocked");
    expect(company.byKey("onboarding").status).toBe("todo");
    expect(progress).toEqual({ todo: 4, doing: 0, blocked: 1, done: 1, total: 6, percent: 17 });

    const [approval] = company.pendingApprovals();
    expect(approval).toMatchObject({ agent: "sales", tool: "email.send" });

    // 3. The operator approves; the board resumes and every seat finishes.
    progress = company.confirm(approval!.id, "allow");
    expect(progress.percent).toBe(100);
    expect(company.cards.every((c) => c.status === "done" && c.note)).toBe(true);

    // Results flow downstream: the test call was booked for the shop onboarding set up.
    const booked = company.byKey("test-call").result as { appointments: { shop: string }[] };
    expect(booked.appointments[0]?.shop).toBe("Mock Motors");

    // 4. Every finished card was reported to the CEO, and the CEO reported to the operator.
    const reportedBack = company.events.filter((e) => e.type === "card.done" && e.to === CEO.name).map((e) => e.from);
    expect(reportedBack).toEqual(OWNERS);
    expect(company.events.filter((e) => e.type === "ceo.digest")).toHaveLength(7); // 6 done + 1 blocked
    expect(company.events.at(-1)?.type).toBe("ceo.report");
  });

  it("respects a denied send and still finishes cleanly", () => {
    const company = new LocalCompany(mockCeo, mockHandlers);
    company.start("Find shops in Denver");
    company.confirm(company.pendingApprovals()[0]!.id, "deny");
    expect(company.progress().percent).toBe(100);
    expect(company.byKey("outreach").note).toMatch(/nothing sent/);
    expect((company.byKey("onboarding").result as { shop: null }).shop).toBeNull();
  });
});

describe("naive.config.ts", () => {
  it("runs the agency blueprint's blank template with our crew", () => {
    expect([config.blueprint, config.template]).toEqual(["agency", "blank"]);
    expect(config.agents.map((a) => a.name)).toEqual(["research", "sales", "client-manager", "monitoring", "self-improvement"]);
    expect((config.crew_per_client ?? []).map((a) => a.name)).toEqual(["booking"]);
  });

  it("seeds the CEO's board with the pipeline, unassigned, so `naive up` starts nothing", () => {
    expect(config.tasks.map((t) => t.key)).toEqual(PIPELINE.map((s) => s.key));
    expect(config.tasks.every((t) => t.assignee === undefined)).toBe(true);
    for (const agent of config.agents) {
      expect([agent.name, agent.intake, agent.schedules]).toEqual([agent.name, undefined, []]);
    }
  });

  it("keeps every external tool behind approval, and everything else denied by default", () => {
    for (const agent of config.agents) {
      expect(agent.tools?.default_config.permission).toBe("deny");
      for (const tool of ["email.send", "web_search", "web_fetch", "data_run", "phone.send"]) {
        const permission = agent.tools?.configs[tool]?.permission;
        expect([agent.name, tool, permission === undefined || permission === "ask"]).toEqual([agent.name, tool, true]);
      }
    }
  });
});
