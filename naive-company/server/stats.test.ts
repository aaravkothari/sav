import { describe, expect, it } from "vitest";
import type { Client } from "../seed/clients.ts";
import { companyStats } from "./stats.ts";

const shop = (id: string, notes: string[]): Client => ({
  id, slug: id, name: `Shop ${id}`, domain: `${id}.example`, stage: "lead", services: [],
  contact: { name: "Owner Name", email: `owner@${id}.example`, role: "Owner" }, notes,
});

describe("companyStats", () => {
  const clients = [
    shop("a", ["RESEARCH: 4.9 on 597 reviews", "RECEPTIONIST: shop_id a, demo_url https://x/demo/a", "OUTREACH DRAFTED: d1 to owner@a.example", "CALL: c1 ok", "CALL: c2 ok"]),
    shop("b", ["RESEARCH: 4.5 on 120 reviews", "OUTREACH DRAFTED: d2", "OUTREACH DRAFTED: d3 (follow-up)", "SAID YES: started a free week", "OUTREACH SENT: m1 to owner@b.example", "REPLY SENT: m2"]),
    shop("c", ["Demo row: replace it with a shop of your own."]),
  ];

  it("counts what the crew filed, by note prefix", () => {
    expect(companyStats(clients, new Date("2026-11-08T01:00:00Z"))).toEqual({
      leads_found: 2, demos_built: 1, drafts_written: 3, free_week_yes: 1, calls_reviewed: 2,
      emails_sent: 2, self_improvement_proposals: null, updated_at: "2026-11-08T01:00:00.000Z",
    });
  });

  it("never carries a name, an email, a note or an id", () => {
    const text = JSON.stringify(companyStats(clients, new Date()));
    for (const leak of ["owner@", "Owner Name", "Shop a", "597", "demo_url", "d1"]) expect(text).not.toContain(leak);
  });
});
