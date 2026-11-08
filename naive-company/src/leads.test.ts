import { describe, expect, it } from "vitest";
import type { Client } from "./data";
import { agentLabel, cityOf, demoLink, eventsOf, findLead, funnelOf, leadOf, leadPath, mailFor, mailKind, mailToday, nextStepText, readableWeek, researchText, scrub, sectorOf, shopName, statusOf, timeIn, type MailMessage } from "./leads";

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

describe("the funnel's counts", () => {
  const msg = (direction: MailMessage["direction"], counterpart: string, subject = "Hi", preview = "", at = "2026-11-08T08:00:00Z"): MailMessage =>
    ({ direction, counterpart, subject, preview, at });

  it("tells our own test traffic, a bounce report and an auto-reply from a real reply", () => {
    expect(mailKind(msg("sent", "aarav.sav@agentmail.to", "engine self-test"))).toBe("internal");
    expect(mailKind(msg("received", "mailer-daemon@amazonses.com", "Delivery Status Notification (Failure)"))).toBe("bounce");
    expect(mailKind(msg("received", "postmaster@shop.com", "Returned mail"))).toBe("bounce");
    expect(mailKind(msg("received", "pat@patsgarage.com", "Automatic reply: Hi"))).toBe("auto");
    expect(mailKind(msg("received", "pat@patsgarage.com", "Re: Hi"))).toBe("real");
  });

  it("does not count a bounce notice, an auto-reply or a setup email as a reply", () => {
    const sent = shop(["RESEARCH: x", "OUTREACH SENT: a to pat@patsgarage.com\n\nHi"]);
    const bounce = msg("received", "mailer-daemon@amazonses.com", "Delivery Status Notification (Failure)", "could not deliver to pat@patsgarage.com");
    expect(leadOf(sent, [bounce]).status).toBe("bounced");
    expect(leadOf(sent, [msg("received", "pat@patsgarage.com", "Out of office")]).status).toBe("emailed");
    expect(leadOf(sent, [msg("received", "pat@patsgarage.com", "Re: Hi")]).status).toBe("replied");
    // Onboarding questions sent to a shop is not the shop saying anything.
    expect(statusOf(shop(["RESEARCH: x", "ONBOARDING SENT: q sent to pat@patsgarage.com"])).status).toBe("researched");
    expect(statusOf(shop(["RESEARCH: x", "ONBOARDING BLOCKED — NO EMAIL ON FILE"])).status).toBe("researched");
    expect(statusOf(shop(["OUTREACH SENT: a", "SAID YES: the owner wants it"])).status).toBe("replied");
  });

  it("never matches our own inbox, or two shops on one webmail domain", () => {
    const gmail = shop([], { domain: "gmail.com", contact: { name: "", email: "bob@gmail.com", role: "" } });
    expect(mailFor(gmail, [msg("received", "someone-else@gmail.com")])).toHaveLength(0);
    expect(mailFor(gmail, [msg("received", "bob@gmail.com")])).toHaveLength(1);
    const ours = shop([], { domain: "agentmail.to", contact: { name: "", email: "aarav.sav@agentmail.to", role: "" } });
    expect(mailFor(ours, [msg("sent", "aarav.sav@agentmail.to", "engine self-test")])).toHaveLength(0);
  });

  it("counts every step once: emailed includes the bounced shop, replied only real replies", () => {
    const leads = [
      leadOf(shop(["RESEARCH: x"], { id: "cli_1" })),
      leadOf(shop(["RESEARCH: x", "OUTREACH SENT: a"], { id: "cli_2" })),
      leadOf(shop(["RESEARCH: x", "OUTREACH SENT: a", "BOUNCED: a", "BOUNCED: report"], { id: "cli_3" })),
      leadOf(shop(["RESEARCH: x", "OUTREACH SENT: a", "REPLY RECEIVED: yes"], { id: "cli_4" })),
    ];
    expect(funnelOf(leads)).toEqual({ shops: 4, emailed: 3, bounced: 1, replied: 1, demo: 0, free_week: 0, paying: 0 });
    // Two BOUNCED notes for one email are one event on the timeline.
    expect(leads[2]!.events.filter((e) => e.kind === "bounced")).toHaveLength(1);
  });

  it("counts today's mail without self-tests, bounces or auto-replies", () => {
    const now = new Date("2026-11-08T12:00:00Z");
    const mail = [
      msg("sent", "pat@patsgarage.com"), msg("sent", "aarav.sav@agentmail.to"),
      msg("received", "mailer-daemon@amazonses.com", "Undeliverable"), msg("received", "pat@patsgarage.com", "Auto-reply"),
      msg("received", "pat@patsgarage.com", "Re: Hi"), msg("sent", "x@y.com", "Hi", "", "2026-11-01T08:00:00Z"),
    ];
    expect(mailToday(mail, now)).toEqual({ sent: 1, replies: 1, bounces: 1 });
  });
});

describe("what the operator reads", () => {
  it("shows a bounce as a fact, without the SMTP report", () => {
    const [, e] = eventsOf(shop(["OUTREACH SENT: a", "BOUNCED: <x@amazonses.com> to pat@patsgarage.com\nDiagnostic-Code: smtp; 550"]));
    expect(e!.title).toBe("Email to Pat's Garage bounced");
    expect(e!.body).toBe("");
  });

  it("reads research as sentences, with the hours as a week", () => {
    const text = researchText("Rated 4.9. Hours: mon 8:30-17:00; tue 8:30-17:00; wed 8:30-17:00; thu 8:30-17:00; fri 8:30-17:00; sat closed; sun closed. Fit: busy enough.\nOpener detail: you've serviced European cars since 1989\nSector: auto repair");
    expect(text).toBe("Rated 4.9. Hours: Mon–Fri 8:30–5, Sat–Sun closed. Busy enough. You've serviced European cars since 1989.");
    expect(readableWeek({ mon: "9:00-18:00", tue: "9:00-18:00", wed: "closed", sat: "10-14" })).toBe("Mon–Tue 9–6, Wed closed, Sat 10–2");
    expect(researchText("Hours Mon–Fri 8–17, closed weekends.")).toBe("Hours Mon–Fri 8–5, closed weekends.");
  });

  it("links the demo on the voice service's base, or not at all", () => {
    expect(demoLink("RECEPTIONIST: shop_id a\ndemo_url /demo/a\npreview", "https://voice.example/")).toBe("https://voice.example/demo/a");
    expect(demoLink("RECEPTIONIST: shop_id a\ndemo_url /demo/a\npreview", null)).toBeNull();
    expect(demoLink("RECEPTIONIST: shop_id m · demo_url https://t.example/demo/m · portal_url https://t.example/portal/m?t=1", null)).toBe("https://t.example/demo/m");
  });

  it("drops a listing's SEO tail from a shop's name", () => {
    expect(shopName("A-1 Imports Autoworks - Auto Repair Shop In San Rafael")).toBe("A-1 Imports Autoworks");
    expect(shopName("Michael & Company Auto Body And Auto Repair Shop in San Jose, Ca.")).toBe("Michael & Company Auto Body And Auto Repair");
    expect(shopName("House of Brakes, Complete Automotive Repair")).toBe("House of Brakes");
    expect(shopName("Family Auto Care in Sunnyvale CA.")).toBe("Family Auto Care");
    expect(shopName("Pat's Garage")).toBe("Pat's Garage");
    expect(shopName("A-1 Auto")).toBe("A-1 Auto");
  });

  it("turns an agent's instruction into a next step a person reads", () => {
    expect(nextStepText("Waiting for Pat's answers in aarav.sav@agentmail.to — file them as RECEPTIONIST CONFIG when they arrive, then move to active")).toBe("Waiting for the owner's setup answers");
    expect(nextStepText("Wait for a reply")).toBe("Wait for a reply");
    expect(nextStepText("")).toBeNull();
  });
});

describe("a shop's address", () => {
  it("is its slug, and an old cli_ link still finds it", () => {
    const leads = [leadOf(shop([], { id: "cli_1", slug: "pats-garage" })), leadOf(shop([], { id: "cli_2", slug: "" }))];
    expect(leadPath(leads[0]!.client)).toBe("/leads/pats-garage");
    expect(leadPath(leads[1]!.client)).toBe("/leads/cli_2");
    expect(findLead(leads, "pats-garage")?.client.id).toBe("cli_1");
    expect(findLead(leads, "cli_1")?.client.id).toBe("cli_1");
    expect(findLead(leads, "cli_2")?.client.id).toBe("cli_2");
    expect(findLead(leads, "nobody")).toBeUndefined();
  });
});

describe("an agent's name", () => {
  it("reads as a person would say it, never as an id", () => {
    expect(agentLabel("client-manager")).toBe("Client manager");
    expect(agentLabel("booking--pats-garage")).toBe("Pats Garage receptionist");
    expect(agentLabel("agt_mceqa9m7j7dy1d7xxevqzw5d9p")).toBe("An agent");
  });
});
