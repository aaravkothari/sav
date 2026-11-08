import { describe, expect, it } from "vitest";
import type { Client } from "./data";
import { agentLabel, cityOf, eventsOf, leadOf, scrub, sectorOf, statusOf, timeIn } from "./leads";

const shop = (notes: string[], extra: Partial<Client> = {}): Client => ({
  id: "cli_1", slug: "pats", name: "Pat's Garage", domain: "patsgarage.com", stage: "lead", services: [],
  contact: { name: "Pat Banks", email: "pat@patsgarage.com", role: "Owner" }, notes, ...extra,
});

describe("a lead's status", () => {
  it("walks the funnel by the notes the crew filed", () => {
    expect(statusOf(shop(["RESEARCH: 4.9 on 300 reviews"])).status).toBe("researched");
    expect(statusOf(shop(["RESEARCH: x", "OUTREACH SENT: abc to pat@patsgarage.com\n\nHi Pat"])).status).toBe("emailed");
    expect(statusOf(shop(["RESEARCH: x", "OUTREACH SENT: a", "REPLY RECEIVED: sounds good"])).status).toBe("replied");
    expect(statusOf(shop(["OUTREACH SENT: a", "REPLY RECEIVED: ok", "REPLY SENT: b\n\nHear it: https://x.trycloudflare.com/demo/pats"])).status).toBe("demo");
    expect(statusOf(shop(["FREE WEEK STARTED: Pat's Garage"])).status).toBe("free_week");
    expect(statusOf(shop(["SAID YES: started a free week from the demo page"])).status).toBe("free_week");
    expect(statusOf(shop(["PAID: $99"])).status).toBe("paying");
  });

  it("does not count a draft or a pre-built demo as outreach", () => {
    const l = leadOf(shop(["RESEARCH: x", "OUTREACH DRAFTED: a to pat@patsgarage.com\n\nHi", "Demo receptionist built (voice shop_id pats-garage).\nDemo page: https://x/demo/pats"]));
    expect(l.status).toBe("researched");
    expect(l.demoReady).toBe(true);
  });

  it("marks a bounce, unless the shop got further anyway", () => {
    expect(statusOf(shop(["OUTREACH SENT: a", "BOUNCED: mailbox full"])).status).toBe("bounced");
    expect(statusOf(shop(["OUTREACH SENT: a", "BOUNCED: x", "REPLY RECEIVED: from the owner's own address"])).status).toBe("replied");
  });

  it("treats a message the shop wrote as a reply before any note says so", () => {
    const l = leadOf(shop(["OUTREACH SENT: a"]), [{ direction: "received", counterpart: "pat@patsgarage.com", subject: "Re: hi", preview: "Yes", at: "2026-11-08T05:00:00Z" }]);
    expect(l.status).toBe("replied");
    expect(l.lastAt).toBe("2026-11-08T05:00:00Z");
  });
});

describe("what a note says", () => {
  it("drops machine ids and the outreach bookkeeping line, and keeps the email", () => {
    const [e] = eventsOf(shop(["OUTREACH SENT: c15ef123-796a-477b-aa41-d9c4b04e4692 to pat@patsgarage.com\n\nHi Pat,\n\nShort note."]));
    expect(e!.title).toBe("Emailed Pat Banks");
    expect(e!.body).toBe("Hi Pat,\n\nShort note.");
    expect(scrub("built (voice shop_id pats-garage). session ses_abc agent agt_x9")).not.toMatch(/shop_id|ses_|agt_|pats-garage/);
  });

  it("takes a time only when the note gives a time, not a date about the shop", () => {
    expect(timeIn("sent at 2026-11-08 ~04:20Z from aarav")).toBe("2026-11-08T04:20:00.000Z");
    expect(timeIn("owner contact valid as of 2026-10-26")).toBeNull();
  });

  it("finds the city and the sector", () => {
    expect(cityOf(shop(["RESEARCH: Phone (650) 595-2860, 1700 El Camino Real, San Carlos, CA 94070."]))).toBe("San Carlos");
    expect(cityOf(shop(["RESEARCH: 1090 26th St (Dogpatch, 94107)"]))).toBe("San Francisco");
    expect(sectorOf(shop([], { name: "Chestnut Towing" }))).toBe("Towing");
    expect(sectorOf(shop(["RESEARCH: Auto repair shop rated 5"]))).toBe("Auto repair");
  });
});

describe("an agent's name", () => {
  it("reads as a person would say it, never as an id", () => {
    expect(agentLabel("client-manager")).toBe("Client manager");
    expect(agentLabel("booking--pats-garage")).toBe("Pats Garage receptionist");
    expect(agentLabel("agt_mceqa9m7j7dy1d7xxevqzw5d9p")).toBe("An agent");
  });
});
