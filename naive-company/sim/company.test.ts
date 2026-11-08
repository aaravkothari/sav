/**
 * The one end-to-end test of the company's wiring: the CEO delegates, agents return results, the
 * board tracks progress, and nothing waits for a person: the crew asks no permission. Offline and free: it plays the
 * same crew and `PIPELINE` that `naive up` applies, against the local board in `sim/runtime.ts`.
 */
import { describe, expect, it } from "vitest";
import config from "../naive.config.ts";
import { PIPELINE } from "../templates/receptionist.ts";
import { mockCeo, mockHandlers } from "./mock-agents.ts";
import { CEO, LocalCompany } from "./runtime.ts";

const OWNERS = PIPELINE.map((step) => step.owner);

describe("the company", () => {
  it("CEO delegates, agents report back, progress is tracked, and nothing waits on the operator", () => {
    const company = new LocalCompany(mockCeo, mockHandlers);

    // 1. Trigger: the CEO puts the pipeline on its board and hands each card to its owner.
    let progress = company.start("Sign up our first auto repair shop in Austin, TX");
    expect(company.cards.map((c) => c.assignee)).toEqual(OWNERS);
    const assigned = company.events.filter((e) => e.type === "card.assigned");
    expect(assigned.every((e) => e.from === CEO.name)).toBe(true);

    // 2. Research returned a result, outreach sent without asking, and every seat finished.
    expect((company.byKey("research").result as { leads: unknown[] }).leads).toHaveLength(3);
    expect(company.pendingApprovals()).toEqual([]);
    expect(progress.percent).toBe(100);
    expect(company.cards.every((c) => c.status === "done" && c.note)).toBe(true);

    // Results flow downstream: the test call was booked for the shop onboarding set up.
    const booked = company.byKey("test-call").result as { appointments: { shop: string }[] };
    expect(booked.appointments[0]?.shop).toBe("Mock Motors");

    // 4. Every finished card was reported to the CEO, and the CEO reported to the operator.
    const reportedBack = company.events.filter((e) => e.type === "card.done" && e.to === CEO.name).map((e) => e.from);
    expect(reportedBack).toEqual(OWNERS);
    expect(company.events.filter((e) => e.type === "ceo.digest")).toHaveLength(6); // one per finished card
    expect(company.events.at(-1)?.type).toBe("ceo.report");
  });

  it("runs a second goal start to finish with no approval at any step", () => {
    const company = new LocalCompany(mockCeo, mockHandlers);
    company.start("Find shops in Denver");
    expect(company.events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(company.progress().percent).toBe(100);
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

  it("asks no permission for any tool it holds, and denies every tool it does not name", () => {
    for (const agent of config.agents) {
      expect(agent.tools?.default_config.permission).toBe("deny");
      const asks = Object.entries(agent.tools?.configs ?? {}).filter(([, c]) => c.permission === "ask").map(([name]) => name);
      expect([agent.name, asks]).toEqual([agent.name, ["ask_operator"]]);
    }
  });
});
