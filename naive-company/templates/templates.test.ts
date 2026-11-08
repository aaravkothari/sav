/**
 * The two templates of the `agency` blueprint, held to what a template is.
 *
 * A template is DATA — agents and prompts, tool allow-lists, deliverable kinds, schedules, the
 * demo seed, the screen vocabulary. The blueprint around it is shared, so the tests below are
 * about the *difference* between the two: `blank` must carry no specialism at all, `seo-geo` must
 * be a delta on it and not a fork of it, and neither may declare a row or a kind the other's
 * screens could not render.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Client } from "../seed/clients.ts";
import type { Post } from "../seed/posts.ts";
import { TEMPLATES } from "./active.ts";
import { AGENCY_IDENTITY, AGENCY_TIMEZONE, OPENER, PREAMBLE, REFERRAL_ASK, roster } from "./agents.ts";
import { blank } from "./blank.ts";
import { TEMPLATE, VOCABULARY, kindLabel } from "./index.ts";
import { BOARD, BOOKING_URL, DEMO_LINE, GOOGLE_CALENDAR, MODELS, PIPELINE, placeholderBudget, placeholderModel, RESEARCH_CITIES, SECTORS } from "./receptionist.ts";
import { productDesign, STUDIO_NOTE } from "./product-design.ts";
import { seoGeo } from "./seo-geo.ts";

/** Plan §2.1's roster, name and role, in the order the studio lists them. */
const ROSTER = [
  ["site-builder", "Public site"],
  ["sales", "Pipeline"],
  ["client-manager", "Delivery"],
  ["content-writer", "Content"],
  ["content-reviser", "Revisions"],
  ["gap-researcher", "Research"],
  ["proposal-writer", "Proposals"],
];
const SEO_ROSTER = [...ROSTER, ["paid-media-planner", "Paid media planning"]];

const all = Object.values(TEMPLATES);
/**
 * The template that runs the agency's seven. `blank` now runs this company's receptionist crew
 * (its own `describe` below) and `product-design` is a studio of four; every rule about the
 * machine — the gate, deny-by-default, the persona, outward tools at `ask`, the demo seed — is
 * still held over `all`.
 */
const agencies = all.filter((t) => t.name === "seo-geo");
const clientsOf = (t: (typeof all)[number]) => t.seed.clients as Client[];
const postsOf = (t: (typeof all)[number]) => t.seed.posts as Post[];
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Every string a template puts in front of a person or a model. Skill refs are catalogue slugs, not prose. */
const prose = (t: (typeof all)[number]): string =>
  JSON.stringify([
    t.description,
    t.words,
    t.kinds,
    t.agents.map(({ skills: _, ...agent }) => agent),
    t.crew,
    t.seed,
    t.questions,
    VOCABULARY[t.name as keyof typeof VOCABULARY].site,
  ]);

describe("every template of this blueprint", () => {
  it("carries all three, so a switch is an edit and never a re-clone", () => {
    expect(all.map((t) => t.name).sort()).toEqual(["blank", "product-design", "seo-geo"]);
    expect(TEMPLATES[TEMPLATE].name).toBe(TEMPLATE);
  });

  it.each(agencies)("$name declares the seven that run an agency, with the gate in every prompt", (template) => {
    expect(template.agents.map((a) => [a.name, a.role])).toEqual(template.name === "seo-geo" ? SEO_ROSTER : ROSTER);
    for (const agent of [...template.agents, ...template.crew]) {
      expect(agent.system).toMatch(/never send or publish anything yourself/);
      expect(agent.model).toBeTruthy();
      expect(agent.tools?.default_config.permission).toBe("deny");
    }
  });

  /**
   * Plan §2.1, held per agent: the shared paragraph first (read `project_context` before anything;
   * the answers are the client's), a two-sentence public description, a private prompt of 150–400
   * words, skills from the platform catalogue only, and a day-one intake capped at $2.
   */
  it.each(agencies)("$name writes each of the seven to the plan's shape", (template) => {
    for (const agent of template.agents) {
      const at = agent.name;
      expect([at, agent.system?.startsWith(PREAMBLE)]).toEqual([at, true]);
      expect([at, agent.description?.match(/[.!?](\s|$)/g)?.length]).toEqual([at, 2]);
      const n = words(agent.system ?? "");
      expect([at, n >= 150 && n <= 400]).toEqual([at, true]);
      expect([at, (agent.skills ?? []).length > 0]).toEqual([at, true]);
      for (const ref of agent.skills ?? []) expect([at, ref]).toEqual([at, expect.stringMatching(/^naive\/[a-z0-9-]+(@\d+)?$/)]);
      expect([at, agent.intake?.budget_micro_usd]).toEqual([at, 20_000_000]);
      for (const schedule of agent.schedules ?? []) expect([at, Number.isInteger(schedule.budget_micro_usd)]).toEqual([at, true]);
    }
  });

  it.each(agencies)("$name asks the setup questions its deliverables require", (template) => {
    if (template.name === "blank") {
      expect(template.questions.map((q) => q.type)).toEqual(["text", "text", "text", "text"]);
      expect(template.questions.map((q) => q.key)).toEqual(["offer", "ideal_client", "pricing", "network"]);
    } else {
      // Four is the engine's limit and seo-geo's four are spent, so its network is asked in session.
      expect(template.questions.map((q) => q.key)).toEqual([
        "public_identity", "offer", "ideal_client", "competitors",
      ]);
    }
    // Only the network question may be skipped: an agency with no contacts to list still installs.
    expect(template.questions.filter((q) => q.optional).map((q) => q.key)).toEqual(template.name === "blank" ? ["network"] : []);
  });

  it.each(agencies)("$name drafts a personal note to each person the operator knows, and invents none", (template) => {
    const sales = template.agents.find((a) => a.name === "sales")!;
    const intake = sales.intake?.message ?? "";
    // On blank the question is optional: a missing answer is a skip, never a second ask.
    expect(intake).toMatch(/network answer, use it; if it has none and the context's template is blank, the operator skipped that optional setup question: do not ask again, stop there/);
    expect(intake).toMatch(/on any other template, which asks no network question at setup, ask the operator once with ask_operator/);
    expect(intake).toMatch(/create_lead \(source network.*add_client_note — do not send/);
    expect(intake).toMatch(/never invent a contact/);
    // Prospects first, network last: asking parks the session, and the list should not wait on it.
    expect(intake.indexOf("fifteen prospects")).toBeLessThan(intake.indexOf("ask_operator"));
    expect(intake).toMatch(/create_lead \(source outreach\)/);
    expect(intake).toMatch(/ask for advice or an introduction rather than pitching; never claim a result/);
    // The daily inbox pass files each new reply with where it came from.
    const inbox = sales.schedules?.[0]?.input ?? "";
    expect(inbox).toMatch(/referred_by and the client's cli_ id.*source network.*otherwise outreach/);
  });

  it.each(agencies)("$name never sends an agent to a setup answer the template did not ask for", (template) => {
    // `seo-geo` spends its third question on competitors, so its context holds no pricing answer;
    // the site-builder and the proposal-writer, who both write from one, are told to ask the operator
    // instead — never to read the absence as "free" or to invent a tier.
    const asked = new Set(template.questions.map((q) => q.key));
    for (const name of ["site-builder", "proposal-writer"]) {
      const agent = template.agents.find((a) => a.name === name)!;
      expect(agent.system, name).toMatch(/pricing answer when the context holds one.*when it does not.*ask_operator/);
    }
    const gap = template.agents.find((a) => a.name === "gap-researcher")!;
    expect((gap.system ?? "").includes("third setup answer")).toBe(asked.has("competitors"));
  });

  it.each(all)("$name seeds a demo that says it is one, and files only kinds it declares", (template) => {
    const kinds = new Set(template.kinds.map((k) => k.id));
    expect(kinds.size).toBeGreaterThan(0);
    expect(clientsOf(template).length).toBeGreaterThan(0);
    for (const post of postsOf(template)) expect(kinds).toContain(post.kind);
    // A seed row is the template's sample, never a claim about a real company: every demo client
    // is on a reserved `.example` domain and says so in its notes.
    for (const client of clientsOf(template)) {
      expect(client.domain).toMatch(/\.example$/);
      expect(client.contact.email).toMatch(/\.example$/);
      expect(client.notes.join(" ")).toMatch(/[Dd]emo row/);
    }
  });

  it.each(all)("$name only files work for a client it seeded", (template) => {
    const ids = new Set(clientsOf(template).map((c) => c.id));
    for (const post of postsOf(template)) expect(ids).toContain(post.clientId);
  });
});

describe("connected accounts", () => {
  /**
   * Every active connection an agent's identity holds contributes its catalogue to the turn as
   * `<connector>.<tool>`, through the same allow/ask/deny filter as `bash`
   * (`apps/runtime-do/src/connection-tools.ts`). Deny-by-default therefore means a template that
   * names none grants none — which is how a crew sold on reaching a client's connected accounts
   * ended up able to call `web_search` and `web_fetch` and nothing else.
   */
  const connectionTools = (agent: { tools?: { configs: Record<string, { permission: string }> } }) =>
    Object.entries(agent.tools?.configs ?? {}).filter(([name]) => name.includes(".") && !name.startsWith("dashboard."));

  it.each(all)("$name grants connected accounts only to agents that consume them", (template) => {
    // Blank needs only the mailbox-facing seats. SEO/GEO additionally grants read-only measurement
    // to its own writer, reviser and gap researcher, plus read-only ad evidence to its planner.
    for (const agent of template.agents) {
      const outward = agent.name === "sales" || agent.name === "client-manager" || agent.name === "account-manager" ||
        (template.name === "seo-geo" && ["content-writer", "content-reviser", "gap-researcher", "paid-media-planner"].includes(agent.name)) ||
        // Every receptionist seat reaches a third-party MCP server: Monid, AgentMail or autoops-voice.
        // Except SAV's own SEO, promotion and coding-liaison seats, which work only on the dashboard.
        (template.name === "blank" && !["seo", "promotion", "coding-liaison"].includes(agent.name));
      expect([agent.name, connectionTools(agent).length > 0]).toEqual([agent.name, outward]);
    }
    // The search crew reads each client's own accounts; the receptionist crew runs its shop's autoops-voice receptionist.
    for (const agent of template.crew) expect([agent.name, connectionTools(agent).length > 0]).toEqual([agent.name, true]);
  });

  it("lets the SEO/GEO agency's own scheduled work read its Search Console and Analytics evidence", () => {
    const names = (agent: string) => connectionTools(seoGeo.agents.find((row) => row.name === agent)!).map(([name]) => name);
    expect(names("content-writer")).toContain("google_search_console.search_analytics_query");
    expect(names("content-reviser")).toEqual(expect.arrayContaining(["google_search_console.search_analytics_query", "google_analytics.run_report"]));
    expect(names("gap-researcher")).toEqual(expect.arrayContaining([
      "google_search_console.search_analytics_query", "google_search_console.list_sites",
      "google_search_console.inspect_url", "google_analytics.run_report",
    ]));
  });

  /**
   * The grant itself. A connection reaches a turn along `session → agent → agent_identity →
   * identity → connected accounts`, so an agent that holds no persona is offered NOTHING from a
   * connected account — the resolver answers an empty list and no screen, log or apply says a word.
   * Every name asserted above was in exactly that state: written, allow-listed, unreachable.
   *
   * The per-client crew is included because it is where the search and analytics names live, and
   * because `POST /v1/agents` has no identity field: `server/proxy.ts` reads this and grants it.
   */
  it.each(all)("$name names the persona on every agent that has one of them", (template) => {
    for (const agent of [...template.agents, ...template.crew]) {
      expect([agent.name, agent.identity]).toEqual([agent.name, AGENCY_IDENTITY]);
    }
  });

  it.each(all)("$name holds its connection tools at the permission its crew chose (blank: all `allow`)", (template) => {
    for (const agent of [...template.agents, ...template.crew]) {
      for (const [name, config] of connectionTools(agent)) {
        // SAV's crew (blank): email sends, drafts, the company inbox, paid Monid runs and receptionist
        // changes all run on their own, within the seat budget. Naïve's own people's-data hold (§64)
        // still applies. The blueprint's other templates keep its rule: anything outward is `ask`.
        if (template.name === "blank") {
          expect([name, config.permission]).toEqual([name, "allow"]);
          continue;
        }
        const draft = /^agentmail\.(create|update)_draft$/.test(name);
        const outward = !draft && /\.(send|post|publish|create|update|delete|write|reply|forward)|\.monid_run$/.test(name);
        expect([name, config.permission]).toEqual([name, outward ? "ask" : "allow"]);
      }
    }
  });
});

describe("handoffs", () => {
  /**
   * Day one is ordered by handoffs (canonical-spec §28.12), not by seven intakes racing for one
   * empty record: the researcher files its report and hands it to the writer, sales hands a lead it
   * advanced to the proposal writer, and in the search crew the audit runner hands the audit's id
   * to the SEO writer, who hands the pages it wrote to the GEO optimizer. Every other seat holds
   * `handoffs: false`, so the tools are offered to exactly the seats that pass work on.
   */
  const CHAIN: Record<string, string[]> = {
    sales: ["proposal-writer"],
    "gap-researcher": ["content-writer"],
    "audit-runner": ["seo-writer"],
    "seo-writer": ["geo-optimizer"],
    // product-design: the studio lead routes each brief; the two makers hand their file to the visualizer.
    "account-manager": ["designer", "engineer", "visualizer"],
    designer: ["visualizer"],
    engineer: ["visualizer"],
  };
  /** The receptionist crew hands two things on itself: a call to book (sales), a yes to charge (onboarding). */
  const BLANK_CHAIN: Record<string, string[]> = { sales: ["client-manager"], "client-manager": ["payments"] };
  const chainOf = (template: (typeof all)[number]): Record<string, string[]> => (template.name === "blank" ? BLANK_CHAIN : CHAIN);
  const handoffTools = (agent: { tools?: { configs: Record<string, { permission: string }> } }) =>
    ["send_to_agent", "list_agents"].filter((name) => agent.tools?.configs[name]?.permission === "allow");

  it.each(all)("$name names the next seat on every seat that hands work on, and closes the rest", (template) => {
    for (const agent of [...template.agents, ...template.crew]) {
      expect([agent.name, agent.handoffs]).toEqual([agent.name, chainOf(template)[agent.name] ?? false]);
    }
  });

  it.each(all)("$name grants both tools to exactly those seats — a `handoffs` list under deny-by-default offers nothing on its own", (template) => {
    for (const agent of [...template.agents, ...template.crew]) {
      const hands = agent.name in chainOf(template);
      expect([agent.name, handoffTools(agent)]).toEqual([agent.name, hands ? ["send_to_agent", "list_agents"] : []]);
    }
  });

  it.each(all)("$name tells each sender what to pass — the durable id the receiver reads first", (template) => {
    const roster = new Map([...template.agents, ...template.crew].map((a) => [a.name, a]));
    for (const [from, [to]] of Object.entries(chainOf(template))) {
      const sender = roster.get(from);
      if (sender === undefined) continue; // `blank` provisions no crew
      const receiver = roster.get(to!)!;
      expect([from, sender.system]).toEqual([from, expect.stringMatching(/send_to_agent[^.]*wait false/)]);
      // Everything on the agency's side is a CRM row; everything in a client's account is a draft.
      const id = template.crew.some((a) => a.name === from) ? /post_ id/ : /cli_ id/;
      expect([from, sender.system]).toEqual([from, expect.stringMatching(id)]);
      expect([to, receiver.system]).toEqual([to, expect.stringMatching(id)]);
    }
    // Every target a sender names is a seat of the same template.
    for (const agent of [...template.agents, ...template.crew]) {
      for (const target of Array.isArray(agent.handoffs) ? agent.handoffs : []) expect(roster.has(target)).toBe(true);
    }
  });

  it.each(agencies)("$name has the writer wait for the researcher on day one, and only then write the calendar", (template) => {
    const writer = template.agents.find((a) => a.name === "content-writer")!;
    expect(writer.intake?.message).toMatch(/Do not write the calendar or a post yet/);
    expect(writer.schedules?.[0]?.input).toMatch(/If no calendar is filed yet, stop/);
    const researcher = template.agents.find((a) => a.name === "gap-researcher")!;
    expect(researcher.intake?.message).toMatch(/send_to_agent: agent content-writer, wait false/);
  });
});

describe("blank", () => {
  /**
   * `blank` runs this company: SAV, an AI receptionist for small service businesses, auto repair
   * first. The crew runs itself on capped schedules and event wakes (#32); applying it opens no
   * session (no intake) and every fire is bounded by its own budget and its seat's daily cap.
   */
  const seatOf = (name: string) => [...blank.agents, ...blank.crew].find((a) => a.name === name)!;
  const fires = blank.agents.flatMap((agent) => (agent.schedules ?? []).map((s) => [agent.name, s] as const));

  it("names no specialism of the search agency anywhere, outside the seat that does SAV's own SEO", () => {
    // `/serp/google-maps` is the name of a Monid data endpoint research reads listings from, not search work.
    const text = prose({ ...blank, agents: blank.agents.filter((a) => a.name !== "seo") });
    expect(text.replaceAll("/serp/google-maps", "")).not.toMatch(/\bSEO\b|\bGEO\b|search engine|generative-engine|SERP|schema|llms\.txt|citation/i);
  });

  it("runs the receptionist crew: a research seat per sector, then replies, onboarding, payments, monitoring, self-improvement, SEO, promotion and the coding liaison", () => {
    expect(blank.agents.map((a) => [a.name, a.role])).toEqual([
      ["research", "Research"],
      ["research-salon", "Research (hair salon)"],
      ["research-drycleaner", "Research (dry cleaner)"],
      ["research-pt", "Research (physical therapy)"],
      ["research-home", "Research (plumber)"],
      ["sales", "Outreach"],
      ["client-manager", "Onboarding"],
      ["payments", "Payments"],
      ["monitoring", "Monitoring"],
      ["self-improvement", "Self-improvement"],
      ["seo", "SEO"],
      ["promotion", "Promotion"],
      ["coding-liaison", "Coding liaison"],
    ]);
    expect(SECTORS.map((s) => s.seat)).toEqual(blank.agents.slice(0, SECTORS.length).map((a) => a.name));
    expect(blank.crew.map((a) => a.name)).toEqual(["booking"]);
    expect(blank.words.noCrew).toMatch(/moving it to active creates one/);
  });

  it("opens no session on apply, and caps every seat by the day", () => {
    for (const agent of [...blank.agents, ...blank.crew]) {
      const at = agent.name;
      expect([at, agent.intake]).toEqual([at, undefined]);
      expect([at, agent.budget?.period]).toEqual([at, "day"]);
      expect([at, (agent.budget?.cap_micro_usd ?? 0) <= 3_000_000]).toEqual([at, true]);
      expect([at, (agent.budget?.max_task_micro_usd ?? 0) <= (agent.budget?.cap_micro_usd ?? 0)]).toEqual([at, true]);
      expect([at, (Object.values(MODELS) as string[]).includes(agent.model)]).toEqual([at, true]);
      expect([at, agent.system?.startsWith(PREAMBLE)]).toEqual([at, true]);
      expect(agent.system).toMatch(/never send or publish anything yourself/);
      for (const tool of BOARD) expect([at, tool, agent.tools?.configs[tool]?.permission]).toEqual([at, tool, "allow"]);
    }
    // The live seats' caps stay well inside the org's credits: under $15 a day all together.
    const live = blank.agents.filter((a) => !SECTORS.some((s) => s.seat === a.name && !s.live));
    expect(live.reduce((sum, a) => sum + (a.budget?.cap_micro_usd ?? 0), 0)).toBeLessThanOrEqual(15_000_000);
    // The reply seat writes what owners read, so it gets the strong model; bulk seats the cheap one.
    expect(seatOf("sales").model).toBe(MODELS.writer);
    expect(seatOf("research").model).toBe(MODELS.bulk);
    expect(placeholderModel).toBe(MODELS.bulk);
    expect(seatOf("booking").budget).toEqual(placeholderBudget);
  });

  it("schedules each repeating step, capped per fire and inside its seat's daily cap", () => {
    for (const [agent, schedule] of fires) {
      const at = `${agent} @ ${schedule.cron}`;
      const owner = seatOf(agent);
      expect([at, schedule.budget_micro_usd > 0 && schedule.budget_micro_usd <= owner.budget.max_task_micro_usd]).toEqual([at, true]);
    }
    /** Fires a day for the crons this crew writes: `M H * * D`, H a number, a list, or `a-b/n` or `*\/n`. */
    const firesPerDay = (cron: string): number => {
      const [, hour = "*", , , dow = "*"] = cron.split(" ");
      let hours: number;
      if (hour.includes("/")) {
        const [range = "*", step = "1"] = hour.split("/");
        const [from, to] = range === "*" ? [0, 23] : range.split("-").map(Number);
        hours = Math.floor((to! - from!) / Number(step)) + 1;
      } else hours = hour === "*" ? 24 : hour.split(",").length;
      return dow === "*" ? hours : (hours * dow.split(",").length) / 7;
    };
    const perDay = new Map<string, number>();
    for (const [agent, schedule] of fires) perDay.set(agent, (perDay.get(agent) ?? 0) + firesPerDay(schedule.cron) * schedule.budget_micro_usd);
    for (const [agent, total] of perDay) expect([agent, total <= seatOf(agent).budget.cap_micro_usd]).toEqual([agent, true]);
    expect([...new Set(fires.map(([a]) => a))]).toEqual(["research", "sales", "client-manager", "payments", "monitoring", "self-improvement", "seo", "promotion", "coding-liaison"]);
  });

  it("researches two cities a day, a new pair each weekday, and arms only the live sector", () => {
    const research = fires.filter(([a]) => a === "research").map(([, s]) => s);
    expect(research).toHaveLength(RESEARCH_CITIES.length * 2);
    expect(new Set(research.map((s) => /City: ([^.]+)\./.exec(s.input)?.[1])).size).toBe(RESEARCH_CITIES.length * 2);
    for (const sector of SECTORS.filter((s) => !s.live)) expect([sector.seat, seatOf(sector.seat).schedules]).toEqual([sector.seat, []]);
    expect(SECTORS.filter((s) => s.live).map((s) => s.seat)).toEqual(["research"]);
  });

  it("researches fast: one Maps run, the shop's own site for the email, Hunter only as the fallback, and no email means no lead", () => {
    for (const sector of SECTORS) {
      const system = seatOf(sector.seat).system!;
      expect(system).toMatch(/ONE Google Maps search/);
      expect(system).toMatch(/depth: 100/);
      expect(system.indexOf("web_fetch the business's own homepage")).toBeLessThan(system.indexOf('provider "hunterio"'));
      expect(system).toMatch(/Only if both pages show none/);
      expect(system).toMatch(/A business with no email found is not a lead: skip it/);
      expect(system).toMatch(/"Opener detail: <one specific, true thing.*in second person.*I came across <name> and noticed.*no trailing period/);
      expect(system).toMatch(/Never call autoops\.provision_demo/);
      expect(seatOf(sector.seat).tools?.configs["autoops.provision_demo"]).toBeUndefined();
      expect(system).toMatch(/never guess or construct an email/i);
      expect(system).toMatch(/Never invent a business, a name, an email, a number or a detail/);
      expect(seatOf(sector.seat).tools?.configs["web_fetch"]?.permission).toBe("allow");
    }
  });

  it("research never reads the CRM, so its paid lookups are not held for having read people's data", () => {
    for (const sector of SECTORS) {
      const research = seatOf(sector.seat);
      for (const tool of ["dashboard.list_clients", "dashboard.get_client"]) expect([sector.seat, tool, research.tools?.configs[tool]]).toEqual([sector.seat, tool, undefined]);
      expect(research.system).toMatch(/Do not read the CRM/);
    }
  });

  it("sends no first email from sales: it answers a shop that replied, three ways, as Aarav", () => {
    const sales = seatOf("sales");
    const c = sales.tools?.configs ?? {};
    expect(c["agentmail.send_message"]).toBeUndefined();
    expect(c["agentmail.reply_to_message"]?.permission).toBe("allow");
    expect(sales.system).toMatch(/You never send a first email: the outbound engine does that/);
    expect(sales.system).toMatch(/starts with "SHOP REPLIED: <shop name>"/);
    expect(sales.system).toMatch(/\(a\) Interested.*demo link.*15-minute onboarding call/);
    expect(sales.system).toMatch(/If there is no demo yet and the shop is auto repair, first call autoops\.provision_demo once/);
    expect(sales.system).toMatch(/\(b\) Pushback or a question: one short, honest, convincing answer/);
    expect(sales.system).toMatch(/\(c\) Not interested.*"UNSUBSCRIBED:"/);
    expect(sales.system).toMatch(/note "REPLY SENT: <message id>" followed by the reply in full/);
    expect(sales.system).toMatch(/Write as Aarav/);
    expect(sales.system).not.toMatch(/autoops\.update_receptionist/);
    expect(sales.system).toMatch(/autoops\.add_caller/);
    expect(sales.system).toContain(`call ${DEMO_LINE} from that phone, or use the demo page`);
    expect(sales.system).toMatch(/is the only phone number you ever put in an email/);
    expect(sales.system).toMatch(/do nothing if its latest message is already ours/);
  });

  it("books the onboarding call on Google Calendar when connected, else by asking, and never sends a placeholder link", () => {
    const manager = seatOf("client-manager");
    for (const tool of GOOGLE_CALENDAR) expect([tool, manager.tools?.configs[tool]?.permission]).toEqual([tool, "allow"]);
    expect(GOOGLE_CALENDAR.some((t) => /delete|acl|clear/i.test(t))).toBe(false);
    expect(manager.system).toMatch(/if googlecalendar tools are offered.*googlecalendar\.create_event/);
    expect(manager.system).toMatch(/Without calendar tools/);
    expect(BOOKING_URL).toMatch(/TODO/);
    expect(manager.system).toMatch(/contains "TODO", it is a placeholder: never send it/);
    expect(manager.system).toMatch(/"MEETING SCRIPT:" for Aarav/);
    for (const part of ["who the owner is", "what they said", "likely pain points", "demo status", "the questions to ask", "the close: start the free week, then \\$49\\.99 a month"]) {
      expect([part, new RegExp(part).test(manager.system!)]).toEqual([part, true]);
    }
  });

  it("onboards an owner who started a free week, sends the questions itself, and hands the shop to payments", () => {
    const onboarding = seatOf("client-manager");
    expect(onboarding.system).toMatch(/starts with "FREE WEEK STARTED:", there is no card/);
    expect(onboarding.system).toMatch(/using only what the message gives/);
    expect(onboarding.system).toMatch(/"RECEPTIONIST CONFIG:" followed by JSON with keys hours, services, greeting, booking_rules, handoff/);
    expect(onboarding.system).toMatch(/send_to_agent payments \(wait false\) with "CHECKOUT NEEDED: <shop name>"/);
    for (const tool of ["dashboard.create_lead", "dashboard.advance_pipeline", "agentmail.send_message", "agentmail.reply_to_message"]) {
      expect([tool, onboarding.tools?.configs[tool]?.permission]).toEqual([tool, "allow"]);
    }
  });

  it("charges through the checkout link, and turns a shop on only once its subscription is active", () => {
    const payments = seatOf("payments");
    for (const tool of ["autoops.create_trial_checkout", "autoops.activate_shop", "autoops.list_shops"]) expect([tool, payments.tools?.configs[tool]?.permission]).toEqual([tool, "allow"]);
    expect(payments.system).toMatch(/autoops\.create_trial_checkout\(\{ shop_id, owner_email \}\)/);
    expect(payments.system).toMatch(/a completed Stripe checkout activates the shop server-side/);
    expect(payments.system).toMatch(/Call autoops\.activate_shop\(\{ shop_id \}\) only to repair/);
    expect(payments.system).toMatch(/phone_error, that is not a failure.*We'll text your dedicated number within a day/);
    expect(payments.system).toMatch(/TEST mode/);
  });

  it("never offers an agent the owner-contact tool, and monitors from the PII-free summaries first", () => {
    for (const agent of [...blank.agents, ...blank.crew]) expect([agent.name, agent.tools?.configs["autoops.get_claim"]]).toEqual([agent.name, undefined]);
    const monitoring = seatOf("monitoring").system!;
    expect(monitoring).toMatch(/autoops\.list_call_summaries first/);
    expect(monitoring.indexOf("list_call_summaries")).toBeLessThan(monitoring.indexOf("autoops.get_call only"));
    expect(monitoring).toMatch(/the tunnel is down: ask_operator once/);
    expect(monitoring).toMatch(/"MONITOR FLAG:"/);
  });

  it("lets only a shop's own booking seat change a receptionist (AGENTS.md); self-improvement proposes, and never the stage demos", () => {
    for (const agent of [...blank.agents, ...blank.crew]) {
      const c = agent.tools?.configs ?? {};
      const writes = ["autoops.provision_receptionist", "autoops.update_receptionist"].filter((tool) => c[tool]);
      const expected = agent.name === "booking" ? ["autoops.provision_receptionist", "autoops.update_receptionist"] : [];
      expect([agent.name, writes]).toEqual([agent.name, expected]);
      if (agent.tools?.configs["autoops.get_receptionist"]) {
        expect(agent.system).toMatch(/Never call update_receptionist or provision_receptionist for "axl-roadside" or "demo-shop"/);
      }
    }
    const fixer = seatOf("self-improvement").system!;
    expect(fixer.indexOf("2. Reproduce it with autoops.simulate_call")).toBeLessThan(fixer.indexOf("3. Propose the smallest change"));
    expect(fixer).toMatch(/Never call update_receptionist/);
    expect(fixer).toMatch(/vehicle_unclear on a call with no vehicle_corrected after it is a prompt problem/);
  });

  it("asks no permission except a question, and the public site, which a person approves", () => {
    for (const agent of [...blank.agents, ...blank.crew]) {
      const asks = Object.entries(agent.tools?.configs ?? {}).filter(([, c]) => c.permission === "ask").map(([name]) => name);
      expect([agent.name, asks]).toEqual([agent.name, agent.name === "seo" ? ["ask_operator", "dashboard.update_site"] : ["ask_operator"]]);
    }
  });

  it("drafts promotion and never posts it", () => {
    const promotion = seatOf("promotion");
    const names = Object.keys(promotion.tools?.configs ?? {});
    expect(names.filter((n) => /social|publish|approve_post|schedule_post/.test(n))).toEqual([]);
    expect(promotion.tools?.configs["dashboard.create_draft_post"]?.permission).toBe("allow");
    expect(promotion.system).toMatch(/You draft; you never post/);
  });

  it("collects infra requests from every seat for the human coding agents", () => {
    for (const agent of [...blank.agents, ...blank.crew]) {
      expect([agent.name, agent.system?.includes('starting "INFRA REQUEST:"')]).toEqual([agent.name, true]);
      expect([agent.name, agent.tools?.configs["dashboard.create_lead"]?.permission, agent.tools?.configs["dashboard.add_client_note"]?.permission]).toEqual([agent.name, "allow", "allow"]);
    }
    expect(seatOf("coding-liaison").system).toMatch(/ask_operator once with the whole list/);
  });

  it("plans a pipeline whose every owner is a seat of this template", () => {
    const seats = new Set([...blank.agents, ...blank.crew].map((a) => a.name));
    for (const step of PIPELINE) expect([step.key, seats.has(step.owner)]).toEqual([step.key, true]);
  });

  it("files the receptionist's kinds of work, and the promotion seat's", () => {
    expect(blank.kinds.map((k) => k.id)).toEqual(["script", "report", "audit", "post", "ad"]);
  });
});

describe("seo-geo", () => {
  it("is a delta on the shared agency core, not a fork of it", () => {
    // Same seven, model, budget and schedule. SEO/GEO adds focus, search skills and only the
    // read-only measurement tools its own scheduled content/research work consumes.
    expect(seoGeo.agents.slice(0, roster.length).map((a) => a.name)).toEqual(roster.map((a) => a.name));
    expect(seoGeo.agents.at(-1)?.name).toBe("paid-media-planner");
    for (const [i, agent] of seoGeo.agents.slice(0, roster.length).entries()) {
      const base = roster[i]!;
      expect(agent.system).toContain(base.system);
      expect(agent.system).not.toBe(base.system);
      expect(agent.skills?.slice(0, base.skills?.length)).toEqual(base.skills);
      // Day-one and scheduled work may only be added to, as the system prompt is: the search-specific
      // part (F2's audit-first opener) rides on the end of blank's own words.
      expect(agent.intake?.message.startsWith(base.intake?.message ?? "")).toBe(true);
      for (const [j, schedule] of (agent.schedules ?? []).entries()) expect(schedule.input.startsWith(base.schedules![j]!.input)).toBe(true);
      const shape = (a: typeof agent) => ({ ...a, system: "", skills: [], intake: { ...a.intake, message: "" }, schedules: a.schedules?.map((s) => ({ ...s, input: "" })) });
      expect({ ...shape(agent), tools: base.tools }).toEqual(shape(base));
    }
  });

  it("asks only ready clients for a referral, held for approval, with their link and no invented reward", () => {
    for (const template of [seoGeo]) {
      const manager = template.agents.find((a) => a.name === "client-manager")!;
      const configs = manager.tools?.configs ?? {};
      expect(configs["dashboard.list_referral_ready"]?.permission).toBe("allow");
      expect(configs["dashboard.record_referral_ask"]?.permission).toBe("allow");
      // The ask itself is an email, so it waits for the operator like every other send.
      expect(configs["email.send"]?.permission).toBe("ask");
      const weekly = manager.schedules?.[0]?.input ?? "";
      expect(weekly).toContain(REFERRAL_ASK);
      expect(REFERRAL_ASK).toMatch(/list_referral_ready names the clients ready.*ask nobody else/);
      expect(REFERRAL_ASK).toMatch(/referral link exactly as given.*Offer no reward, discount or fee.*record_referral_ask/);
    }
    const seoWeekly = seoGeo.agents.find((a) => a.name === "client-manager")!.schedules?.[0]?.input ?? "";
    expect(seoWeekly).toMatch(/leads with the gain the client's latest posted serp-report shows.*never state a gain the report does not show/);
  });

  it("opens every cold email with something read on the prospect's site, and in seo-geo with an audit", () => {
    for (const template of [seoGeo]) {
      const sales = template.agents.find((a) => a.name === "sales")!;
      expect(sales.intake?.message).toContain(OPENER);
      expect(sales.schedules?.[0]?.input).toContain(OPENER);
    }
    const sales = seoGeo.agents.find((a) => a.name === "sales")!;
    for (const text of [sales.intake?.message ?? "", sales.schedules?.[0]?.input ?? ""]) {
      expect(text).toMatch(/short public audit of the prospect.*web_fetch.*web_search/);
      // The audit is for cold openers; the personal notes to the operator's own network stay notes.
      expect(text).toMatch(/every cold opener \(not the personal notes to people the operator knows\)/);
      expect(text).toMatch(/add_client_note: what it ranks for, whether AI answers cite it, and two or three concrete fixes/);
      expect(text).toMatch(/no ranking, citation or traffic figure you did not see yourself/);
    }
    // blank asks for one observation, not an audit.
    expect(roster.find((a) => a.name === "sales")!.intake?.message).not.toMatch(/public audit/);
    expect(roster.find((a) => a.name === "sales")!.schedules?.[0]?.input).not.toMatch(/public audit/);
  });

  it("adds the specialism: the kinds, and the crew provisioned per client", () => {
    expect(seoGeo.kinds.map((k) => k.id)).toEqual(["article", "landing-page", "answer-block", "serp-report", "audit", "ad-plan"]);
    expect(seoGeo.crew.map((a) => a.name)).toEqual(["seo-writer", "geo-optimizer", "audit-runner"]);
    // The crew's model is the template's, not the server's — `server/proxy.ts` posts these as they
    // stand and decides nothing.
    for (const member of seoGeo.crew) expect(member.model).toBe(roster[0]!.model);
  });

  it("widens over the shared core: it drops no agent the core declares", () => {
    const gone = roster.map((a) => a.name).filter((name) => !seoGeo.agents.some((a) => a.name === name));
    expect(gone).toEqual([]);
  });
});

describe("product-design", () => {
  const seat = (name: string) => productDesign.agents.find((a) => a.name === name)!;
  const permission = (name: string, tool: string) => seat(name).tools?.configs[tool]?.permission;

  it("is a studio of four, with no per-client crew", () => {
    expect(productDesign.agents.map((a) => [a.name, a.role])).toEqual([
      ["account-manager", "Studio lead"],
      ["designer", "Concept meshes"],
      ["engineer", "Dimensioned parts"],
      ["visualizer", "Stills & video"],
    ]);
    expect(productDesign.crew).toEqual([]);
    expect(productDesign.words.noCrew).toBe("This studio runs every brief through its four designers.");
    expect(productDesign.kinds.map((k) => k.id)).toEqual(["concept", "still", "part", "product-video"]);
  });

  it("asks the four studio questions, all required — the engine's cap", () => {
    expect(productDesign.questions.map((q) => q.key)).toEqual(["products", "audience", "manufacturable", "done"]);
    expect(productDesign.questions.filter((q) => q.optional)).toEqual([]);
    for (const q of productDesign.questions) expect([q.key, (q.help ?? "").length > 0]).toEqual([q.key, true]);
  });

  it("writes each seat to the plan's shape, every one reading the product-design skill first", () => {
    for (const agent of productDesign.agents) {
      const at = agent.name;
      expect([at, agent.system?.startsWith(PREAMBLE)]).toEqual([at, true]);
      expect([at, agent.description?.match(/[.!?](\s|$)/g)?.length]).toEqual([at, 2]);
      const n = words(agent.system ?? "");
      // 460, not 400: the live run's fixes (read the note even with a cli_ id in hand, one build_3d
      // call, a still rendered from the GLB) each needed their own words on top of the shared gate.
      expect([at, n >= 150 && n <= 460]).toEqual([at, true]);
      expect([at, agent.skills?.[0]]).toEqual([at, "naive/product-design"]);
      for (const ref of agent.skills ?? []) expect([at, ref]).toEqual([at, expect.stringMatching(/^naive\/[a-z0-9-]+(@\d+)?$/)]);
      // Only the studio lead has a day one: every other seat waits for a brief, so nothing is made
      // before the studio note exists.
      expect([at, agent.intake?.budget_micro_usd]).toEqual([at, at === "account-manager" ? 20_000_000 : undefined]);
    }
    expect(Object.fromEntries(productDesign.agents.map((a) => [a.name, a.skills]))).toEqual({
      "account-manager": ["naive/product-design", "naive/client-onboarding"],
      designer: ["naive/product-design", "naive/3d-modeling"],
      engineer: ["naive/product-design", "naive/cad-parts"],
      visualizer: ["naive/product-design", "naive/product-video-3d"],
    });
  });

  it("writes the studio note on day one before anything is made, then hands ONE first brief to the designer", () => {
    const intake = seat("account-manager").intake?.message ?? "";
    expect(intake).toMatch(new RegExp(`^Read project_context\\. Before any other tool: write the ${STUDIO_NOTE}`));
    const note = intake.indexOf(STUDIO_NOTE);
    for (const tool of ["generate_3d_model", "generate_image", "generate_video", "build_3d"]) {
      const at = intake.indexOf(tool);
      expect([tool, at === -1 || at > note]).toEqual([tool, true]);
    }
    expect(intake).toMatch(/hand ONE first brief to designer \(send_to_agent, wait false\)/);
    expect(intake).toMatch(/pour-over carafe/);
    // And every maker refuses to make anything until that note exists.
    for (const name of ["designer", "engineer", "visualizer"]) {
      expect([name, seat(name).system]).toEqual([name, expect.stringContaining(`read the note titled ${STUDIO_NOTE}`)]);
      expect([name, seat(name).system]).toEqual([name, expect.stringMatching(/If there is none yet, make nothing and stop/)]);
      // Live run 2026-11-03: the engineer and visualizer skipped the note when the handoff named a cli_ id.
      expect([name, seat(name).system]).toEqual([name, expect.stringMatching(/First, every session, even when the message names a cli_ id: read the note titled STUDIO NOTE on the agency's own record \(list_clients, get_client\)/)]);
    }
  });

  it("routes a look to the designer and a part — millimetres — to the engineer", () => {
    const lead = seat("account-manager").system ?? "";
    expect(lead).toMatch(/names sizes in millimetres is a part: hand it to engineer/);
    expect(lead).toMatch(/is a look: hand it to designer/);
    expect(lead).toMatch(/contradicts the note.*ask_operator once/);
    expect(lead).toMatch(/Never email a client before the deliverable is approved/);
    // Live run r2: three name-only create_lead calls for a client returned the agency's own record.
    expect(lead).toMatch(/create_lead with the domain or contact_email the brief gives — a name alone files the agency's own record — and with neither, ask_operator once for one; never invent one/);
  });

  it("gives the designer meshes and never build_3d, and the engineer build_3d and never a generated mesh", () => {
    expect(permission("designer", "generate_3d_model")).toBe("allow");
    expect(permission("designer", "build_3d")).toBeUndefined();
    expect(seat("designer").system).toMatch(/Never call build_3d/);
    expect(seat("designer").system).toMatch(/never poll/);
    expect(permission("engineer", "build_3d")).toBe("allow");
    expect(permission("engineer", "generate_3d_model")).toBeUndefined();
    expect(seat("engineer").system).toMatch(/engine cad/);
    expect(seat("engineer").system).toMatch(/watertight is true and every bbox_mm edge is within 0\.5 mm/);
    expect(seat("engineer").system).toMatch(/Never call generate_3d_model\./);
    expect(seat("engineer").system).toMatch(/Call build_3d ONCE with engine cad and render iso: it already exports STEP and STL, so never call it again just to export/);
    expect([permission("account-manager", "build_3d"), permission("account-manager", "generate_3d_model")]).toEqual([undefined, undefined]);
    expect(permission("visualizer", "generate_3d_model")).toBeUndefined();
  });

  it("makes one still per look and holds product video for the operator", () => {
    // Live run 2026-11-03: a text-to-image still showed a jug while the GLB was an hourglass carafe.
    // The still is a Blender render of the GLB itself, so it can only show the mesh being filed.
    expect(permission("visualizer", "build_3d")).toBe("allow");
    expect(permission("visualizer", "generate_image")).toBeUndefined();
    expect(permission("visualizer", "generate_video")).toBe("ask");
    expect(seat("visualizer").system).toMatch(/The still is a render of THAT mesh, never a picture drawn from the brief's words/);
    expect(seat("visualizer").system).toMatch(/fetch_file the GLB, then ONE build_3d call — engine blender, render false, publish false.*bpy\.ops\.import_scene\.gltf.*to still\.png in the GLB's folder.*publish_file that still\.png/);
    expect(seat("visualizer").system).toMatch(/A product video only when the brief asks/);
    // Live run r2: no engine named cost 5 build_3d calls (Cycles 128 spp timed out, EEVEE has no libEGL here).
    expect(seat("visualizer").system).toMatch(/renders with Cycles \(device CPU, 32 samples, denoise; never EEVEE\) at 1024x1024/);
    // naive/product-video-3d's turntable runs from bash, which the visualizer does not hold.
    expect(seat("visualizer").system).toMatch(/generate_video from the still.*Skip the skill's turntable step/);
    expect(permission("visualizer", "bash")).toBeUndefined();
  });

  it("files every file as one pending studio deliverable carrying its fil_ ids", () => {
    for (const name of ["engineer", "visualizer"]) {
      expect(permission(name, "dashboard.create_draft_post")).toBe("allow");
      expect([name, seat(name).system]).toEqual([name, expect.stringMatching(/create_draft_post.*channel studio.*files the fil_ ids/)]);
    }
    expect(seat("engineer").system).toMatch(/Kind part, files the STEP, the STL and the preview; the summary carries bbox_mm and volume_cm3/);
    expect(seat("visualizer").system).toMatch(/kind concept, files the GLB then the still/);
    // The designer and the lead file no deliverable: the designer's mesh rides on the visualizer's.
    for (const name of ["account-manager", "designer"]) expect(permission(name, "dashboard.create_draft_post")).toBeUndefined();
  });

  it("holds nothing outward at allow", () => {
    const OUTWARD = ["social.post", "email.send", "generate_video", "dashboard.approve_post", "dashboard.update_site", "apps"];
    for (const agent of productDesign.agents) {
      for (const [tool, config] of Object.entries(agent.tools?.configs ?? {})) {
        if (OUTWARD.includes(tool) || tool.startsWith("social.")) expect([agent.name, tool, config.permission]).toEqual([agent.name, tool, "ask"]);
      }
      expect(agent.tools?.configs).not.toHaveProperty("social.post");
    }
    expect(permission("account-manager", "email.send")).toBe("ask");
  });

  it("runs one weekly timer, the studio check-in, that proposes nothing outward", () => {
    const fires = productDesign.agents.flatMap((agent) => (agent.schedules ?? []).map((s) => [agent.name, s.cron, s.summary, s.budget_micro_usd]));
    expect(fires).toEqual([["account-manager", "0 9 * * 1", "Studio check-in", 5_000_000]]);
    expect(seat("account-manager").schedules?.[0]?.input).toMatch(/Propose nothing outward, make nothing, and send nothing/);
  });

  it("seeds only demo rows on the studio channel, with no file that does not exist", () => {
    for (const post of productDesign.seed.posts as Post[]) {
      expect([post.id, post.channel, post.files]).toEqual([post.id, "studio", undefined]);
      expect(post.summary).toMatch(/^Demo row —/);
    }
  });
});

/**
 * The schedules, which are template data like everything else here — and the one place this
 * blueprint fires without an operator watching, so the two fields nobody sets by accident matter
 * most: an absent `timezone` is UTC by the API's default, and an absent `identity` is a fire that
 * speaks as nobody and resolves no connected account.
 */
describe("schedules", () => {
  const declared = (template: (typeof all)[number]) =>
    template.agents.flatMap((agent) => (agent.schedules ?? []).map((schedule) => [agent.name, schedule] as const));

  it.each(agencies)("$name runs the plan's five timers, and none for the site-builder or the proposal-writer", (template) => {
    expect(declared(template).map(([agent, schedule]) => [agent, schedule.cron])).toEqual([
      // A pipeline goes stale in days: weekday mornings, before the weekly review it feeds.
      ["sales", "30 8 * * 1-5"],
      ["client-manager", "0 8 * * 1"],
      ["content-writer", "0 7 * * 2,4"],
      ["content-reviser", "0 9 * * 3"],
      ["gap-researcher", "0 9 * * 5"],
    ]);
  });

  it.each(all)("$name fires each one in the agency's zone, as the agency", (template) => {
    for (const [agent, schedule] of declared(template)) {
      const at = `${agent} @ ${schedule.cron}`;
      expect([at, schedule.timezone]).toEqual([at, AGENCY_TIMEZONE]);
      expect([at, schedule.identity]).toEqual([at, AGENCY_IDENTITY]);
      // A session naming a persona its agent does not hold is refused before it runs, so the
      // schedule's identity is only reachable because the agent above holds the same one.
      const holder = template.agents.find((one) => one.name === agent);
      expect([at, holder?.identity]).toEqual([at, schedule.identity]);
      // The zone must be one the platform can schedule in: `POST /v1/deployments` validates it
      // through `Intl` and refuses what it cannot format.
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone })).not.toThrow();
    }
  });
  it.each(agencies)("$name says what every fire comes to, in a few plain words for the launch card", (template) => {
    expect(declared(template).map(([agent, schedule]) => [agent, schedule.summary])).toEqual([
      ["sales", "Inbox and new leads"],
      ["client-manager", "Client check-in"],
      ["content-writer", "New blog post"],
      ["content-reviser", "Fix weak pages"],
      ["gap-researcher", "Competitor gap report"],
    ]);
  });
});

describe("the launch card's words", () => {
  it("names each template the way an owner would, never by its id", () => {
    expect(all.map((t) => [t.name, t.title])).toEqual([
      ["blank", "AI Receptionist for Auto Shops"],
      ["seo-geo", "SEO & GEO agency"],
      ["product-design", "Product design studio"],
    ]);
    for (const t of all) {
      expect(t.title.length).toBeLessThanOrEqual(80);
      expect(t.description.length).toBeLessThanOrEqual(280);
    }
  });

  it("says what Day 1 comes to, and claims an every-day line only where a timer runs every day", () => {
    expect(all.map((t) => [t.name, t.roadmap])).toEqual([
      ["blank", { day_one: "Crew, board and schedules set up", every_day: "New leads · Shop replies · Call checks" }],
      ["seo-geo", { day_one: "Set up your site, pipeline and competitor gaps" }],
      ["product-design", { day_one: "Write the studio note and make the first concept look" }],
    ]);
    // blank runs every day (research on every weekday's cron, replies and checks on `*`); the other
    // templates' timers are weekday-only or weekly, so "every day" would promise weekends that do not run.
    const daily = (t: (typeof all)[number]) => t.agents.flatMap((agent) => agent.schedules ?? []).some((s) => s.cron.split(" ")[4] === "*");
    expect(daily(blank)).toBe(true);
    for (const t of all.filter((one) => one.name !== "blank")) {
      expect(t.roadmap.every_day).toBeUndefined();
      for (const schedule of t.agents.flatMap((agent) => agent.schedules ?? [])) {
        expect(schedule.cron.split(" ")[4]).not.toBe("*");
      }
    }
  });

  it("speaks in outcomes, never tool names or the prompt's own instructions", () => {
    for (const t of all) {
      const summaries = t.agents.flatMap((agent) => (agent.schedules ?? []).map((s) => s.summary!));
      expect(t.roadmap.day_one!.length).toBeLessThanOrEqual(60);
      for (const summary of summaries) expect(summary.length).toBeLessThanOrEqual(48);
      for (const line of [t.roadmap.day_one!, ...summaries]) expect(line).not.toMatch(/project_context|_|\.|\(/);
    }
  });
});

describe("kindLabel", () => {
  it("names a kind the active template declares, and passes any other through", () => {
    const [first] = TEMPLATES[TEMPLATE].kinds;
    expect(kindLabel(first!.id)).toBe(first!.label);
    // A row filed under another template keeps its kind after a switch; the screen shows the id
    // rather than an empty chip.
    expect(kindLabel("a-kind-from-another-template")).toBe("a-kind-from-another-template");
  });
});

/**
 * The README is where a person reads what an install will cost, before they can read a declaration,
 * so the placeholder budget it states is derived from `templates/receptionist.ts` here, and the next
 * retune cannot leave the number behind.
 */
describe("what the README promises about spend", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

  it("names every seat's daily cap and per-task ceiling, and its model", () => {
    for (const agent of [...blank.agents, ...blank.crew]) {
      const row = readme.split("\n").find((line) => line.startsWith(`| \`${agent.name}\``) || line.startsWith(`| \`${agent.name}--<shop>\``));
      expect([agent.name, row]).toEqual([agent.name, expect.stringContaining(`${usd(agent.budget.cap_micro_usd)}/day`)]);
      expect([agent.name, row]).toEqual([agent.name, expect.stringContaining(usd(agent.budget.max_task_micro_usd))]);
      expect([agent.name, row]).toEqual([agent.name, expect.stringContaining(agent.model)]);
    }
    expect(readme).toMatch(/Pause the company/);
  });
});
