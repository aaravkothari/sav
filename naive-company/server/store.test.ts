import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "../seed/clients";
import type { Post } from "../seed/posts";
import { ACTIVE_TEMPLATE } from "../templates/active";
import { MAX_ITEMS, MAX_TEXT, site, withinBounds } from "../site/site.config";
import { emptyState, LEAD_WINDOW_MS, LEADS_PER_WINDOW, openStore, openStoreOver, seedState, type StoreState } from "./store";

/**
 * The rows the store starts with are the *active template's* demo seed, so this suite names them
 * by what they are — a lead, an active client, a pending post — and never by an id. An id here
 * would make switching template a code change in the blueprint's own tests, which is exactly what
 * a template being data is supposed to prevent.
 */
const seedClients = ACTIVE_TEMPLATE.seed.clients as Client[];
const seedPosts = ACTIVE_TEMPLATE.seed.posts as Post[];
const clientAt = (stage: Client["stage"]): string => seedClients.find((c) => c.stage === stage)!.id;
const postAt = (status: Post["status"]): string => seedPosts.find((p) => p.status === status)!.id;

const dirs: string[] = [];
const storeFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "sga-store-"));
  dirs.push(dir);
  return join(dir, "store.json");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the two starting documents", () => {
  it("gives a deployment nothing and the local file store the demo agency", () => {
    // A deployed dashboard showing the blueprint's sample rows would be presenting fiction as the
    // operator's CRM; an empty board is the truth about an agency that has not started yet.
    expect(emptyState()).toEqual({ clients: [], posts: [], site_profile: site });
    expect(seedState().clients.length).toBeGreaterThan(0);
    // The site is the same generic page on both: it claims nothing about anyone until the builder
    // rewrites it from the setup answers.
    expect(seedState().site_profile).toEqual(site);
  });
});

describe("the site profile", () => {
  it("reads the seed off a document written before the site was data", () => {
    const state = { clients: [], posts: [] } as StoreState;
    const store = openStoreOver(state, () => {});
    expect(store.site()).toEqual(site);
    expect(state.site_profile).toBeUndefined();
  });

  it("replaces whole sections that keep the seed's shape, and refuses everything else", () => {
    let writes = 0;
    const state = emptyState();
    const store = openStoreOver(state, () => { writes += 1; });
    const hero = { ...site.hero, title: "Paid social for skincare brands" };
    const faq = { title: "Questions", items: [{ question: "How long?", answer: "A quarter." }] };
    expect(store.updateSite({ hero, faq })).toEqual({ ...site, hero, faq });
    expect(state.site_profile?.hero.title).toBe("Paid social for skincare brands");
    expect(writes).toBe(1);

    for (const bad of [
      {}, // nothing to do
      { caseStudies: [] }, // not a section
      { hero: { title: "only a title" } }, // a section missing its keys
      { hero: "a string" },
      { services: { title: "not a list" } },
      { faq: { title: "Questions", items: [{ question: "answerless" }] } }, // an item missing its keys
      { proof: { facts: [42] } }, // an item of the wrong type
    ]) {
      expect([bad, store.updateSite(bad)]).toEqual([bad, null]);
    }
    // A refusal writes nothing and changes nothing.
    expect(writes).toBe(1);
    expect(store.site()).toEqual({ ...site, hero, faq });
  });

  /**
   * `sameShape` judges structure and nothing else, so every patch below is a perfectly shaped
   * section — and one of them is a hero title megabytes long. The site is the live public page and
   * the agent writing it is a language model working from an operator's answers; a bound is what
   * keeps a runaway generation from becoming the page every visitor loads.
   */
  it("refuses a rightly shaped section whose strings or lists are longer than the page can carry", () => {
    let writes = 0;
    const store = openStoreOver(emptyState(), () => { writes += 1; });
    for (const bad of [
      { tagline: "x".repeat(MAX_TEXT + 1) },
      { hero: { ...site.hero, title: "x".repeat(MAX_TEXT + 1) } },
      { faq: { ...site.faq, items: [{ question: "How long?", answer: "x".repeat(MAX_TEXT + 1) }] } },
      { proof: { facts: Array.from({ length: MAX_ITEMS + 1 }, () => "a fact") } },
      { services: Array.from({ length: MAX_ITEMS + 1 }, () => site.services[0]!) },
    ]) {
      expect([Object.keys(bad)[0], store.updateSite(bad)]).toEqual([Object.keys(bad)[0], null]);
    }
    expect(writes).toBe(0);
    expect(store.site()).toEqual(site);
  });

  it("carries a seed that is well inside those bounds", () => {
    expect(withinBounds(site)).toBe(true);
  });
});

/**
 * The public form's rate window. The open-leads cap is a spend bound, not a denial-of-service one:
 * before this, `OPEN_LEADS_CAP` scripted pairs filled the inbox in one burst and every real lead
 * for the next day was answered `429`.
 */
describe("the public form's rate window", () => {
  it("admits a window's worth, refuses the rest, and reopens on the next window", () => {
    const store = openStore(storeFile());
    for (let i = 0; i < LEADS_PER_WINDOW; i += 1) expect(store.admitLead(1_000)).toBe(true);
    expect(store.admitLead(1_000)).toBe(false);
    expect(store.admitLead(1_000 + LEAD_WINDOW_MS - 1)).toBe(false);
    expect(store.admitLead(1_000 + LEAD_WINDOW_MS)).toBe(true);
  });

  it("counts across cold starts, because the count lives in the document", () => {
    const file = storeFile();
    for (let i = 0; i < LEADS_PER_WINDOW; i += 1) expect(openStore(file).admitLead(1_000)).toBe(true);
    expect(openStore(file).admitLead(1_000)).toBe(false);
  });
});

describe("openStore", () => {
  it("seeds clients and posts on first run", () => {
    const store = openStore(storeFile());
    expect(store.read().clients).toHaveLength((ACTIVE_TEMPLATE.seed.clients as unknown[]).length);
    expect(store.read().posts).toHaveLength((ACTIVE_TEMPLATE.seed.posts as unknown[]).length);
  });

  it("creates a lead at the lead stage with a slug derived from the name", () => {
    const store = openStore(storeFile());
    const lead = store.createLead({
      name: "Summit Outdoor Co",
      domain: "summitoutdoor.example",
      contact: { name: "Jordan Lee", email: "jordan@summitoutdoor.example", role: "Site inquiry" },
      services: ["SEO"],
      note: "Inbound from the public site.",
    });
    expect(lead.stage).toBe("lead");
    expect(lead.slug).toBe("summit-outdoor-co");
    expect(store.read().clients.some((c) => c.id === lead.id)).toBe(true);
  });

  it("files the agency's own record once, however many agents file it by name in the same minute", () => {
    // Five intakes each `create_lead` the agency's own record from the project name alone; the
    // first opens it and the rest must land on it, notes included, or day one ends with five twins.
    const store = openStore(storeFile());
    const before = store.read().clients.length;
    const own = { domain: "", contact: { name: "", email: "", role: "" } };
    const first = store.createLead({ name: "Northwind Studio", ...own, note: "Onboarding checklist." });
    const second = store.createLead({ name: "Northwind  Studio", ...own, note: "Gap report." });
    expect(second.id).toBe(first.id);
    expect(store.createLead({ name: "Meridian Search", ...own }).id).toBe(first.id);
    expect(store.read().clients).toHaveLength(before + 1);
    expect(store.read().clients.find((c) => c.id === first.id)?.notes).toEqual(["Onboarding checklist.", "Gap report."]);
    // A prospect that shares the name is a different company: it has a domain, and it is its own row.
    const prospect = store.createLead({
      name: "Northwind Studio", domain: "northwind.example", contact: { name: "Kim", email: "kim@northwind.example", role: "CEO" },
    });
    expect(prospect.id).not.toBe(first.id);
    expect(store.read().clients).toHaveLength(before + 2);
  });

  it("consolidates legacy internal duplicates without losing notes or queued work", () => {
    const state = emptyState();
    state.clients = [
      { id: "cli_one", slug: "agency", name: "agency", domain: "", stage: "lead", services: ["SEO"], contact: { name: "", email: "", role: "" }, notes: ["site"] },
      { id: "cli_two", slug: "meridian", name: "Meridian", domain: "", stage: "lead", services: ["GEO"], contact: { name: "", email: "", role: "" }, notes: ["blog"] },
    ];
    state.posts = [{ id: "post_1", clientId: "cli_two", title: "Draft", summary: "s", kind: "article", channel: "blog", status: "pending", agent: "mcp", scheduledFor: "2026-09-26", hue: 1 }];
    let writes = 0;
    const store = openStoreOver(state, () => { writes += 1; });
    expect(store.read().clients).toHaveLength(1);
    expect(store.read().clients[0]).toMatchObject({ id: "cli_one", notes: ["site", "blog"], services: ["SEO", "GEO"] });
    expect(store.read().posts[0]?.clientId).toBe("cli_one");
    expect(writes).toBe(1);
  });

  it("never files the agency's notes on a prospect that happened to share the name", () => {
    // The prospect is on the pipeline first, with a domain and a contact; the agency's own record
    // is then filed from the name alone. A same-slug row that was filed with more is not it.
    const store = openStore(storeFile());
    const before = store.read().clients.length;
    const prospect = store.createLead({
      name: "Northwind Studio", domain: "northwind.example", contact: { name: "Kim", email: "kim@northwind.example", role: "CEO" },
    });
    const own = store.createLead({ name: "Northwind Studio", domain: "", contact: { name: "", email: "", role: "" }, note: "Gap report." });
    expect(own.id).not.toBe(prospect.id);
    expect(store.read().clients).toHaveLength(before + 2);
    expect(store.read().clients.find((c) => c.id === prospect.id)?.notes).toEqual([]);
  });

  it("dedupes a name-only record whose name slugs to nothing on the slug it is actually stored under", () => {
    // Every character of "東京スタジオ" is dropped by the slug; the row is stored as `client`, and
    // the second filing must look for `client`, not for an empty string.
    const store = openStore(storeFile());
    const before = store.read().clients.length;
    const own = { domain: "", contact: { name: "", email: "", role: "" } };
    const first = store.createLead({ name: "東京スタジオ", ...own });
    expect(first.slug).toBe("client");
    expect(store.createLead({ name: "東京スタジオ", ...own }).id).toBe(first.id);
    expect(store.read().clients).toHaveLength(before + 1);
  });

  it("files a note on a client, restating what it waits on only when told to", () => {
    const file = storeFile();
    const store = openStore(file);
    const id = clientAt("lead");
    const before = store.read().clients.find((c) => c.id === id)!;
    const notes = before.notes.length;
    const nextAction = before.nextAction;
    const noted = store.addClientNote(id, "Follow-up drafted: checking in on the proposal.");
    expect(noted?.notes.at(-1)).toBe("Follow-up drafted: checking in on the proposal.");
    expect(noted?.nextAction).toBe(nextAction);
    expect(store.addClientNote(id, "Replied Tuesday.", "Waiting on their signature")?.nextAction).toBe(
      "Waiting on their signature",
    );
    expect(store.addClientNote("nope", "x")).toBeNull();
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { clients: { id: string; notes: string[] }[] };
    expect(onDisk.clients.find((c) => c.id === id)?.notes).toHaveLength(notes + 2);
  });

  it("advances a client along the pipeline and persists it", () => {
    const file = storeFile();
    const store = openStore(file);
    const id = clientAt("lead");
    expect(store.advanceClient(id)?.stage).toBe("proposal");
    expect(store.advanceClient(id)?.stage).toBe("active");
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { clients: { id: string; stage: string }[] };
    expect(onDisk.clients.find((c) => c.id === id)?.stage).toBe("active");
    // Reaching active by the pipeline starts the client's clock as onboarding does (the referral rule reads it).
    expect(store.read().clients.find((c) => c.id === id)?.onboardedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("never advances into churned, and answers null for unknown ids", () => {
    const store = openStore(storeFile());
    expect(store.advanceClient(clientAt("active"))?.stage).toBe("active");
    expect(store.advanceClient("cli_missing")).toBeNull();
  });

  it("updates a post's status with the posted/rejected side effects", () => {
    const store = openStore(storeFile());
    const posted = store.updatePost(postAt("approved"), { status: "posted" });
    expect(posted?.postedAt).toBe("just now");
    expect(posted?.clicks).toBe(0);
    const rejected = store.updatePost(postAt("pending"), { status: "rejected" });
    expect(rejected?.rejectedReason).toBe("Rejected by you");
    expect(store.updatePost("post_missing", { status: "ready" })).toBeNull();
  });

  it("reschedules a post without touching its status", () => {
    const store = openStore(storeFile());
    const moved = store.updatePost(postAt("pending"), { scheduledFor: "2025-03-20" });
    expect(moved?.scheduledFor).toBe("2025-03-20");
    expect(moved?.status).toBe("pending");
  });

  it("onboards a client: active, stamped once, churned left alone", () => {
    const store = openStore(storeFile());
    const id = clientAt("lead");
    const onboarded = store.onboardClient(id);
    expect(onboarded?.stage).toBe("active");
    const stamp = onboarded?.onboardedAt;
    expect(stamp).toBeTruthy();
    expect(store.onboardClient(id)?.onboardedAt).toBe(stamp);
    expect(store.onboardClient(clientAt("churned"))?.stage).toBe("churned");
    expect(store.onboardClient("cli_missing")).toBeNull();
  });

  it("reopens from disk rather than reseeding", () => {
    const file = storeFile();
    const id = postAt("pending");
    openStore(file).updatePost(id, { status: "approved" });
    expect(openStore(file).read().posts.find((p) => p.id === id)?.status).toBe("approved");
  });
});
