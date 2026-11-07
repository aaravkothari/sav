/**
 * `seo-geo` — the same agency, specialised in search: technical audits, SERP work and
 * answer-engine optimization, with a three-agent crew provisioned per client.
 *
 * It is a **delta on `blank`**, and deliberately reads as one. The seven agency agents are
 * `blank`'s, with a sentence or two of search focus added to each and the search skills alongside;
 * the machinery around them — model, budget, deny-by-default toolset, approval gate, timers,
 * intakes — is shared (search work is only ever appended to an intake or timer, `WORK`, never
 * changing `blank`'s words), so what this file shows is exactly what the specialism changes: the words,
 * the kinds of work, the third question, the crew, and the demo seed.
 *
 * Switching to it widens: `naive up` creates nothing the operator loses, and the crew below is
 * created per client at onboarding by `server/proxy.ts`. Switching away leaves every crew agent
 * standing and reports it — an agent is deleted only by an explicit `removed:` tombstone.
 */
import type { AgentDecl } from "@usenaive-sdk/blueprints";
import type { Client } from "../seed/clients.ts";
import type { Post } from "../seed/posts.ts";
import { AGENCY_IDENTITY, agencyQuestions as questions, blank, budget, crm, gate, HANDOFF, model, OPERATOR, PREAMBLE, roster, tools, type AgencyTemplate } from "./blank.ts";
import { VOCABULARY } from "./index.ts";

/** What each shared agent additionally does when the agency's specialism is search. */
const FOCUS: Record<string, string> = {
  "site-builder":
    "This agency sells search and answer-engine work: the services section names SEO, GEO and content; the FAQ answers what GEO is and how citations are measured; every page carries one clear query it is built for.",
  sales:
    "This agency sells search and answer-engine work: research each lead's search presence first — what it ranks for, where AI answers cite it, what a first audit would find.",
  "client-manager":
    "The deliverables here are audits, articles, landing pages, answer blocks and SERP reports; keep each client's calendar full of them and each client's team pointed at the next one.",
  "content-writer":
    "Write every post for one query and intent, using connected Search Console evidence when available, a citable answer block, and a named entity. Never invent queries or results.",
  "content-reviser":
    "Weak here means: no target query, no answer block, thin entity coverage, or a title that no longer matches the query it ranks for. Read Search Console and Analytics before revising so work that is performing is left alone; if the properties are unavailable, say so instead of inventing performance.",
  "gap-researcher":
    "Compare the three competitors in the third setup answer by rankings and AI citations against connected Search Console and Analytics evidence when available; never invent performance.",
  "proposal-writer":
    "Tiers are scoped in audits, articles, answer blocks and SERP reports per month; a proposal never promises a ranking or a citation.",
};

/** The search skills each agent reads alongside its generic ones. */
const SKILLS: Record<string, string[]> = {
  "content-writer": ["naive/geo-answer-blocks"],
  "gap-researcher": ["naive/geo-answer-blocks"],
};

/**
 * What a search agency's day-one and scheduled work adds, for agents whose system prompt has no room
 * left (each is capped at 400 words). Plan F2: a search agency opens with a finding, so sales audits
 * the prospect's public presence before it drafts the opener.
 */
const WORK: Record<string, string> = {
  sales:
    "In this agency every cold opener (not the personal notes to people the operator knows) starts from a short public audit of the prospect: web_fetch its home page and one service page, and web_search the service it sells with its city or niche to see who ranks and whether an AI answer cites it. " +
    "File the audit as a note on the lead with add_client_note: what it ranks for, whether AI answers cite it, and two or three concrete fixes, each naming the page or search it came from. The opener quotes one finding. " +
    "Public pages only, and no ranking, citation or traffic figure you did not see yourself.",
  "client-manager":
    "In this agency a referral ask leads with the gain the client's latest posted serp-report shows, quoted from that report (list_posts); with no gain in it, thank them for the work instead, and never state a gain the report does not show.",
};
const withWork = (name: string, text: string): string => (WORK[name] ? `${text} ${WORK[name]}` : text);

/** The gate again, for an agent that works inside one client's account rather than the agency's. */
const clientGate =
  `You work for an SEO/GEO agency on one client's account. ${gate} ` +
  "The client is the CRM row your name ends in (list_clients, get_client); file every deliverable as a pending draft on that client with create_draft_post, in full, and read list_posts first so you do not file what is already queued. " +
  "The client's own Search Console and Analytics reach you only once the operator has connected them; if none of the search tools you were granted is offered this turn, say which account is missing and ask the operator to connect it with ask_operator rather than estimating a number.";

/**
 * What a search crew reads on the client's *own* connected accounts, named the way a connection
 * reaches a turn (`<connector>.<tool>`). A policy row does not create the account: the tool exists
 * in a turn only once the operator has connected the property to `AGENCY_IDENTITY`. Every one is a
 * read, so every one is `allow`: this crew works inside one client's property and changes nothing
 * there. Without these names an SEO crew connected to a client's search account still sees only
 * `web_search` and `web_fetch` — the client's own numbers stay out of reach. Each member also
 * carries both operator doors (`OPERATOR`): `ask_operator` for the account not yet connected, and
 * `request_tools` for a tool the task turns out to need that this list does not name.
 */
const SEARCH_READ = [
  "google_search_console.search_analytics_query",
  "google_search_console.list_sites",
  "google_search_console.inspect_url",
  "google_analytics.run_report",
];

/** Founder Frame's own scheduled research and writing must use its connected measurement too. */
const AGENCY_SEARCH_READ: Record<string, string[]> = {
  "content-writer": ["google_search_console.search_analytics_query"],
  "content-reviser": ["google_search_console.search_analytics_query", "google_analytics.run_report"],
  "gap-researcher": SEARCH_READ,
};

/** Read-only evidence for a proposal. These tools cannot create campaigns, mutate ads or spend. */
const AD_READ = [
  "googleads.list_accessible_customers",
  "googleads.get_campaign_by_id",
  "googleads.get_campaign_by_name",
  "googleads.search_stream_gaql",
  "metaads.get_ad_accounts",
  "metaads.get_insights",
  "metaads.list_targeting_search",
  "metaads.read_adsets",
];

const paidMediaPlanner: AgentDecl = {
  name: "paid-media-planner",
  role: "Paid media planning",
  model,
  budget,
  description: "Builds evidence-backed paid-search and paid-social proposals. It cannot launch campaigns or spend.",
  system:
    `${PREAMBLE} ${gate} You are the agency's paid-media planner. Produce a proposal, never a live campaign. ` +
    "Read dashboard.get_site and the CRM before drafting. State which ad-account integrations are actually connected; an unavailable channel is recommendation-only. " +
    "Use operator-selectable budget scenarios unless project_context contains an approved budget. Never invent a benchmark, forecast, contract term, reporting cadence or result. " +
    "Cover channel rationale, audiences and exclusions, campaign structure, three creative concepts, landing-page match, conversion events, attribution, experiment design and stop rules. " +
    "File the plan as a pending ad-plan on the agency profile. You have no authority to create, mutate, launch, fund or purchase anything.",
  tools: tools(
    ["web_search", "web_fetch", ...crm("list_clients", "get_client", "list_posts", "create_draft_post", "get_site"), ...AD_READ],
    OPERATOR,
  ),
  skills: ["naive/proposal-writing"],
  handoffs: false,
  identity: AGENCY_IDENTITY,
  intake: {
    message:
      "Read project_context, the public site and any connected ad accounts. Draft a zero-baseline paid-media proposal with operator-selectable budget scenarios, measurement and stop rules. Label unsupported channels recommendation-only, file one pending ad-plan and launch nothing.",
    budget_micro_usd: 20_000_000,
  },
};

/**
 * The per-client crew. `server/proxy.ts` appends the client slug to each name at onboarding
 * (`seo-writer--acme-dental`), which is how one organization hosts many clients' agents. Model,
 * budget, allow-list and persona are template data — the server holds none of them.
 *
 * The three run as a chain, not three sessions the operator opens by hand: the audit runner files
 * the audit and hands its `post_` id to the SEO writer, who writes the pages the audit found
 * missing and hands their `post_` ids to the GEO optimizer, who tunes those pages for citations.
 * Each `handoffs` entry names the seat, and `server/proxy.ts` slugs it the same way it slugs the
 * name, so `audit-runner--acme-dental` may reach exactly `seo-writer--acme-dental`.
 *
 * Every member names `AGENCY_IDENTITY` for the reason the agency's own seven do: without a persona
 * the search and analytics names above resolve to nothing, and a crew sold on working against the
 * client's own numbers can call `web_search` and `web_fetch` and no more. `POST /v1/agents` carries
 * no identity field, so the grant is a second call — `server/proxy.ts` makes it, and reports the
 * member `failed` when it does not land rather than leaving an agent running as nobody behind a
 * toolset that says otherwise.
 */
const crew: AgentDecl[] = [
  {
    name: "seo-writer",
    role: "SEO writer",
    model,
    budget,
    description: "Briefs, articles and landing copy from the client's keywords and site.",
    system: `${clientGate} You are the SEO writer: turn the client's keywords and site into briefs, articles and landing copy that can rank (kinds article and landing-page). Start from what the client already ranks for (google_search_console.search_analytics_query) rather than from a guess. A session opened by the audit runner names the audit's post_ id: read that draft with list_posts and write the pages it found missing, in its order. When your drafts are filed, hand their post_ ids to this client's GEO optimizer with send_to_agent (wait false) — list_agents names the one seat you may reach — so it tunes what you wrote rather than what it guesses you wrote.`,
    tools: tools(
      ["web_search", "web_fetch", ...crm("list_clients", "get_client", "list_posts", "create_draft_post"), "google_search_console.search_analytics_query", ...HANDOFF],
      OPERATOR,
    ),
    handoffs: ["geo-optimizer"],
    identity: AGENCY_IDENTITY,
  },
  {
    name: "geo-optimizer",
    role: "GEO optimizer",
    model,
    budget,
    description: "Content tuned for AI-engine citations: schema, entity coverage, answer blocks, llms.txt.",
    system: `${clientGate} You are the GEO optimizer: tune the client's content for AI-engine citations — schema, entity coverage, answer blocks, llms.txt — and file each as an answer-block draft or a revision brief. A session opened by the SEO writer names post_ ids: those drafts are the ones you tune, read them with list_posts first. Search the query yourself and read what IS being cited; the gap is the brief.`,
    tools: tools(
      ["web_search", "web_fetch", ...crm("list_clients", "get_client", "list_posts", "create_draft_post"), "google_search_console.search_analytics_query", "google_search_console.inspect_url"],
      OPERATOR,
    ),
    handoffs: false,
    identity: AGENCY_IDENTITY,
  },
  {
    name: "audit-runner",
    role: "Audit runner",
    model,
    budget,
    description: "Recurring technical and content audits of the client's site and rankings.",
    system: `${clientGate} You are the audit runner: run recurring technical and content audits of the client's site and rankings against the client's own connected search and analytics accounts, and file the findings as an audit or serp-report draft. When the audit is filed, hand its post_ id to this client's SEO writer with send_to_agent (wait false) — list_agents names the one seat you may reach — with the pages it found missing, in order of value, so they are written from the audit and not from a guess. A number you did not read from the client's account is a number you may not report; say plainly which property was missing.`,
    tools: tools(
      ["web_search", "web_fetch", ...crm("list_clients", "get_client", "list_posts", "create_draft_post"), ...SEARCH_READ, ...HANDOFF],
      OPERATOR,
    ),
    handoffs: ["seo-writer"],
    identity: AGENCY_IDENTITY,
  },
];

const clients: Client[] = [
  {
    id: "cli_ac01", slug: "acme-dental", name: "Acme Dental", domain: "acmedental.example", stage: "active",
    services: ["SEO", "GEO", "Content"],
    contact: { name: "Sample Contact", email: "contact@acmedental.example", role: "Owner" },
    notes: ["Demo row — wants to rank for 'invisalign boston' by Q3.", "Approved the pillar-page plan on the last call."],
    nextAction: "Send March content calendar for sign-off",
  },
  {
    id: "cli_no02", slug: "northbeam", name: "Northbeam Legal", domain: "northbeam.example", stage: "active",
    services: ["SEO", "Content"],
    contact: { name: "Sample Contact", email: "contact@northbeam.example", role: "Managing partner" },
    notes: ["Demo row — practice-area pages are thin; the audit flagged 14 of 22."],
    nextAction: "Review audit-runner findings together (Thu)",
  },
  {
    id: "cli_ve03", slug: "verdant", name: "Verdant Skincare", domain: "verdant.example", stage: "active",
    services: ["GEO", "Content"],
    contact: { name: "Sample Contact", email: "contact@verdant.example", role: "Head of growth" },
    notes: ["Demo row — wants AI-engine citations for 'retinol alternatives'.", "llms.txt shipped last sprint."],
    nextAction: "Share the first citation report",
  },
  {
    id: "cli_ha04", slug: "harbor", name: "Harbor Fintech", domain: "harbor.example", stage: "proposal",
    services: ["SEO", "GEO"],
    contact: { name: "Sample Contact", email: "contact@harbor.example", role: "CMO" },
    notes: ["Demo row — proposal sent: 12 articles a month plus audits."],
    nextAction: "Follow up on the proposal (no reply in 5 days)",
  },
  {
    id: "cli_su05", slug: "summit", name: "Summit Outdoor Co", domain: "summitoutdoor.example", stage: "lead",
    services: ["SEO"],
    contact: { name: "Sample Contact", email: "contact@summitoutdoor.example", role: "Founder" },
    notes: ["Demo row — inbound from the site's contact form; wants a technical audit first."],
    nextAction: "Book discovery call",
  },
  {
    id: "cli_or07", slug: "orchard", name: "Orchard Realty", domain: "orchardrealty.example", stage: "churned",
    services: ["SEO"],
    contact: { name: "Sample Contact", email: "contact@orchardrealty.example", role: "Broker" },
    notes: ["Demo row — paused after four months. Re-approach in the fall."],
  },
];

const posts: Post[] = [
  { id: "post_a101", clientId: "cli_ac01", title: "Invisalign vs braces: the honest cost breakdown", summary: "Demo row — pillar article targeting 'invisalign boston cost', with FAQ schema.", kind: "article", channel: "blog", status: "pending", agent: "seo-writer--acme-dental", scheduledFor: "2025-03-04", hue: 210 },
  { id: "post_a102", clientId: "cli_ac01", title: "Emergency dentist landing page", summary: "Demo row — location page with LocalBusiness schema and a same-day booking CTA.", kind: "landing-page", channel: "blog", status: "ready", agent: "seo-writer--acme-dental", scheduledFor: "2025-03-07", hue: 160 },
  { id: "post_a103", clientId: "cli_ac01", title: "Answer block: 'does whitening damage enamel?'", summary: "Demo row — entity-dense answer block tuned for AI-engine citation.", kind: "answer-block", channel: "blog", status: "approved", agent: "geo-optimizer--acme-dental", scheduledFor: "2025-03-12", hue: 280 },
  { id: "post_a104", clientId: "cli_ac01", title: "March technical audit", summary: "Demo row — crawl and Core Web Vitals sweep.", kind: "audit", channel: "blog", status: "posted", agent: "audit-runner--acme-dental", scheduledFor: "2025-03-01", postedAt: "2d ago", clicks: 312, impressions: 9_840, hue: 30 },
  { id: "post_n201", clientId: "cli_no02", title: "What to do after a rear-end collision in MA", summary: "Demo row — practice-area article from a competitor gap in the last audit.", kind: "article", channel: "blog", status: "pending", agent: "seo-writer--northbeam", scheduledFor: "2025-03-05", hue: 340 },
  { id: "post_n202", clientId: "cli_no02", title: "Practice-area rankings, February", summary: "Demo row — where the 22 practice pages sit, and against whom.", kind: "serp-report", channel: "blog", status: "approved", agent: "audit-runner--northbeam", scheduledFor: "2025-03-14", hue: 120 },
  { id: "post_n203", clientId: "cli_no02", title: "Thin practice-area pages: fix plan", summary: "Demo row — audit follow-up covering the 14 flagged pages, ordered by traffic.", kind: "audit", channel: "blog", status: "posted", agent: "audit-runner--northbeam", scheduledFor: "2025-03-03", postedAt: "4d ago", clicks: 88, impressions: 2_310, hue: 200 },
  { id: "post_n204", clientId: "cli_no02", title: "LinkedIn: 'the 5-minute will myth'", summary: "Demo row — repurposed from the estate-planning piece.", kind: "article", channel: "linkedin", status: "rejected", agent: "seo-writer--northbeam", scheduledFor: "2025-03-10", rejectedReason: "Demo row — rejected so you can see what that looks like.", hue: 0 },
  { id: "post_v301", clientId: "cli_ve03", title: "Retinol alternatives, ranked by evidence", summary: "Demo row — answer blocks, cited studies, entity coverage for eight actives.", kind: "article", channel: "blog", status: "ready", agent: "geo-optimizer--verdant", scheduledFor: "2025-03-06", hue: 60 },
  { id: "post_v302", clientId: "cli_ve03", title: "Answer block: 'is bakuchiol safe in pregnancy?'", summary: "Demo row — high-intent question with no authoritative answer indexed.", kind: "answer-block", channel: "blog", status: "pending", agent: "geo-optimizer--verdant", scheduledFor: "2025-03-11", hue: 250 },
  { id: "post_v303", clientId: "cli_ve03", title: "X thread: how AI engines cite skincare claims", summary: "Demo row — founder-voice thread linking the flagship article.", kind: "article", channel: "x", status: "approved", agent: "geo-optimizer--verdant", scheduledFor: "2025-03-18", hue: 300 },
  { id: "post_v304", clientId: "cli_ve03", title: "February citation report", summary: "Demo row — where Verdant shows up in AI answers against the top three competitors.", kind: "serp-report", channel: "blog", status: "posted", agent: "audit-runner--verdant", scheduledFor: "2025-03-02", postedAt: "5d ago", clicks: 54, impressions: 1_120, hue: 180 },
];

export const seoGeo: AgencyTemplate = {
  ...blank,
  name: "seo-geo",
  title: "SEO & GEO agency",
  description: VOCABULARY["seo-geo"].description,
  roadmap: { day_one: "Set up your site, pipeline and competitor gaps" },
  kinds: VOCABULARY["seo-geo"].kinds,
  words: { ...VOCABULARY["seo-geo"].words },
  seed: { clients, posts },
  questions: [
    {
      key: "public_identity",
      type: "text",
      label: "What public agency name, verified inbox, and pricing posture should the site use?",
      help: "Give all three. For example: Acme Search; hello@acme.com; custom-scoped after a fit call. No price or commercial term is inferred when omitted.",
      placeholder: "Agency name; verified email; custom-scoped or no public pricing.",
    },
    {
      key: "offer",
      type: "text",
      label: "What does your agency sell — SEO, GEO, content — and to whom?",
      help: questions[0]!.help,
      placeholder: "Technical SEO and AI-answer optimization for B2B software companies.",
    },
    questions[1]!,
    {
      key: "competitors",
      type: "text",
      label: "Which three competitors do your clients lose to in search?",
      help: "The gap researcher compares the site against these on day one and every Friday.",
      placeholder: "Three company names or domains.",
    },
    // No network question: the engine allows four, and these four are spent. sales asks for the
    // operator's network in its first session instead (`templates/agents.ts`).
  ],
  crew,
  // The seven are shared; only their focus and search skills are this template's. Every other field
  // — model, budget, allow-list, timers, intake — stays `blank`'s (`WORK` only appends to an intake
  // or timer), so a change there reaches both.
  agents: [
    // Built on the shared seven (`templates/agents.ts`), not on `blank`, which now runs the receptionist crew.
    ...roster.map((agent) => ({
      ...agent,
      system: `${agent.system} ${FOCUS[agent.name] ?? ""}`.trim(),
      ...(agent.intake ? { intake: { ...agent.intake, message: withWork(agent.name, agent.intake.message) } } : {}),
      ...(agent.schedules ? { schedules: agent.schedules.map((s) => ({ ...s, input: withWork(agent.name, s.input) })) } : {}),
      skills: [...(agent.skills ?? []), ...(SKILLS[agent.name] ?? [])],
      tools: {
        default_config: agent.tools?.default_config ?? { permission: "deny" as const },
        configs: {
          ...(agent.tools?.configs ?? {}),
          ...Object.fromEntries((AGENCY_SEARCH_READ[agent.name] ?? []).map((name) => [name, { enabled: true, permission: "allow" as const }])),
        },
      },
    })),
    paidMediaPlanner,
  ],
};
