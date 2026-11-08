import { describe, expect, it } from "vitest";
import {
  badRate, baseLevel, batchSize, BAD_RATE, MAX_LEVEL, isAutoSector, sectorOf, coldKey, isRateLimit, SECTORS_LIVE, bouncedAddress, classifyInbound, DAILY_SEND_CAP, latestByEmail, matchClient, next4amPacific,
  parseAddress, parseArgs, replyNote, selectCandidates, sentNote, wakeMessage, type CrmClient, type InboundMessage, type LedgerRow,
} from "./engine.ts";

const client = (id: string, over: Partial<CrmClient> = {}): CrmClient => ({
  id, name: `Shop ${id}`, domain: `${id}.example`, stage: "lead",
  contact: { name: "Pat Banks", email: `pat@${id}.example`, role: "Owner" },
  notes: ["RESEARCH: 4.9 with 582 reviews. Opener detail: 557 of 582 Google reviews are five stars."], ...over,
});

describe("the ramp", () => {
  // 23:30 PT Nov 7 = 07:30Z Nov 8.
  const start = new Date("2026-11-08T07:30:00Z");
  const at = (h: number) => new Date(start.getTime() + h * 3_600_000);

  it("is 25 for 2 h after the first start, 50 until 04:00 PT, then 100 when the cap allows it", () => {
    expect(next4amPacific(start).toISOString()).toBe("2026-11-08T12:00:00.000Z");
    expect(baseLevel(start, at(0), 2)).toBe(0);
    expect(baseLevel(start, at(1.99), 2)).toBe(0);
    expect(baseLevel(start, at(2), 2)).toBe(1);
    expect(baseLevel(start, at(4.49), 2)).toBe(1);
    expect(baseLevel(start, at(4.5), 2)).toBe(2);
    expect(batchSize(start, at(6), null, 0, 2).size).toBe(100);
  });

  it("tops out at 50 tonight by default (Vedant's cap, the stricter one)", () => {
    expect(MAX_LEVEL).toBe(1);
    expect(batchSize(start, at(0), null, 0).size).toBe(25);
    expect(batchSize(start, at(3), null, 0).size).toBe(50);
    expect(batchSize(start, at(6), null, 0).size).toBe(50);
  });

  it("skips straight to 100 when the 2 h end after 04:00 PT and the cap allows it", () => {
    const late = new Date("2026-11-08T11:00:00Z"); // 03:00 PT
    expect(baseLevel(late, new Date("2026-11-08T13:00:01Z"), 2)).toBe(2);
  });

  it("steps down one level when bounces plus failures exceed 3% of the last tick", () => {
    const ok = { at: "", sent: 50, failed: 0, bounced: 1 }; // 1/50
    const bad = { at: "", sent: 50, failed: 1, bounced: 1 }; // 2/51
    expect(badRate(ok)).toBeLessThanOrEqual(BAD_RATE);
    expect(batchSize(start, at(6), ok, 0)).toMatchObject({ size: 50, level: 1 });
    expect(batchSize(start, at(6), bad, 0)).toMatchObject({ size: 25, level: 0, stepped_down: true });
    expect(batchSize(start, at(6), bad, 0, 2)).toMatchObject({ size: 50, level: 1, stepped_down: true });
    expect(batchSize(start, at(0), bad, 0)).toMatchObject({ size: 25, level: 0 });
    expect(badRate({ at: "", sent: 0, failed: 0, bounced: 0 })).toBe(0);
  });

  it("never goes past the daily cap", () => {
    expect(batchSize(start, at(6), null, DAILY_SEND_CAP - 10).size).toBe(10);
    expect(batchSize(start, at(6), null, DAILY_SEND_CAP).size).toBe(0);
  });
});

describe("isRateLimit", () => {
  it("tells a provider limit from a bad address", () => {
    expect(isRateLimit('POST /v0/inboxes/x/messages/send: HTTP 429 {"name":"RateLimitError"}')).toBe(true);
    expect(isRateLimit("HTTP 400 ValidationError")).toBe(false);
  });
});

describe("coldKey", () => {
  it("is stable per address and uses only the characters AgentMail allows", () => {
    expect(coldKey("Pat@Shop.com")).toBe(coldKey("pat@shop.com"));
    expect(coldKey("pat@shop.com")).not.toBe(coldKey("sam@shop.com"));
    expect(coldKey("o'brien+x@shop.com")).toMatch(/^[A-Za-z0-9._~-]+$/);
  });
});

describe("sectors (#52 review)", () => {
  it("sends the auto template only to auto shops, and the general one to other sectors", () => {
    expect(sectorOf("RESEARCH: rated 4.8.\nSector: salon")).toBe("salon");
    expect(sectorOf("RESEARCH: rated 4.8. Opener detail: x")).toBeNull();
    expect(isAutoSector(null)).toBe(true);
    expect(isAutoSector("auto repair")).toBe(true);
    expect(isAutoSector("physical therapy")).toBe(false);
    const salon = client("s1", { notes: ["RESEARCH: rated 4.8. Opener detail: you've styled Oakland since 1990\nSector: salon"] });
    const { candidates, skipped } = selectCandidates([salon], new Set());
    if (!SECTORS_LIVE) {
      expect(candidates).toHaveLength(0);
      expect(skipped[0]!.reason).toMatch(/#47/);
      return;
    }
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.text).not.toMatch(/Automotive Service Association|auto repair/);
    expect(candidates[0]!.text).toContain("nobody picks up or your salon is closed?");
  });
});

describe("selectCandidates", () => {
  it("takes leads with an email, a RESEARCH detail and no outreach yet, and renders the email", () => {
    const { candidates } = selectCandidates([client("a")], new Set());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.email).toBe("pat@a.example");
    expect(candidates[0]!.subject).toBe("Missed calls at Shop a");
    expect(candidates[0]!.text).toContain("noticed 557 of 582 Google reviews are five stars.\n");
  });

  it("never mails an address twice, and skips everything that is not a cold lead", () => {
    const clients = [
      client("a"),
      client("dup", { contact: { name: "Pat", email: " PAT@a.example ", role: "" } }),
      client("mailed"),
      client("noemail", { contact: { name: "Pat", email: "", role: "" } }),
      client("bad", { contact: { name: "Pat", email: "not an email", role: "" } }),
      client("sent", { notes: [...client("x").notes, "OUTREACH SENT: m1 to pat@sent.example"] }),
      client("drafted", { notes: [...client("x").notes, "OUTREACH DRAFTED: d1"] }),
      client("bounced", { notes: [...client("x").notes, "BOUNCED: m2 to pat@bounced.example"] }),
      client("proposal", { stage: "proposal" }),
      client("nores", { notes: ["Some note"] }),
      client("nodetail", { notes: ["RESEARCH: busy shop, no opener"] }),
    ];
    const { candidates, skipped } = selectCandidates(clients, new Set(["pat@mailed.example"]));
    expect(candidates.map((c) => c.client.id)).toEqual(["a"]);
    expect(Object.fromEntries(skipped.map((s) => [s.client.id, s.reason]))).toEqual({
      dup: "address already emailed",
      mailed: "address already emailed",
      noemail: "no contact email",
      bad: "contact email is not an address",
      sent: "already contacted (CRM note)",
      drafted: "already contacted (CRM note)",
      bounced: "already contacted (CRM note)",
      proposal: "stage is proposal, not lead",
      nores: "no RESEARCH note",
      nodetail: "no usable detail in RESEARCH note",
    });
  });

  it("files the full email in the sent note", () => {
    expect(sentNote("<m1@agentmail.to>", "pat@a.example", "Missed calls at A", "Hi Pat,\n\nBody")).toBe(
      "OUTREACH SENT: <m1@agentmail.to> to pat@a.example\n\nSubject: Missed calls at A\n\nHi Pat,\n\nBody");
  });

  it("reads the ledger's latest row per address", () => {
    const row = (noted: boolean): LedgerRow => ({ email: "pat@a.example", client_id: "a", message_id: "m", thread_id: null, at: "t", noted });
    expect(latestByEmail([row(false), row(true)]).get("pat@a.example")?.noted).toBe(true);
  });
});

const inbound = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  message_id: "<r1@mail>", thread_id: "thr_1", from: "Pat Banks <Pat@a.example>", subject: "Re: Missed calls at Shop a",
  text: "Sure, tell me more. What does it cost?", labels: ["received"], ...over,
});
const OWN = "aarav.sav@agentmail.to";

describe("the inbox watcher", () => {
  it("tells a reply from a bounce and an auto-reply", () => {
    expect(classifyInbound(inbound(), OWN)).toBe("reply");
    expect(classifyInbound(inbound({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)" }), OWN)).toBe("bounce");
    expect(classifyInbound(inbound({ from: "postmaster@outlook.com", subject: "Undeliverable: Missed calls" }), OWN)).toBe("bounce");
    expect(classifyInbound(inbound({ subject: "Out of Office: Re: Missed calls" }), OWN)).toBe("auto-reply");
    expect(classifyInbound(inbound({ subject: "Automatic reply: Missed calls" }), OWN)).toBe("auto-reply");
    expect(classifyInbound(inbound({ text: "I am currently out of the office until Monday." }), OWN)).toBe("auto-reply");
    expect(classifyInbound(inbound({ from: `Aarav from SAV <${OWN}>` }), OWN)).toBe("own");
  });

  it("finds which address bounced", () => {
    expect(bouncedAddress(inbound({ text: "Your message wasn't delivered to pat@a.example because the address couldn't be found." }), ["pat@b.example", "pat@a.example"])).toBe("pat@a.example");
    expect(bouncedAddress(inbound({ text: "no address here" }), ["pat@a.example"])).toBeNull();
  });

  it("matches the sender by email, then by domain, never by free mail", () => {
    const clients = [client("a"), client("b", { domain: "www.bshop.com", contact: { name: "", email: "", role: "" } }), client("g", { contact: { name: "Gail", email: "gail@gmail.com", role: "" } })];
    expect(matchClient(parseAddress("Pat <PAT@a.example>"), clients)?.id).toBe("a");
    expect(matchClient("service@bshop.com", clients)?.id).toBe("b");
    expect(matchClient("gail@gmail.com", clients)?.id).toBe("g");
    expect(matchClient("someone@gmail.com", clients)).toBeNull();
    expect(matchClient("x@elsewhere.example", clients)).toBeNull();
  });

  it("files the reply verbatim and wakes client-manager with one field per line", () => {
    const msg = inbound();
    expect(replyNote(msg)).toBe("REPLY RECEIVED: thr_1\nFrom: Pat Banks <Pat@a.example>\nSubject: Re: Missed calls at Shop a\nMessage: <r1@mail>\n\nSure, tell me more. What does it cost?");
    expect(wakeMessage(client("a", { id: "cli_a", name: "Pat's Garage" }), msg).split("\n")).toEqual([
      "SHOP REPLIED: Pat's Garage",
      "client_id: cli_a",
      "thread_id: thr_1",
      "shop email: pat@a.example",
      "reply: Sure, tell me more. What does it cost?",
    ]);
  });
});

describe("parseArgs", () => {
  it("is a dry run unless told otherwise", () => {
    expect(parseArgs([])).toEqual({ execute: false, once: false });
    expect(parseArgs(["--once"])).toEqual({ execute: false, once: true });
    expect(parseArgs(["--execute", "--once"])).toEqual({ execute: true, once: true });
    expect(() => parseArgs(["--execute", "--dry-run"])).toThrow();
    expect(() => parseArgs(["--send"])).toThrow();
  });
});
