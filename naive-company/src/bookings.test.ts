import { describe, expect, it } from "vitest";
import {
  bookingKind, bookingRows, buildPrepScript, callsOf, callTimeLabel, cleanFeedback, feedbackLines, formatScriptNote, parseCallTime,
  scriptNoteOf, scriptText, whenText, type ScriptInput,
} from "./bookings";
import type { Client } from "./data";
import { eventsOf } from "./leads";

const shop = (notes: string[], over: Partial<Client> = {}): Client => ({
  id: "cli_test1",
  slug: "pats-garage",
  name: "Pat's Garage - Auto Repair in San Mateo",
  domain: "patsgarage.com",
  stage: "proposal",
  services: [],
  contact: { name: "Pat Banks", email: "pat@patsgarage.com", role: "Owner" },
  notes,
  ...over,
});

// Sat Nov 7 2026, 12:00 PT. Nov 9 is the Monday after.
const REF = new Date("2026-11-07T20:00:00Z");

describe("reading a call time", () => {
  it("reads ISO times, with and without a zone, in Pacific time by default", () => {
    expect(parseCallTime("2026-11-09 10:00 PT", REF)).toBe("2026-11-09T18:00:00.000Z");
    expect(parseCallTime("2026-11-09 10:00", REF)).toBe("2026-11-09T18:00:00.000Z");
    expect(parseCallTime("2026-11-09T10:00-08:00", REF)).toBe("2026-11-09T18:00:00.000Z");
    expect(parseCallTime("2026-11-09 13:00 ET", REF)).toBe("2026-11-09T18:00:00.000Z");
    expect(parseCallTime("2026-11-09 10:00 America/Los_Angeles", REF)).toBe("2026-11-09T18:00:00.000Z");
    expect(parseCallTime("2026-11-09 2pm PT", REF)).toBe("2026-11-09T22:00:00.000Z");
  });

  it("handles summer time", () => {
    expect(parseCallTime("2026-07-01 10:00 PT", REF)).toBe("2026-07-01T17:00:00.000Z");
  });

  it("reads month names, slashes, weekdays and tomorrow against the reference day", () => {
    expect(parseCallTime("Mon Nov 9, 2:30pm PT", REF)).toBe("2026-11-09T22:30:00.000Z");
    expect(parseCallTime("November 10th at 9 am", REF)).toBe("2026-11-10T17:00:00.000Z");
    expect(parseCallTime("11/9 10am", REF)).toBe("2026-11-09T18:00:00.000Z");
    expect(parseCallTime("Tuesday at 2", REF)).toBe("2026-11-10T22:00:00.000Z");
    expect(parseCallTime("tomorrow 11:00", REF)).toBe("2026-11-08T19:00:00.000Z");
    expect(parseCallTime("Jan 5 at 10am", REF)).toBe("2027-01-05T18:00:00.000Z");
  });

  it("does not invent a time when only a day is given", () => {
    expect(parseCallTime("Tuesday afternoon", REF)).toBeNull();
    expect(parseCallTime("next week sometime", REF)).toBeNull();
    expect(parseCallTime("2026-11-09", REF)).toBeNull();
  });

  it("drops the calendar bookkeeping from what the page shows", () => {
    expect(whenText("2026-11-09 10:00 PT, no calendar")).toBe("2026-11-09 10:00 PT");
    expect(whenText("Mon Nov 9 10am PT event 7hd8s9f0abc")).toBe("Mon Nov 9 10am PT");
    expect(whenText("2026-11-09 10:00 PT (calendar event abc123)")).toBe("2026-11-09 10:00 PT");
    expect(whenText("")).toBe("Time not set yet");
  });

  it("labels a time in Pacific time, and keeps the words when there is no time", () => {
    expect(callTimeLabel({ at: "2026-11-09T18:00:00.000Z", when: "x" })).toBe("Mon, Nov 9, 10:00 AM PT");
    expect(callTimeLabel({ at: null, when: "Tuesday afternoon" })).toBe("Tuesday afternoon");
  });
});

describe("reading the bookings out of the notes", () => {
  it("knows its prefixes, and the timeline no longer calls a booking 'a call came in'", () => {
    expect(bookingKind("CALL BOOKED: 2026-11-09 10:00 PT")).toBe("booked");
    expect(bookingKind("CALL REQUESTED: Tuesday")).toBe("requested");
    expect(bookingKind("MEETING SCRIPT: …")).toBe("script");
    expect(bookingKind("MEETING FEEDBACK: …")).toBe("feedback");
    expect(bookingKind("CALL: 019a… outcome info")).toBeNull();
    const titles = eventsOf(shop(["CALL REQUESTED: Tuesday", "CALL BOOKED: 2026-11-10 14:00 PT", "MEETING SCRIPT: x", "MEETING FEEDBACK: y", "CALL: abc"])).map((e) => e.title);
    expect(titles).toEqual(["Asked for an onboarding call", "Onboarding call booked", "Meeting script ready", "Notes from the onboarding call", "A call came in"]);
  });

  it("a booking puts the requested call on the calendar instead of adding a second one", () => {
    const calls = callsOf(shop(["RESEARCH: x", "CALL REQUESTED: Tuesday afternoon", "CALL BOOKED: 2026-11-10 14:00 PT evt_123 google event"]), REF);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ n: 0, status: "booked", at: "2026-11-10T22:00:00.000Z", onCalendar: true, noteIndex: 2, feedbackIndex: null });
  });

  it("a requested call with no time stays requested, and feedback closes the latest open call", () => {
    expect(callsOf(shop(["CALL REQUESTED: whenever suits"]), REF)[0]).toMatchObject({ status: "requested", at: null, when: "whenever suits" });
    const calls = callsOf(shop(["CALL BOOKED: 2026-11-09 10:00 PT, no calendar", "MEETING FEEDBACK: Hours: x", "CALL BOOKED: 2026-11-16 10:00 PT, no calendar"]), REF);
    expect(calls.map((c) => [c.status, c.onCalendar, c.feedbackIndex])).toEqual([["done", false, 1], ["booked", false, null]]);
  });

  it("finds the newest script note", () => {
    expect(scriptNoteOf(shop(["MEETING SCRIPT: one", "MEETING SCRIPT:\nWHO\n- two"]))).toBe("WHO\n- two");
    expect(scriptNoteOf(shop(["RESEARCH: x"]))).toBeNull();
  });

  it("lists upcoming calls soonest first with untimed ones last, then past calls newest first", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const rows = bookingRows([
      shop(["CALL BOOKED: 2026-11-12 10:00 PT"], { id: "a", name: "Later" }),
      shop(["CALL REQUESTED: some time"], { id: "b", name: "Untimed" }),
      shop(["CALL BOOKED: 2026-11-10 10:00 PT", "MEETING SCRIPT: x"], { id: "c", name: "Sooner" }),
      shop(["CALL BOOKED: 2026-11-02 10:00 PT", "MEETING FEEDBACK: done"], { id: "d", name: "Old done" }),
      shop(["CALL BOOKED: 2026-11-05 10:00 PT"], { id: "e", name: "Missed notes" }),
      shop(["RESEARCH: no call"], { id: "f", name: "None" }),
    ], now);
    expect(rows.map((r) => [r.client.name, r.upcoming])).toEqual([
      ["Sooner", true], ["Later", true], ["Untimed", true], ["Missed notes", false], ["Old done", false],
    ]);
    expect(rows[0]!.scriptReady).toBe(true);
    expect(rows[1]!.scriptReady).toBe(false);
  });
});

describe("the prep script, assembled without a model", () => {
  const research = "RESEARCH: Sector: auto repair. 4.8 stars from 212 Google reviews. Phone (650) 555-0142. 12 Main St, San Mateo, CA 94401. Hours: mon 8:00-17:00; tue 8:00-17:00; wed 8:00-17:00; thu 8:00-17:00; fri 8:00-17:00; sat closed; sun closed. Fits: busy two-bay shop.\nOpener detail: you've been family owned in San Mateo since 1989";
  const input = (over: Partial<ScriptInput> = {}): ScriptInput => ({
    client: shop([
      research,
      "RECEPTIONIST: shop_id pats-garage-sm · demo_url https://x.example/demo/pats-garage-sm · preview",
      "REPLY RECEIVED <abc@mail> Sure, we miss a lot of calls when we're slammed. Tuesday at 2 works.",
      "CALL BOOKED: 2026-11-10 14:00 PT, no calendar",
    ]),
    city: "San Mateo",
    sector: "Auto repair",
    phone: "(650) 555-0142",
    rating: "4.8 from 212 reviews",
    call: { at: "2026-11-10T22:00:00.000Z", when: "2026-11-10 14:00 PT", status: "booked" },
    receptionist: {
      live: false, version: 2, first_message: "Thanks for calling Pat's Garage, this is a preview.",
      hours: { mon: "8:00-17:00", tue: "8:00-17:00", wed: "8:00-17:00", thu: "8:00-17:00", fri: "8:00-17:00", sat: "closed", sun: "closed" },
      services: ["brakes", "oil change"], policies: ["Do not quote prices."],
    },
    demoCalls: 0,
    ...over,
  });

  it("is the same every time for the same facts", () => {
    expect(buildPrepScript(input())).toEqual(buildPrepScript(input()));
  });

  it("covers who, what they said, the shop, the demo, pain points, questions and the close", () => {
    const s = buildPrepScript(input());
    expect(s.map((x) => x.heading)).toEqual(["Who you are meeting", "What they said", "What we know about the shop", "Their receptionist", "Likely pain points", "Questions to ask", "The close"]);
    const text = scriptText(s);
    expect(text).toMatch(/Pat Banks, owner, at Pat's Garage in San Mateo/);
    expect(text).toContain("The call: Tue, Nov 10, 2:00 PM PT, 15 minutes.");
    expect(s[1]!.quotes).toEqual(["Sure, we miss a lot of calls when we're slammed. Tuesday at 2 works."]);
    expect(text).toMatch(/Something to mention: you've been family owned in San Mateo since 1989/);
    expect(text).toMatch(/preview receptionist is built for them \(version 2\)/);
    expect(text).toMatch(/Nobody has called it yet/);
    expect(text).toMatch(/Hours it knows: Mon–Fri 8–5, Sat–Sun closed/);
    expect(text).toMatch(/They mentioned missed calls themselves/);
    expect(text).toMatch(/closed on weekends/);
    expect(text).toMatch(/We have Mon–Fri 8–5, Sat–Sun closed: is that right\?/);
    for (const q of ["services", "greeting", "Booking rules", "urgent hand-offs", "How do you book today"]) expect(text).toContain(q);
    expect(text).toMatch(/free for 7 days, then \$49\.99 a month/);
    expect(text).toMatch(/Stripe checkout link/);
    // No machine ids or message ids reach the page.
    expect(text).not.toMatch(/cli_|abc@mail|shop_id|pats-garage-sm/);
  });

  it("adds the inbox's replies without repeating one already filed as a note", () => {
    const s = buildPrepScript(input({ inboxReplies: ["Sure, we miss a lot of calls when we're slammed. Tuesday at 2 works.\n\nOn Mon, Nov 2 Aarav wrote:\n> hi", "Also we close at 5."] }));
    expect(s[1]!.quotes).toEqual(["Sure, we miss a lot of calls when we're slammed. Tuesday at 2 works.", "Also we close at 5."]);
  });

  it("says plainly what is missing", () => {
    const bare = buildPrepScript({
      client: shop([], { contact: { name: "", email: "", role: "" } }), city: null, sector: "Towing", phone: null, rating: null,
      call: { at: null, when: "Tuesday afternoon", status: "requested" }, receptionist: null,
    });
    const text = scriptText(bare);
    expect(text).toMatch(/We do not have the owner's name yet/);
    expect(text).toMatch(/asked for a call \(Tuesday afternoon\); it is not on the calendar yet/);
    expect(text).toMatch(/Nothing they wrote is on file/);
    expect(text).toMatch(/Research has not filed anything/);
    expect(text).toMatch(/No receptionist has been built for them yet/);
    expect(text).toMatch(/Missed dispatch calls/);
  });
});

describe("a MEETING SCRIPT note, formatted", () => {
  it("turns headings and bullets into sections", () => {
    const s = formatScriptNote("WHO\n- Pat Banks, owner\n\n## What they said\n* \"we miss calls\"\nQuestions to ask:\n1. Hours?\n2. **Greeting**?\nClose: free week, then $49.99/mo");
    expect(s).toEqual([
      { heading: "Who", items: ["Pat Banks, owner"] },
      { heading: "What they said", items: ["\"we miss calls\""] },
      { heading: "Questions to ask", items: ["Hours?", "Greeting?", "Close: free week, then $49.99/mo"] },
    ]);
  });

  it("keeps a note with no structure as one block, without ids", () => {
    expect(formatScriptNote("Talk to Pat about cli_abc123 hours.")).toEqual([{ heading: "", items: ["Talk to Pat about hours."] }]);
  });
});

describe("the feedback form's fields", () => {
  it("keeps only the fields that say something, capped", () => {
    expect(cleanFeedback({ hours: "  ", greeting: " Pat's Garage, how can I help? ", extra: "x", notes: "a".repeat(3000) })).toEqual({
      greeting: "Pat's Garage, how can I help?", notes: "a".repeat(2000),
    });
    expect(cleanFeedback({ hours: "" })).toBeNull();
    expect(cleanFeedback("nope")).toBeNull();
  });

  it("writes readable lines in the form's order", () => {
    expect(feedbackLines({ notes: "nice guy", hours: "Sat 9-1\nSun closed", handoff: "Text Pat 650 555 0100" })).toEqual([
      "Hours: Sat 9-1 / Sun closed",
      "Urgent hand-off: Text Pat 650 555 0100",
      "Anything else: nice guy",
    ]);
  });
});
