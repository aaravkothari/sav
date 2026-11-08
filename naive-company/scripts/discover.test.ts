import { describe, expect, it } from "vitest";
import { filingForDiscovered, mergeDiscovered } from "./crm-import.ts";
import {
  Budget, buildLead, collectKnown, contactUrls, dedupeListings, DEFAULT_CITIES, extractEmails, hunterCandidates, type Job, listingCity, type Listing, type Monid, parseArgs,
  parseListings, parseRun, personalizedDetail, pickContact, priorityFor, researchNote, type RunResult, runJobs, scoreEmail, scrapeSite, streetName,
} from "./discover.ts";

type Row = Listing & { sector: string; searchCity: string };
const listing = (over: Partial<Row> = {}): Row => ({
  name: "Conti Car Care", address: "2100 S El Camino Real, San Mateo, CA 94403", phone: "+16505550100", website: "http://www.conticarcare.com/", domain: "conticarcare.com",
  rating: 4.7, reviewCount: 143, category: "Auto repair shop", categories: ["Auto repair shop", "Brake shop"], emails: [], sector: "auto", searchCity: "San Mateo, CA", ...over,
});
const shop = { name: "Conti Car Care", domain: "conticarcare.com" };
const noKnown = () => ({ domains: new Set<string>(), phones: new Set<string>() });

describe("parseArgs", () => {
  it("repeats sectors and cities and defaults to a Bay Area list", () => {
    const o = parseArgs(["--sector", "auto", "--sector=salon", "--per-query", "5", "--budget-usd", "2.5"]);
    expect(o).toMatchObject({ execute: false, sectors: ["auto", "salon"], perQuery: 5, budgetUsd: 2.5 });
    expect(o.cities).toEqual(DEFAULT_CITIES);
    expect(parseArgs(["--sector", "auto", "--city", "Oakland, CA", "--execute"])).toMatchObject({ execute: true, cities: ["Oakland, CA"] });
  });
  it("refuses bad input", () => {
    expect(() => parseArgs([])).toThrow(/sector/);
    expect(() => parseArgs(["--sector", "auto", "--per-query", "50"])).toThrow(/1 to 20/);
    expect(() => parseArgs(["--sector", "auto", "--budget-usd", "0"])).toThrow(/positive/);
    expect(() => parseArgs(["--sector", "auto", "--nope"])).toThrow(/unknown/);
  });
});

describe("parseListings", () => {
  it("reads the maps.contacts envelope and ignores anything else", () => {
    const rows = parseListings({ data: { items: [{ name: "Four Car Garage", website: "http://www.fourcargarage.com/", rating: 4.9, reviewCount: 280, emails: ["a@fourcargarage.com"], categories: ["Auto repair shop"] }, { rating: 3 }] } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: "fourcargarage.com", reviewCount: 280, emails: ["a@fourcargarage.com"], address: null });
    expect(parseListings(null)).toEqual([]);
  });
});

describe("dedupeListings", () => {
  it("drops repeats by domain then phone, keeping the first", () => {
    const { kept, dropped } = dedupeListings([
      listing(),
      listing({ searchCity: "Redwood City, CA" }),
      listing({ name: "Other", domain: "other.com", website: "https://other.com" }),
      listing({ name: "New", domain: "new.com", website: "https://new.com", phone: "+16505550999" }),
    ], noKnown());
    expect(kept.map((l) => l.name)).toEqual(["Conti Car Care", "New"]);
    expect(dropped.duplicate).toBe(2);
  });
  it("treats a domain shared by different phones as a chain, and drops known directories and known shops", () => {
    const known = noKnown();
    known.domains.add("seen.com");
    known.phones.add("6505550444");
    const { kept, dropped } = dedupeListings([
      listing({ domain: "chain.com", phone: "+16505550001" }),
      listing({ domain: "chain.com", phone: "+16505550002" }),
      listing({ domain: "stressfree.com", phone: "+16505550003" }),
      listing({ domain: "seen.com", phone: "+16505550004" }),
      listing({ domain: "fine.com", phone: "+16505550444" }),
      listing({ domain: null, phone: "+16505550005" }),
    ], known);
    expect(kept).toEqual([]);
    expect(dropped).toEqual({ no_domain: 1, directory_or_chain: 3, known: 2, duplicate: 0 });
  });
});

describe("collectKnown", () => {
  it("reads domains and phones from both lead shapes", () => {
    const known = noKnown();
    collectKnown([{ domain: "www.a.com", shop_input: { website: "https://b.com/x", phone: "(650) 555-0111" } }, { phone: "+14155550123" }, { domain: null }], known);
    expect([...known.domains].sort()).toEqual(["a.com", "b.com"]);
    expect([...known.phones].sort()).toEqual(["4155550123", "6505550111"]);
  });
});

describe("extractEmails", () => {
  it("finds plain, mailto, spelled-out and escaped addresses", () => {
    const html = `<a href="mailto:Info@Shop.com?subject=x">x</a> frank [at] shop [dot] com  sue(at)shop(dot)com  bob&#64;shop.com  amy%40shop.com end.`;
    expect(extractEmails(html).sort()).toEqual(["amy@shop.com", "bob@shop.com", "frank@shop.com", "info@shop.com", "sue@shop.com"]);
  });
  it("strips a trailing dot", () => {
    expect(extractEmails("write to hello@shop.com.")).toEqual(["hello@shop.com"]);
  });
});

describe("scoreEmail", () => {
  it("takes the shop's own domain, preferring owners, then role inboxes, then other people", () => {
    const score = (email: string, extra = {}) => scoreEmail({ email, source: "site", ...extra }, shop);
    const ranked = [
      score("frank@conticarcare.com", { position: "Owner", first_name: "Frank" }),
      score("info@conticarcare.com"),
      score("sue@conticarcare.com", { first_name: "Sue" }),
      score("diane@conticarcare.com"),
    ];
    expect(ranked).toEqual([...ranked].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(new Set(ranked).size).toBe(4);
  });
  it("accepts free mail only when the local part names the shop", () => {
    expect(scoreEmail({ email: "conticarcare@sbcglobal.net", source: "listing" }, shop)).not.toBeNull();
    expect(scoreEmail({ email: "bob1962@gmail.com", source: "listing" }, shop)).toBeNull();
    expect(scoreEmail({ email: "carcare@gmail.com", source: "listing" }, shop)).toBeNull();
  });
  it("drops other companies, junk and image names", () => {
    for (const email of ["contact@sansoxygen.com", "a@drivenbrands.com", "user@example.com", "x@mysite.com", "hi@email.com", "logo@2x.png", "abc123@sentry.io", "763-5004lauren@conticarcare.com", "noreply@conticarcare.com", "careers@conticarcare.com", "not-an-email"]) {
      expect(scoreEmail({ email, source: "site" }, shop)).toBeNull();
    }
  });
});

describe("pickContact", () => {
  it("picks the best and carries the name and role", () => {
    expect(pickContact([
      { email: "info@conticarcare.com", source: "site" },
      { email: "frank@conticarcare.com", source: "hunter", first_name: "Frank", position: "Owner" },
    ], shop)).toEqual({ contact_email: "frank@conticarcare.com", contact_first_name: "Frank", contact_role: "Owner", source: "hunter" });
  });
  it("cleans an escaped listing address", () => {
    expect(pickContact([{ email: "%20conticarcare@gmail.com", source: "listing" }], shop)?.contact_email).toBe("conticarcare@gmail.com");
    expect(pickContact([{ email: "http://conticarcare@gmail.com", source: "listing" }], shop)?.contact_email).toBe("conticarcare@gmail.com");
  });
  it("is null with nothing usable", () => {
    expect(pickContact([{ email: "user@example.com", source: "site" }], shop)).toBeNull();
    expect(pickContact([], shop)).toBeNull();
  });
});

describe("hunterCandidates", () => {
  it("keeps verified or web-sourced rows and leaves inferred patterns out", () => {
    const rows = hunterCandidates({ data: { emails: [
      { value: "a@x.com", first_name: "A", position: "Owner", confidence: 95, sources: [], verification: { status: "valid" } },
      { value: "b@x.com", confidence: 80, sources: [{ uri: "https://x.com" }], verification: { status: null } },
      { value: "c@x.com", confidence: 90, sources: [], verification: { status: null } },
      { value: "d@x.com", confidence: 99, sources: [{ uri: "u" }], verification: { status: "invalid" } },
    ] } });
    expect(rows.map((r) => r.email)).toEqual(["a@x.com", "b@x.com"]);
    expect(hunterCandidates(null)).toEqual([]);
  });
});

describe("personalizedDetail", () => {
  it("names a specialty when the shop's name states one", () => {
    expect(personalizedDetail(listing({ name: "Ma's European Auto Service" }), "San Mateo")).toBe("you specialize in European cars");
    expect(personalizedDetail(listing({ name: "EV Auto Service" }), "San Mateo")).toBe("you work on EVs");
  });
  it("uses the rating when it is good and backed by reviews", () => {
    expect(personalizedDetail(listing({ rating: 4.9, reviewCount: 370 }), "San Mateo")).toBe("you've kept a 4.9 rating across 370 Google reviews");
    expect(personalizedDetail(listing({ rating: 5, reviewCount: 24 }), "San Mateo")).toBe("you have a perfect 5-star rating from 24 Google reviews");
  });
  it("falls back to the street rather than praising a thin or weak rating", () => {
    expect(personalizedDetail(listing({ rating: 4.2, reviewCount: 300 }), "San Mateo")).toBe("you're on El Camino Real in San Mateo");
    expect(personalizedDetail(listing({ rating: 5, reviewCount: 3 }), "San Mateo")).toBe("you're on El Camino Real in San Mateo");
    expect(personalizedDetail(listing({ rating: null, reviewCount: null, address: null }), "Oakland")).toBe("you're based in Oakland");
  });
});

describe("address helpers", () => {
  it("reads the street and the city", () => {
    expect(streetName("1700 El Camino Real, San Carlos, CA 94070")).toBe("El Camino Real");
    expect(streetName("2107 Palm Ave # C, San Mateo, CA 94403")).toBe("Palm Ave");
    expect(streetName("5150 Saratoga Ave F, San Jose, CA 95129")).toBe("Saratoga Ave");
    expect(streetName("PO Box, Town, CA")).toBeNull();
    expect(listingCity("2107 Palm Ave # C, San Mateo, CA 94403")).toBe("San Mateo");
    expect(listingCity("nowhere")).toBeNull();
  });
});

describe("researchNote and buildLead", () => {
  it("writes the RESEARCH format and ends on the Detail clause", () => {
    const note = researchNote(listing(), "auto", "you've kept a 4.7 rating across 143 Google reviews");
    expect(note).toBe("RESEARCH: Auto repair shop rated 4.7 on 143 Google reviews. Phone (650) 555-0100, 2100 S El Camino Real, San Mateo, CA 94403. Fit: independent shop with 143 reviews, busy enough that calls likely go unanswered while techs are in the bays. Detail: you've kept a 4.7 rating across 143 Google reviews.");
  });
  it("builds a repair lead for auto and a service lead with a sector otherwise", () => {
    const contact = { contact_email: "info@conticarcare.com", contact_first_name: null, contact_role: null, source: "site" as const };
    const auto = buildLead(listing(), contact);
    expect(auto).toMatchObject({ kind: "repair", sector: "auto", city: "San Mateo", priority: "A", domain: "conticarcare.com", contact_first_name: null });
    expect(auto.shop_input).toMatchObject({ name: "Conti Car Care", kind: "repair", demo: true, policies: ["Do not quote prices."], services: ["auto repair shop", "brake shop"] });
    expect(auto.shop_input.sector).toBeUndefined();
    const salon = buildLead(listing({ sector: "salon", category: "Hair salon" }), contact);
    expect(salon.shop_input).toMatchObject({ kind: "service", sector: "salon" });
    expect(salon.note).toContain("stylists are with clients");
  });
  it("sets priority from review volume", () => {
    expect([priorityFor({ rating: 4.8, reviewCount: 200 }), priorityFor({ rating: 4, reviewCount: 200 }), priorityFor({ rating: 5, reviewCount: 4 })]).toEqual(["A", "B", "C"]);
  });
});

describe("Budget", () => {
  it("reserves against the cap and settles to the real cost", () => {
    const b = new Budget(0.05);
    expect(b.reserve(0.03)).toBe(true);
    expect(b.reserve(0.03)).toBe(false);
    b.settle(0.03, 0.01);
    expect(b.spent).toBe(0.01);
    expect(b.reserve(0.03)).toBe(true);
  });
});

describe("runJobs", () => {
  const job = (key: string): Job => ({ key, provider: "p", endpoint: "/e", body: { key }, estimate: 0.01 });
  const done = (output: unknown, cost = 0.01): RunResult => ({ status: "COMPLETED", output, cost, httpStatus: 200 });
  const fake = (results: (id: string, polls: number) => RunResult) => {
    const polls = new Map<string, number>();
    const monid: Monid & { started: string[] } = {
      started: [],
      start: async (_p, _e, body) => {
        const id = String(body["key"]);
        monid.started.push(id);
        return id;
      },
      get: async (id) => {
        polls.set(id, (polls.get(id) ?? 0) + 1);
        return results(id, polls.get(id) ?? 0);
      },
    };
    return monid;
  };
  const sleep = async () => undefined;

  it("polls every live run until each ends, and adds up the real cost", async () => {
    const monid = fake((id, polls) => (id === "slow" && polls < 3 ? { status: "RUNNING", output: null, cost: 0, httpStatus: null } : done(id, 0.02)));
    const budget = new Budget(1);
    const out = await runJobs([job("fast"), job("slow")], { monid, budget, sleep, pollMs: 0 });
    expect(out.get("slow")).toMatchObject({ output: "slow", status: "completed" });
    expect(budget.spent).toBeCloseTo(0.04);
  });
  it("stops starting runs at the budget", async () => {
    const monid = fake((id) => done(id));
    const budget = new Budget(0.015);
    const out = await runJobs([job("a"), job("b"), job("c")], { monid, budget, sleep, pollMs: 0 });
    expect(monid.started).toHaveLength(1);
    expect([...out.values()].filter((o) => o.status === "over_budget")).toHaveLength(2);
  });
  it("runs what was held back once cheap results free up room", async () => {
    const monid = fake((id) => done(id, 0));
    const budget = new Budget(0.015);
    const out = await runJobs([job("a"), job("b"), job("c")], { monid, budget, sleep, pollMs: 0 });
    expect(monid.started.sort()).toEqual(["a", "b", "c"]);
    expect([...out.values()].every((o) => o.status === "completed")).toBe(true);
  });
  it("uses the cache and pays nothing for it", async () => {
    const monid = fake((id) => done(id));
    const budget = new Budget(1);
    const written: string[] = [];
    const out = await runJobs([job("hit"), job("miss")], {
      monid, budget, sleep, pollMs: 0,
      readCache: async (j) => (j.key === "hit" ? "from cache" : undefined),
      writeCache: async (j) => void written.push(j.key),
    });
    expect(out.get("hit")).toMatchObject({ output: "from cache", status: "cached", cost: 0 });
    expect(monid.started).toEqual(["miss"]);
    expect(written).toEqual(["miss"]);
  });
  it("reports a provider error as failed and does not cache it", async () => {
    const monid = fake(() => ({ status: "COMPLETED", output: { error: "bad" }, cost: 0, httpStatus: 400 }));
    const written: string[] = [];
    const out = await runJobs([job("a")], { monid, budget: new Budget(1), sleep, pollMs: 0, writeCache: async (j) => void written.push(j.key) });
    expect(out.get("a")).toMatchObject({ status: "failed", error: "COMPLETED http 400" });
    expect(written).toEqual([]);
  });
  it("gives up on a run past the timeout", async () => {
    const monid = fake(() => ({ status: "RUNNING", output: null, cost: 0, httpStatus: null }));
    let t = 0;
    const out = await runJobs([job("a")], { monid, budget: new Budget(1), sleep, pollMs: 0, timeoutMs: 10, now: () => (t += 6) });
    expect(out.get("a")?.status).toBe("failed");
  });
});

describe("parseRun", () => {
  it("reads status, output, cost and the provider status", () => {
    expect(parseRun({ status: "COMPLETED", output: { a: 1 }, cost: { value: 0.1 }, providerResponse: { httpStatus: 200 } })).toEqual({ status: "COMPLETED", output: { a: 1 }, cost: 0.1, httpStatus: 200 });
  });
});

describe("site scrape", () => {
  it("covers the listed page and the contact paths, once each", () => {
    expect(contactUrls("https://shop.com/locations/a")).toEqual(["https://shop.com/locations/a", "https://shop.com/", "https://shop.com/contact", "https://shop.com/contact-us", "https://shop.com/about", "https://shop.com/about-us"]);
    expect(contactUrls("shop.com/")).toHaveLength(5);
  });
  it("merges addresses from every page", async () => {
    const pages: Record<string, string> = { "https://shop.com/contact": "info@shop.com", "https://shop.com/about": "info@shop.com owner@shop.com" };
    const found = await scrapeSite("https://shop.com/", (t) => t(), async (u) => pages[u] ?? "");
    expect(found.map((c) => c.email).sort()).toEqual(["info@shop.com", "owner@shop.com"]);
    expect(found[0]?.source).toBe("site");
  });
});

describe("crm-import --from discovered", () => {
  const lead = { name: "Conti Car Care", domain: "ContiCarCare.com", contact_email: "Info@ContiCarCare.com", contact_first_name: null, contact_role: null, phone: "+16505550100", note: "RESEARCH: x. Detail: y." };
  it("files the contact, phone and note", () => {
    expect(filingForDiscovered(lead)).toEqual({ name: "Conti Car Care", domain: "conticarcare.com", contact_email: "info@conticarcare.com", phone: "+16505550100", source: "outreach", note: "RESEARCH: x. Detail: y." });
    expect(filingForDiscovered({ ...lead, contact_first_name: "Frank", contact_role: "Owner" })).toMatchObject({ contact_name: "Frank", contact_role: "Owner" });
  });
  it("leaves out a lead with no email, no domain or no RESEARCH note", () => {
    expect(filingForDiscovered({ ...lead, contact_email: "" })).toBeNull();
    expect(filingForDiscovered({ ...lead, domain: undefined })).toBeNull();
    expect(filingForDiscovered({ ...lead, note: "hello" })).toBeNull();
  });
  it("merges files one per domain", () => {
    const { filings, skipped } = mergeDiscovered([[lead], [lead, { ...lead, contact_email: "" }], "junk"]);
    expect(filings).toHaveLength(1);
    expect(skipped).toBe(1);
  });
});
