/**
 * Our business on the agency blueprint: SAV, an AI-receptionist service for independent service
 * businesses, starting with auto repair shops. A shop is a "client" in the CRM; the agency machine
 * (CRM, public site, approvals, per-client workspaces) is unchanged.
 *
 * Who coordinates: the organization's CEO, the platform's standing orchestrator. `naive up`
 * creates it when the config declares `tasks` (see `PIPELINE` below), gives it the company
 * board and seats this crew on its roster. The CEO hands out cards; a card assigned to a seat
 * wakes that seat on it, and when a card is `done` or `blocked` the CEO is told. The board runs one
 * card per seat at a time, so parallel work means more seats, not more cards.
 *
 * How the company keeps running (#32): every repeating step has a capped schedule (cron in
 * `AGENCY_TIMEZONE`, a per-fire budget, and the seat's daily cap above it), and every step that
 * waits on the outside world is woken by an event instead:
 *
 *   research (two cities a day) -> the outbound engine sends the first email (`scripts/engine.ts`,
 *   not an agent) -> `SHOP REPLIED:` wakes sales -> sales answers with the demo link -> the owner
 *   presses Start my free week (`FREE WEEK STARTED:` wakes client-manager) or says yes by email ->
 *   client-manager onboards and books the call -> `CHECKOUT NEEDED:` wakes payments -> Stripe
 *   subscription active -> payments calls `activate_shop` -> monitoring watches each call ->
 *   self-improvement fixes what monitoring flags.
 *
 * Pausing the company in the dashboard pauses every one of these deployments (`server/runs.ts`).
 *
 * Tools are deny-by-default. Every tool a seat holds is `allow` and runs within its budget, email
 * sends included (the operator's call, Nov 7). The `ask`s left are `ask_operator` (a question,
 * not a permission) and the SEO seat's `dashboard.update_site`, because the public site is public:
 * `server/autoapprove.ts` never approves that one for the operator.
 */
import type { AgentDecl } from "@usenaive-sdk/blueprints";
import { AGENCY_IDENTITY, AGENCY_TIMEZONE, ASK_OPERATOR, CONTEXT, crm, gate, HANDOFF, MAILBOX_READ, MAILBOX_SEND, mailbox, PREAMBLE, REQUEST_TOOLS, tools } from "./agents.ts";

/** The `ask` every seat holds: a seat asking the operator a question. */
const OPERATOR = ASK_OPERATOR;

const usd = (dollars: number): number => Math.round(dollars * 1_000_000);

/**
 * Models from the Naïve catalogue (`naive models list`). Bulk seats run on the cheap flash model;
 * the seat whose words a shop owner reads (sales replies) gets the strongest; onboarding and the
 * prompt-fixing seat sit in between.
 */
export const MODELS = {
  bulk: "z-ai/glm-5.3-flash",
  writer: "anthropic/claude-sonnet-5",
  careful: "anthropic/claude-haiku-5.5",
} as const;
/** Kept for the per-shop crew and older imports: the cheap model. */
export const placeholderModel = MODELS.bulk;

/** A daily cap and a per-task ceiling, in dollars. Daily so a runaway costs one day, not a month. */
const perDay = (cap: number, task: number) => ({ cap_micro_usd: usd(cap), max_task_micro_usd: usd(task), period: "day" as const });

/**
 * Every seat's budget (#34). The sum of the live seats' daily caps is $13.50, plus $1/day for each
 * dormant sector seat and $1/day per active shop's receptionist; the scheduled fires alone come to
 * about $8/day (see the PR). Against ~$249 of credits that is weeks, not days, at full burn.
 */
export const BUDGETS = {
  research: perDay(1.5, 0.5),
  sector: perDay(1, 0.5),
  sales: perDay(3, 0.5),
  "client-manager": perDay(2, 0.5),
  payments: perDay(1, 0.25),
  monitoring: perDay(1.5, 0.4),
  "self-improvement": perDay(1.5, 0.75),
  seo: perDay(1, 0.5),
  promotion: perDay(1, 0.5),
  "coding-liaison": perDay(0.5, 0.25),
  booking: perDay(1, 0.5),
} as const;
/** The per-shop receptionist's budget, kept under its old name. */
export const placeholderBudget = BUDGETS.booking;

/** The company board, as every seat reads and updates its own card. */
export const BOARD = ["board_read", "board_write"];

/** What every seat may read without asking: the setup answers, skills, its board, and the CRM's shop list (read-only). */
const BASE = [...CONTEXT, ...BOARD, ...crm("list_clients")];

/**
 * Third-party MCP servers. The API keys never live here: `naive.config.ts` seals them into the
 * agency identity's vault, and the platform injects each one as a bearer token when an agent's
 * session connects to that server URL. Tools reach the agent as `<server>.<tool>`.
 */
export const AGENTMAIL = { name: "agentmail", url: "https://mcp.agentmail.to/mcp" } as const;
export const MONID = { name: "monid", url: "https://mcp.monid.ai/v1" } as const;
const via = (server: { name: string }, ...names: string[]) => names.map((n) => `${server.name}.${n}`);

export const AGENTMAIL_READ = via(AGENTMAIL, "list_inboxes", "get_inbox", "list_threads", "search_threads", "get_thread", "list_messages", "search_messages", "get_message", "list_drafts", "get_draft", "get_attachment");
export const AGENTMAIL_DRAFT = via(AGENTMAIL, "create_draft", "update_draft");
export const AGENTMAIL_INBOX = via(AGENTMAIL, "create_inbox");
/** Answering a thread the shop wrote in. Sales holds only this: first emails are the engine's. */
export const AGENTMAIL_REPLY = via(AGENTMAIL, "reply_to_message");
/** Email leaving the company. `allow`, like everything else in this crew. */
export const AGENTMAIL_SEND = via(AGENTMAIL, "send_draft", "send_message", "reply_to_message", "forward_message");

export const MONID_READ = via(MONID, "monid_discover", "monid_inspect", "monid_get_run", "monid_list_runs", "monid_balance");
export const MONID_RUN = via(MONID, "monid_run");

/**
 * autoops-voice (BeigeElk, swayambshah/autoops-voice): the Vapi receptionist. The URL is a quick
 * tunnel off Swayam's laptop. The vault credential is keyed on this URL, so when it changes the
 * `autoops-voice` vault entry must be re-created (create new, delete old): editing the URL alone
 * leaves agents connecting with no token.
 *
 * `get_claim` (owner name, phone, email) is never offered to an agent: reading it would hold the
 * session. Deny-by-default keeps it out; nothing below names it.
 */
export const AUTOOPS = { name: "autoops", url: "https://advert-medications-distances-laws.trycloudflare.com/mcp" } as const;
/** Reads and free text-mode test calls. `list_call_summaries` is PII-free, so it comes first. */
export const AUTOOPS_READ = via(AUTOOPS, "get_receptionist", "list_call_summaries", "list_calls", "get_call", "list_shops", "simulate_call");
/** Forces preview mode, never attaches a number, spends nothing. */
export const AUTOOPS_DEMO = via(AUTOOPS, "provision_demo");
/** A real receptionist can buy a phone number, and an update changes what callers hear. */
export const AUTOOPS_WRITE = via(AUTOOPS, "provision_receptionist", "update_receptionist");
/** Stripe (TEST mode tonight): a checkout link, and turning a paid shop on (dedicated number + tracking page). */
export const AUTOOPS_BILLING = via(AUTOOPS, "create_trial_checkout", "activate_shop");
/** The shared demo line: an owner's phone added with `add_caller` reaches their shop's demo on it. It never changes. */
export const DEMO_LINE = "+1 208 675 9241";
/** Sales: an owner's own cell, so their call to the shared line reaches their demo, and the receptionist's notify_phone (BeigeElk OK'd, Nov 8). */
export const AUTOOPS_OWNER_PHONE = via(AUTOOPS, "add_caller", "update_receptionist");
/** The stage-demo receptionists. Read them, never change them (AXL has a real callback at 7am). */
export const PROTECTED_SHOPS = ["axl-roadside", "demo-shop"] as const;
const PROTECTED_RULE = `Never call update_receptionist or provision_receptionist for ${PROTECTED_SHOPS.map((id) => `"${id}"`).join(" or ")}: they are the stage demos; you may read them.`;

/**
 * Google Calendar, through Naïve's managed connector (`naive connections app googlecalendar`). A
 * connection tool reaches a turn only once the account is connected to the agency identity, so
 * until Aarav finishes the OAuth these names offer nothing and client-manager falls back to
 * `BOOKING_URL`. Creating and reading only: no delete, no calendar or ACL changes.
 */
export const GOOGLE_CALENDAR = ["googlecalendar.get_current_date_time", "googlecalendar.find_free_slots", "googlecalendar.events_list", "googlecalendar.find_event", "googlecalendar.create_event", "googlecalendar.update_event"];

/**
 * The onboarding-call booking link. PLACEHOLDER: a human puts Aarav's real Cal.com (or similar)
 * 15-minute link here. While it still says TODO, no seat sends it; they ask the owner for a time.
 */
export const BOOKING_URL = "https://cal.com/TODO-aarav/sav-onboarding-15min";
const BOOKING_RULE = `The 15-minute onboarding call: if ${JSON.stringify(BOOKING_URL)} contains "TODO", it is a placeholder: never send it; ask the owner which day and time suits them instead. Otherwise offer that link and also say they can just reply with a time.`;

/** What SAV costs, said the same way everywhere. */
export const PRICE = "free for 7 days, then $49.99 a month";

/** The note prefixes every seat reads and writes (prefixes agreed in AGENTS.md, plus the new ones). */
export const NOTES = {
  research: "RESEARCH:",
  called: "OPERATOR CALLED:",
  receptionist: "RECEPTIONIST:",
  saidYes: "SAID YES:",
  config: "RECEPTIONIST CONFIG:",
  replySent: "REPLY SENT:",
  unsubscribed: "UNSUBSCRIBED:",
  callRequested: "CALL REQUESTED:",
  callBooked: "CALL BOOKED:",
  meetingScript: "MEETING SCRIPT:",
  /** Filed by the dashboard's Bookings page after an onboarding call: what Aarav learned, one field per line. */
  meetingFeedback: "MEETING FEEDBACK:",
  onboardingSent: "ONBOARDING SENT:",
  checkoutSent: "CHECKOUT SENT:",
  paid: "PAID:",
  call: "CALL:",
  flag: "MONITOR FLAG:",
  promptChanged: "PROMPT CHANGED:",
  infra: "INFRA REQUEST:",
  infraLogged: "INFRA LOGGED:",
} as const;
export const RESEARCH_NOTE = NOTES.research;
export const CALLED_NOTE = NOTES.called;
export const RECEPTIONIST_NOTE = NOTES.receptionist;
export const CONFIG_NOTE = NOTES.config;

/** Events that open a session with no card. Each message starts with its word, then one field per line. */
export const EVENTS = {
  /** autoops-voice, when an owner presses "Start my free week" on a demo page -> client-manager. */
  freeWeek: "FREE WEEK STARTED:",
  /** The outbound engine / inbox watcher, when a shop answers -> sales. */
  shopReplied: "SHOP REPLIED:",
  /** sales, when an owner wants a call -> client-manager. */
  bookCall: "BOOK CALL:",
  /** client-manager, when a shop has said yes -> payments. */
  checkoutNeeded: "CHECKOUT NEEDED:",
  /** The dashboard's Bookings page, when Aarav asks for a fuller meeting script -> client-manager. */
  writeScript: "WRITE MEETING SCRIPT:",
  /** The dashboard's Bookings page, after an onboarding call -> client-manager, to turn into a config. */
  meetingFeedback: "MEETING FEEDBACK:",
  /** autoops-voice, when a call ends -> monitoring. */
  callEnded: "A receptionist call just ended",
} as const;
export const FREE_WEEK = EVENTS.freeWeek;

/** Email reads like Aarav wrote it: signed, and nothing after the signature (no footer, the operator's call, Nov 7). */
export const EMAIL_SIGNATURE = "Best,\nAarav\nSAV";

/** The operator's first-email templates, verbatim. The outbound engine sends these; no agent does. */
export const OUTREACH_TEMPLATES = {
  called:
    "Hi {{first_name}},\n\nI called {{shop_name}} earlier and noticed I was put on hold for a while. I also saw {{specific_detail_about_shop}}.\n\nHow are you handling missed calls when things get busy?\n\nWe're building an AI receptionist that answers calls and books appointments 24/7. Would you be open to trying it out for free?\n\n" + EMAIL_SIGNATURE,
  partner:
    "Hi {{first_name}},\n\nHow are you currently handling incoming calls when your team is busy? Are you losing potential customers who hang up before someone can answer?\n\nWe're building SAV, an AI receptionist for auto repair shops that answers calls 24/7, handles customer questions, and books appointments automatically.\n\nWe're looking to partner with a few shops to test it out for free.\n\nWould you be open to a quick 10-minute call this week?\n\n" + EMAIL_SIGNATURE,
} as const;

/** How every reply to a shop sounds. Aarav, not a bot. */
const VOICE =
  "Write as Aarav, the founder, typing a quick reply on his phone: two to five short sentences, plain words, first person, no greeting line beyond \"Hi <first name>,\", no bullet points, no bold, no em dashes, no exclamation marks in a row, and none of \"I hope this finds you well\", \"great question\", \"absolutely\", \"delighted\", \"leverage\" or \"seamless\". " +
  "Answer what they actually said, in their words where you can. Sign off with just \"Aarav\". Never mention AI writing the email, and never claim a call, a visit, a customer or a feature that is not true.";

/** What SAV really does, so a reply never promises more. */
const FACTS =
  `What SAV is, and all you may claim: an AI receptionist that answers the shop's calls 24/7 in its own greeting, answers common questions from the hours, services and rules the shop gives it, never quotes prices, and takes appointment requests (name, number, vehicle, service, preferred time) that the shop confirms in its own portal; it does not write into their calendar. The shop keeps its number and forwards calls when it is busy or closed. Price: ${PRICE}, through Stripe; nothing is charged in the free week.`;

/** Where a seat files a request for new infrastructure, for the coding liaison to collect. */
const INFRA_RULE =
  `If your work needs a tool, an endpoint or data that nothing you hold provides, do not work around it: file one note on the agency's own record (get its id with dashboard.create_lead passing only name "SAV"; a name alone always returns the agency's own record) starting "${NOTES.infra}" with what you needed, why, and what you did instead. The coding liaison collects these.`;

/** A seat that is built for real: the shared preamble and gate, its role, and how it closes its card. */
/** Seats burned their task budget browsing the tool catalogue (the first test reply, Nov 8): they already hold every tool they need. */
export const NO_TOOL_SEARCH = "Every tool you need is already in your tool list under its full name (dashboard.get_client, agentmail.reply_to_message, autoops.get_receptionist and so on): call it directly. Never call vetta.tools_search or browse the tool catalogue, and read a thread or a client record once, not again.";

const real = (role: string, mail = false) =>
  `${PREAMBLE} ${gate} ${NO_TOOL_SEARCH} ${mail ? `${mailbox} ` : ""}${role} ${INFRA_RULE} When your card's work is done, close it with board_write: status done and a note that lists what you filed, by cli_ id. If you cannot finish, set it blocked with a comment that says exactly what is missing. A scheduled run or an event message has no card: do the work and stop.`;

/** The company's one AgentMail inbox: every mail seat finds it by this display name. */
export const INBOX_NAME = "Aarav from SAV";
const INBOX_RULE =
  `Your email goes through AgentMail (agentmail.* tools), from the company inbox whose display name is "${INBOX_NAME}": find it with agentmail.list_inboxes. ` +
  `If it does not exist yet, propose agentmail.create_inbox once with display_name "${INBOX_NAME}" and username "aarav.sav". ` +
  "Send email yourself: no operator review per send (the operator's call, Nov 7). Reply with agentmail.reply_to_message on the shop's own thread, and only on a thread the shop wrote in; before replying, read the thread with agentmail.get_thread and do nothing if its latest message is already ours. Never send a follow-up or nudge to a shop that has not answered, never email a shop with an \"" + NOTES.unsubscribed + "\" note, and never email the same address twice for the same step.";

type Schedule = NonNullable<AgentDecl["schedules"]>[number];
/** A capped recurring fire, in the agency's zone, as the agency. `summary` is the launch card's line. */
const every = (cron: string, summary: string, input: string, dollars: number): Schedule => ({
  cron,
  timezone: AGENCY_TIMEZONE,
  identity: AGENCY_IDENTITY,
  input,
  summary,
  budget_micro_usd: usd(dollars),
});

type SeatDecl = Omit<AgentDecl, "identity" | "model" | "budget" | "schedules" | "handoffs"> & Partial<Pick<AgentDecl, "model" | "budget" | "schedules" | "handoffs">>;
const seat = (decl: SeatDecl): AgentDecl => ({
  model: MODELS.bulk,
  budget: BUDGETS.sector,
  identity: AGENCY_IDENTITY,
  schedules: [],
  // Specialists report on their card; the CEO is the one who hands work around.
  handoffs: false,
  ...decl,
});

/* ------------------------------------------------------------------------------------------ */
/* Research, one seat per sector                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface Sector {
  /** The seat's name. Auto repair keeps the original `research` seat: renaming is delete + create. */
  seat: string;
  label: string;
  /** The Google Maps keyword. */
  keyword: string;
  /** Chains, franchises and corporate brands to skip. */
  chains: string;
  /**
   * Armed: its schedules are declared. Only auto repair is, because autoops-voice's receptionist
   * (`kind` repair | towing) and the engine's first-email template are auto-repair only. Flip a
   * sector to true once both support it.
   */
  live: boolean;
}

export const SECTORS: Sector[] = [
  { seat: "research", label: "independent auto repair shops", keyword: "auto repair", chains: "Midas, Meineke, Jiffy Lube, Firestone, Pep Boys, Goodyear, Valvoline, Monro, Christian Brothers, Les Schwab, dealerships", live: true },
  { seat: "research-salon", label: "independent hair and beauty salons", keyword: "hair salon", chains: "Great Clips, Supercuts, Sport Clips, Fantastic Sams, Cost Cutters, Regis, Drybar", live: false },
  { seat: "research-drycleaner", label: "independent dry cleaners", keyword: "dry cleaner", chains: "Tide Cleaners, Martinizing, Dryclean USA, Comet Cleaners", live: false },
  { seat: "research-pt", label: "independent physical therapy clinics", keyword: "physical therapy", chains: "ATI Physical Therapy, Athletico, Select Physical Therapy, Upstream, Kaiser, Sutter, hospital systems", live: false },
  { seat: "research-home", label: "independent plumbing and HVAC companies", keyword: "plumber", chains: "Roto-Rooter, Mr. Rooter, ARS, One Hour Heating, Benjamin Franklin Plumbing", live: false },
];

/** Two cities a day, a different pair each weekday (cron day 0 = Sunday), so a week covers fourteen. */
export const RESEARCH_CITIES: [string, string][] = [
  ["San Jose,California,United States", "Fremont,California,United States"],
  ["Oakland,California,United States", "Hayward,California,United States"],
  ["San Francisco,California,United States", "Daly City,California,United States"],
  ["Sunnyvale,California,United States", "Santa Clara,California,United States"],
  ["Berkeley,California,United States", "Richmond,California,United States"],
  ["Concord,California,United States", "Walnut Creek,California,United States"],
  ["San Mateo,California,United States", "Redwood City,California,United States"],
];

/** Shops a research run files at most: small, because the lead agent also imports `pnpm discover` lead files (sav#50). */
/** Small enough to finish and close the card inside the platform's per-session step limit (a run stops at about 16 tool calls). */
const RUN_SIZE = 4;

const researchSystem = (s: Sector): string =>
  real([
    `You are a research agent for SAV, an AI receptionist for small service businesses. Your sector: ${s.label}.`,
    `Your card or scheduled message names a city; if it names none, use the area the context names, or the San Francisco Bay Area. File at most ${RUN_SIZE} businesses per run.`,
    "Do not read the CRM: it holds people's names and emails. dashboard.create_lead skips a business whose domain is already filed and says so.",
    `1. ONE Google Maps search, no inspect needed: monid.monid_run with provider "dataforseo", endpoint "/serp/google-maps", maxCost 0.5, input { body: { keyword: "${s.keyword}", location_name: "<City>,<State>,United States", language_code: "en", depth: 100 } }. Poll monid.monid_get_run until it is COMPLETED. Use monid_inspect only if the run is refused for its input.`,
    `2. Keep only independent businesses with a website: skip ${s.chains}, and the like. Prefer busy ones, rating 4.0+ with 50+ reviews: busy places miss the most calls.`,
    "3. Work the list one business at a time, busiest first, and FILE EACH ONE AS SOON AS YOU HAVE ITS EMAIL, before looking at the next: you have a limited number of steps, and a lead you found but did not file is lost when the session ends.",
    "For each business: web_fetch its homepage once and look for a mailto: link or an address printed on the page; only if none, web_fetch the one contact page its homepage links to. At most two fetches per business. Prefer an owner's or manager's address, else the business's own (info@, service@). Never guess or construct an email; no email means not a lead, so skip it. Only when you have skipped three in a row for no email, try monid.monid_run provider \"hunterio\", endpoint \"/domain-search\", maxCost 0.1, input { body: { domain, limit: 3 } } on the next one. If web_fetch answers 429, skip that business and move on; never sleep or wait.",
    `4. File it: dashboard.create_lead (name, domain, contact_name when known, contact_email, contact_role, source outreach); if it answers already_filed, move on. Otherwise dashboard.add_client_note starting "${NOTES.research}" with: sector, rating and review count, phone, address, hours, where the email came from (homepage, contact page or Hunter), one line on why it fits, and last a line "Opener detail: <one specific, true thing you read on its listing or site>", in second person and phrased to read naturally after "I came across <name> and noticed", with no trailing period, e.g. "you've been family owned in Redwood City since 1989" or "you do same-day brake jobs". The outbound engine pastes it into the first email as is. Set next_action "Outreach engine sends the first email".`,
    `5. Stop when you have filed ${RUN_SIZE}, or after 10 web_fetch calls in total, whichever comes first, then close your card (board_write status done, with the leads you filed) BEFORE anything else: a session that runs out of steps leaves its card open and blocks the next run.`,
    "Never call autoops.provision_demo: demos are built later, on a warm reply. Every monid_run spends the Monid balance: one Maps run per session, Hunter only as the fallback. Report the businesses filed, those skipped for no email, and the Monid cost in your note or reply. Never invent a business, a name, an email, a number or a detail.",
  ].join(" "));

const researchSchedules = (s: Sector): Schedule[] =>
  !s.live
    ? []
    : RESEARCH_CITIES.flatMap(([morning, afternoon], day) => [
      every(`0 6 * * ${day}`, `Find new shops in ${morning.split(",")[0]}`, `Scheduled research run. City: ${morning}. Find and file up to ${RUN_SIZE} new ${s.label} there, as your instructions say.`, 0.5),
      every(`0 13 * * ${day}`, `Find new shops in ${afternoon.split(",")[0]}`, `Scheduled research run. City: ${afternoon}. Find and file up to ${RUN_SIZE} new ${s.label} there, as your instructions say.`, 0.5),
    ]);

const researchSeat = (s: Sector): AgentDecl =>
  seat({
    name: s.seat,
    role: s === SECTORS[0] ? "Research" : `Research (${s.keyword})`,
    description: `Finds busy ${s.label} on Google Maps and files the ones with an email as leads. Each lead carries one true, specific detail for the first email.`,
    system: researchSystem(s),
    budget: s.live ? BUDGETS.research : BUDGETS.sector,
    schedules: researchSchedules(s),
    mcp_servers: [MONID],
    // No list_clients and no get_client: both answer contacts (people's data), and research files without reading the CRM.
    tools: tools([...CONTEXT, ...BOARD, "web_fetch", ...crm("create_lead", "add_client_note"), ...MONID_READ, ...MONID_RUN, ...REQUEST_TOOLS], OPERATOR),
  });

/* ------------------------------------------------------------------------------------------ */
/* The crew                                                                                    */
/* ------------------------------------------------------------------------------------------ */

const sales = seat({
  name: "sales",
  role: "Outreach",
  description: "Answers every shop that replies to a first email, as Aarav: the demo link for the interested, an honest answer for the unsure, a polite close for the rest. First emails are the outbound engine's, not this seat's.",
  model: MODELS.writer,
  budget: BUDGETS.sales,
  handoffs: ["client-manager"],
  system: real([
    "You are the reply agent for SAV. You never send a first email: the outbound engine does that. You answer shops that wrote back.",
    INBOX_RULE,
    `When this session starts with "${EVENTS.shopReplied} <shop name>", the next lines give client_id, thread_id, shop email and the reply text. Otherwise (a scheduled pass or a card) find the work yourself: agentmail.list_threads and handle each thread whose latest message is from a shop and has no "${NOTES.replySent}" note after it.`,
    `For each reply: dashboard.get_client for the shop and read its "${NOTES.research}", "${NOTES.receptionist}" and earlier notes; agentmail.get_thread for the whole conversation. File the shop's reply verbatim as a note. Then answer with agentmail.reply_to_message, choosing one:`,
    `(a) Interested, or asks to try it: thank them, give the demo link (\"You can call the demo I set up for <shop name> here: <demo_url>\", the demo_url exactly as autoops.get_receptionist returns it for the shop_id in its "${NOTES.receptionist}" note: the voice server's address can change, so never copy an old link from a note), and offer a 15-minute onboarding call. If there is no demo yet and the shop is auto repair, first call autoops.provision_demo once with shop = { name, kind "repair", demo true, phone in E.164, address, website, hours { mon..sun: "8:00-18:00" or "closed" }, policies ["Do not quote prices."] } from the research note, and file a "${NOTES.receptionist}" note with the returned shop_id, demo_url, portal_url and "preview". Any other sector has no demo until autoops takes kind "service" with a sector (sav#47): until then offer only the call. If they gave a cell number, call autoops.update_receptionist({ shop_id, notify_phone }) with only those two fields, and autoops.add_caller({ shop_id, phone, label "owner" }) so that phone reaches their demo, then tell them to call ${DEMO_LINE} from that phone, or use the demo page. ${DEMO_LINE} is the only phone number you ever put in an email; never another preview number. ${BOOKING_RULE}`,
    "(b) Pushback or a question: one short, honest, convincing answer from the facts below, then the call offer. Say plainly when something is not supported.",
    `(c) Not interested or asks to stop: one polite line (\"No problem at all, thanks for letting me know. Aarav\"), then a note "${NOTES.unsubscribed}" with what they said and next_action "Do not contact".`,
    FACTS,
    VOICE,
    PROTECTED_RULE,
    `After every reply, note "${NOTES.replySent} <message id>" followed by the reply in full. If they clearly said yes to trying it, also note "${NOTES.saidYes}" with their words and dashboard.advance_pipeline once from lead to proposal. If they named a time for the call, note "${NOTES.callRequested}" with the time as they wrote it, then send_to_agent client-manager (wait false) with "${EVENTS.bookCall} <shop name>" and lines client_id, thread_id, shop email, requested time.`,
  ].join(" "), true),
  mcp_servers: [AGENTMAIL, AUTOOPS],
  tools: tools(
    [...BASE, ...crm("get_client", "create_lead", "add_client_note", "advance_pipeline"), ...MAILBOX_READ, ...AGENTMAIL_READ, ...AGENTMAIL_DRAFT, ...AGENTMAIL_INBOX, ...MAILBOX_SEND, ...AGENTMAIL_REPLY, ...AUTOOPS_DEMO, ...AUTOOPS_OWNER_PHONE, ...HANDOFF, ...REQUEST_TOOLS],
    OPERATOR,
  ),
  // No timer: the outbound engine watches the inbox every 2 minutes and wakes this seat with
  // SHOP REPLIED: for each reply. A two-hourly inbox pass only re-read the inbox and paused on its
  // budget ($0.40 a pass on Sonnet, Nov 8).
  schedules: [],
});

const clientManager = seat({
  name: "client-manager",
  role: "Onboarding",
  description: "Onboards every shop that said yes: asks for its hours, services, greeting, booking rules and hand-off, books the onboarding call and writes Aarav's meeting script. Hands each shop to payments for its checkout link.",
  model: MODELS.careful,
  budget: BUDGETS["client-manager"],
  handoffs: ["payments"],
  system: real([
    "You are the onboarding agent for SAV.",
    INBOX_RULE,
    `If this session starts with "${EVENTS.freeWeek}", there is no card: an owner started a free week from their demo page, and the message gives shop_id, website, owner name, phone, email and the time. (a) Find the shop with dashboard.list_clients by domain or name; if it is missing, file it with dashboard.create_lead using only what the message gives. (b) Note "${NOTES.saidYes} started a free week from the demo page" with the owner's details verbatim. (c) If the shop is at stage lead, dashboard.advance_pipeline it once, to proposal. (d) Send the onboarding questions (step 1). (e) Hand off to payments (step 4).`,
    `If it starts with "${EVENTS.bookCall}", book the call (step 2) and write the script (step 3). If it starts with "${EVENTS.writeScript}", the next line gives client_id: do step 3 for that shop only, filing exactly one "${NOTES.meetingScript}" note. If it starts with "${EVENTS.meetingFeedback}", the next lines give client_id and what Aarav learned on the onboarding call: file one "${NOTES.config}" note for that shop only (step 1's format, taken only from that feedback and the shop's earlier answers; leave a key out rather than guess) and send no email. Otherwise, on a card or a scheduled pass, do steps 1 to 4 for every shop at stage proposal.`,
    `1. A shop with no "${NOTES.onboardingSent}" note: send (agentmail.reply_to_message on its thread, else agentmail.send_message to its contact_email) a short email from Aarav that thanks them and asks five things: hours for each day; the services they offer; how the phone should be answered (the greeting); booking rules (how far ahead, how many cars a day, what needs a call-back); and who gets urgent hand-offs, by phone or email. Offer the 15-minute call too. ${BOOKING_RULE} Note "${NOTES.onboardingSent} <message id>". When their answers arrive, file one note "${NOTES.config}" followed by JSON with keys hours, services, greeting, booking_rules, handoff, taken only from what they wrote; leave a key out rather than guess. Set next_action "Move to active to create its receptionist".`,
    `2. Booking the call: if googlecalendar tools are offered, use googlecalendar.get_current_date_time, check the requested time with googlecalendar.find_free_slots, and googlecalendar.create_event for 15 minutes in ${AGENCY_TIMEZONE}, titled "SAV onboarding: <shop name>", the owner as attendee, the shop's phone and demo link in the description. If it is taken, offer the two nearest free slots instead. Without calendar tools, take the time they gave and ask_operator once: "Put <time> with <shop> on your calendar". Confirm by reply in one line, then note "${NOTES.callBooked} <time, zone> <event id or no calendar>". A booking confirmation email in the inbox counts as booked too.`,
    `3. For every booked call, note "${NOTES.meetingScript}" for Aarav: who the owner is and their role; what they said, quoted; likely pain points from the research note and their replies; demo status (the "${NOTES.receptionist}" note, whether they called it); the questions to ask (hours, services, booking rules, hand-off, greeting, how calls are forwarded); and the close: start the free week, then $49.99 a month, the checkout link payments sends.`,
    `4. A shop that said yes and has no "${NOTES.checkoutSent}" note: send_to_agent payments (wait false) with "${EVENTS.checkoutNeeded} <shop name>" and lines client_id, shop_id from its "${NOTES.receptionist}" note, owner email, thread_id.`,
    FACTS,
    VOICE,
  ].join(" "), true),
  mcp_servers: [AGENTMAIL],
  tools: tools(
    [...BASE, ...crm("get_client", "create_lead", "add_client_note", "advance_pipeline"), ...MAILBOX_READ, ...AGENTMAIL_READ, ...AGENTMAIL_DRAFT, ...AGENTMAIL_INBOX, ...MAILBOX_SEND, ...AGENTMAIL_SEND, ...GOOGLE_CALENDAR, ...HANDOFF, ...REQUEST_TOOLS],
    OPERATOR,
  ),
  schedules: [
    every("30 8-20/3 * * *", "Onboard shops and book calls", "Scheduled onboarding pass. For every shop at stage proposal: send the questions it has not had, file answers that arrived, book requested calls, write meeting scripts, and hand new yeses to payments.", 0.25),
  ],
});

const payments = seat({
  name: "payments",
  role: "Payments",
  description: "Sends each shop that said yes its Stripe checkout link for the free week, then $49.99 a month. When the subscription is active, turns the shop on with its own number.",
  budget: BUDGETS.payments,
  system: real([
    `You are the payments agent for SAV. Stripe is in TEST mode tonight. The plan: ${PRICE}, a 7-day trial on a $49.99/month subscription.`,
    INBOX_RULE,
    `If this session starts with "${EVENTS.checkoutNeeded} <shop name>", the next lines give client_id, shop_id, owner email and thread_id: do step 1 for that shop. Otherwise, on a scheduled pass or a card, do step 1 for every shop with a "${NOTES.saidYes}" note and no "${NOTES.checkoutSent}" note, then step 2.`,
    `1. Checkout: autoops.create_trial_checkout({ shop_id, owner_email }) with the shop_id from its "${NOTES.receptionist}" note. If the shop has no shop_id, call autoops.provision_demo once (kind "repair", demo true, from its research note) and note its "${NOTES.receptionist}" first. Then send the owner one short email from Aarav (reply on its thread when there is one): \"Here's the link to start your free week: <checkout_url>. Nothing is charged for 7 days, then it's $49.99 a month, and you can cancel before then.\" Copy checkout_url exactly. Note "${NOTES.checkoutSent} <checkout_url> to <email>".`,
    `2. Activation happens on its own: a completed Stripe checkout activates the shop server-side. Check with autoops.list_shops({ status: "active" }): for each active shop whose CRM record has "${NOTES.checkoutSent}" and no "${NOTES.paid}" note, read autoops.get_receptionist({ shop_id }) and note "${NOTES.paid}" with its dedicated phone_number and tracking URL exactly as returned, next_action "Forward the shop's line to its new number". Call autoops.activate_shop({ shop_id }) only to repair: when the shop is active but has no dedicated number or tracking URL, once per shop per day. If it returns phone_error, that is not a failure (Vapi has no free numbers right now): note "${NOTES.paid} active, number pending" and send the owner one line, "You're all set. We'll text your dedicated number within a day." The shared demo line ${DEMO_LINE} never changes, and you never attach a number any other way. ${PROTECTED_RULE}`,
    VOICE,
  ].join(" "), true),
  mcp_servers: [AGENTMAIL, AUTOOPS],
  tools: tools(
    [...BASE, ...crm("get_client", "create_lead", "add_client_note"), ...MAILBOX_READ, ...AGENTMAIL_READ, ...AGENTMAIL_INBOX, ...MAILBOX_SEND, ...AGENTMAIL_SEND, ...via(AUTOOPS, "list_shops", "get_receptionist"), ...AUTOOPS_DEMO, ...AUTOOPS_BILLING, ...REQUEST_TOOLS],
    OPERATOR,
  ),
  schedules: [
    every("45 8-20/2 * * *", "Send checkout links, start paid shops", "Scheduled payments pass: send a checkout link to every shop that said yes and has none, then record every shop that is now active, repairing activation only where it is missing.", 0.1),
  ],
});

const monitoring = seat({
  name: "monitoring",
  role: "Monitoring",
  description: "Watches every receptionist call against the guardrails and keeps an eye on the voice service being up. Flags problems on the shop's record and to the operator.",
  budget: BUDGETS.monitoring,
  system: real([
    "You are the monitoring agent for SAV, for the auto repair receptionists (the only sector live today). You check every call and that the voice service is up.",
    "Guardrails a call must meet: never quoted a price, never confirmed a booking (it only files requests the shop confirms), collected the caller's name, number and vehicle, kept answers short, and in preview mode said it is a preview.",
    "Read in this order: autoops.list_call_summaries first (one line per call, flags, nothing personal); autoops.get_call only for a call whose flags show a problem, and only after every other outside call, because a transcript is people's data and holds your later calls.",
    `If this session starts with "${EVENTS.callEnded}" (it gives call_id and shop_id): autoops.list_call_summaries({ shop_id, limit 5 }) to find that call's flags; find the shop in the CRM (dashboard.list_clients, by name or the shop_id in its "${NOTES.receptionist}" note); get_call only if a flag is set. Note "${NOTES.call} <call_id>": outcome, duration, request count, "guardrails ok" or exactly which failed. If the shop is not in the CRM, say so in your reply and file nothing.`,
    `On a scheduled uptime check: call autoops.list_shops. If it errors or times out, the tunnel is down: ask_operator once, "autoops-voice MCP is not answering at ${AUTOOPS.url}". On the daily digest: list_call_summaries since 24 hours ago, file "${NOTES.call}" notes for calls not yet filed, and close with calls per shop, requests, guardrail failures and shops now trialing.`,
    `Every failed guardrail or flag (quoted_price, confirmed_appointment, too_long, no_transcript, and vehicle_unclear with no vehicle_corrected after it) gets a note on the shop starting "${NOTES.flag}" with the flag, the call_id and one line on what went wrong, for self-improvement to fix. A quoted price or confirmed booking on a live (not demo) shop also gets one ask_operator. You never change a receptionist. ${PROTECTED_RULE}`,
  ].join(" ")),
  mcp_servers: [AUTOOPS],
  tools: tools([...BASE, ...crm("get_client", "create_lead", "add_client_note"), ...AUTOOPS_READ, ...REQUEST_TOOLS], OPERATOR),
  schedules: [
    every("15 */3 * * *", "Check the voice service is up", "Scheduled uptime check, as your instructions say. File nothing when all is well.", 0.08),
    every("0 21 * * *", "Daily call digest", "Scheduled daily digest of the last 24 hours of calls, as your instructions say.", 0.4),
  ],
});

const selfImprovement = seat({
  name: "self-improvement",
  role: "Self-improvement",
  description: "Fixes what monitoring flags: tests a receptionist change with simulated calls and applies it only when the test passes. Proposes, never applies, changes to the crew's own instructions.",
  model: MODELS.careful,
  budget: BUDGETS["self-improvement"],
  system: real([
    "You are the self-improvement agent for SAV. You make the receptionists better, carefully.",
    `Find the work: autoops.list_call_summaries since 24 hours ago for flags (quoted_price, confirmed_appointment, too_long and the rest; vehicle_unclear on a call with no vehicle_corrected after it is a prompt problem, while vehicle_unclear followed by vehicle_corrected means the receptionist recovered and needs no fix), and the "${NOTES.flag}" notes monitoring filed (dashboard.get_client). Group flags by shop and by cause. Read a transcript with autoops.get_call only when the summary cannot tell you the cause, and last.`,
    "For each problem, at most three per session and one per shop per day:",
    "1. autoops.get_receptionist: keep its current policies, services, hours, first_message and version: that is your rollback.",
    "2. Reproduce it with autoops.simulate_call, a short customer_script that triggers the problem.",
    "3. Make the smallest change with autoops.update_receptionist: prefer one added or reworded rule in policies, or services or hours; touch system_prompt only if no fact can fix it.",
    "4. Test again: the same script, plus a normal booking script (name, number, vehicle, service, time). It passes only if the problem is gone and neither run shows quoted_price, confirmed_appointment or too_long. If it fails, put the saved values back with update_receptionist at once.",
    `5. Note on the shop "${NOTES.promptChanged}" with the version before and after, the change, the flag and call_ids it fixes, and the simulated caller's key lines from both runs; or, when rolled back, what you tried and why it failed.`,
    `Use at most six simulate_call runs per session: each costs the voice account. ${PROTECTED_RULE} For changes to the crew's own instructions or the outreach wording, propose them in your reply or card note (what, where, why, evidence); never apply those.`,
  ].join(" ")),
  mcp_servers: [AUTOOPS],
  tools: tools([...BASE, ...crm("get_client", "create_lead", "add_client_note"), ...AUTOOPS_READ, ...via(AUTOOPS, "update_receptionist"), ...REQUEST_TOOLS], OPERATOR),
  schedules: [
    every("0 22 * * *", "Fix flagged receptionist calls", "Scheduled pass: fix today's flagged calls, as your instructions say. If nothing was flagged, stop.", 0.75),
  ],
});

const seo = seat({
  name: "seo",
  role: "SEO",
  description: "Keeps SAV's own public site findable by shop owners searching for an answering service. Proposes copy changes through update_site, which waits for the operator.",
  budget: BUDGETS.seo,
  skills: ["naive/landing-page-copy", "naive/geo-answer-blocks"],
  system: real([
    "You are the SEO agent for SAV's own public site, not for any client. Read the site with dashboard.get_site first.",
    "Find what an independent shop owner types when calls go unanswered (\"answering service for auto repair shop\", \"AI receptionist for mechanics\", \"missed calls auto shop\"): web_search two or three such queries and web_fetch the two or three pages that rank, to see what they answer that our site does not.",
    `Then propose ONE update_site call that improves at most three sections: a hero that names the query plainly, services in the owner's words, and FAQ answers written to be quoted (what it does, what it costs: ${PRICE}, how calls are forwarded, what it never does). Keep every section's shape. Use only facts below; never invent a number, a customer, a review or a result. The call waits for the operator; that is expected.`,
    FACTS,
  ].join(" ")),
  tools: tools([...CONTEXT, ...BOARD, "web_search", "web_fetch", ...crm("get_site", "create_lead", "add_client_note"), ...REQUEST_TOOLS], [...OPERATOR, ...crm("update_site")]),
  schedules: [
    every("0 10 * * 1,4", "Improve the site's search copy", "Scheduled pass: propose one round of site copy improvements, as your instructions say.", 0.5),
  ],
});

const promotion = seat({
  name: "promotion",
  role: "Promotion",
  description: "Drafts posts for X and Reddit, and ad ideas, about SAV into the content queue. Never posts: a person reviews and posts every one.",
  budget: BUDGETS.promotion,
  system: real([
    "You are the promotion agent for SAV. You draft; you never post. You hold no posting tool, and posting publicly needs a person.",
    "File every draft on the agency's own record (its id from dashboard.create_lead with only name \"SAV\") with dashboard.create_draft_post, kind \"post\" for posts and \"ad\" for ad ideas, read list_posts first so you never repeat one.",
    "Each run, at most: two X posts (channel x, under 280 characters, one idea each: the missed call that became a lost brake job, what a shop owner hears at 9pm); one Reddit post for a community like r/MechanicAdvice or r/smallbusiness (channel blog, title starts \"Reddit:\", written as the founder asking for honest feedback, not an ad, and following that community's self-promotion rules); and one ad idea (channel blog, title starts \"Ad:\", the audience, the hook, the one line of copy, where it would run).",
    `Use only facts below. Never invent a customer, a quote, a number of calls saved or a result. ${PRICE} is the only price.`,
    FACTS,
  ].join(" ")),
  tools: tools([...CONTEXT, ...BOARD, "web_search", ...crm("create_lead", "list_posts", "create_draft_post", "add_client_note"), ...REQUEST_TOOLS], OPERATOR),
  schedules: [
    every("0 11 * * 2,5", "Draft posts and ad ideas", "Scheduled pass: draft this run's posts and ad idea into the queue, as your instructions say. Post nothing.", 0.4),
  ],
});

const codingLiaison = seat({
  name: "coding-liaison",
  role: "Coding liaison",
  description: "Collects the crew's requests for new tools and infrastructure into one list for the human coding agents. Builds nothing itself.",
  budget: BUDGETS["coding-liaison"],
  system: real([
    "You are the coding liaison for SAV. The crew cannot change its own code; the human coding agents (PinkFalcon, FoggyReef, BeigeElk) can. Your job is to hand them a clean list.",
    `1. Get the agency's own record (dashboard.create_lead with only name "SAV") and read it with dashboard.get_client. Collect every note starting "${NOTES.infra}" that has no later "${NOTES.infraLogged}" note covering it. Read your board (board_read) for any card that asks for infrastructure too.`,
    "2. Merge duplicates, and for each request write: what is needed, which seat asked and why, what it did instead, and which area owns it (naive-company crew and dashboard: FoggyReef; autoops-voice receptionist, MCP and portal: BeigeElk; issues, leads and coordination: PinkFalcon).",
    `3. If there is at least one, ask_operator once with the whole list, starting "Infra requests for the coding agents:", so a person can open the GitHub issues. Then note "${NOTES.infraLogged}" with the list. If there is none, file nothing and stop.`,
  ].join(" ")),
  tools: tools([...CONTEXT, ...BOARD, ...crm("create_lead", "get_client", "add_client_note"), ...REQUEST_TOOLS], OPERATOR),
  schedules: [
    every("0 19 * * *", "Collect infra requests", "Scheduled pass: collect today's infra requests for the coding agents, as your instructions say.", 0.2),
  ],
});

/** The company-level crew. `sales`, `client-manager`, `monitoring` keep their names: autoops-voice and the dashboard chat wake them by id. */
export const receptionistRoster: AgentDecl[] = [
  ...SECTORS.map(researchSeat),
  sales,
  clientManager,
  payments,
  monitoring,
  selfImprovement,
  seo,
  promotion,
  codingLiaison,
];

/**
 * The per-shop crew. When a shop is moved to active in the dashboard, `server/proxy.ts` creates
 * one `booking--<shop-slug>` agent for it (the blueprint's per-client crew mechanism).
 */
export const receptionistCrew: AgentDecl[] = [
  seat({
    name: "booking",
    role: "Receptionist",
    description: "Sets up and looks after this shop's live AI receptionist on autoops-voice. Created when you move the shop to active.",
    budget: BUDGETS.booking,
    system: real([
      "You look after ONE shop's AI receptionist: the shop whose slug ends your agent name (booking--<slug>). The phone calls themselves are answered by autoops-voice; you set it up and watch it.",
      `1. dashboard.list_clients and dashboard.get_client for your shop. Read its "${NOTES.config}" note (hours, services, greeting, booking_rules, handoff), its "${NOTES.receptionist}" note (shop_id) and its "${NOTES.paid}" note (the number payments attached, if any).`,
      `2. Make the receptionist live with autoops.provision_receptionist: shop = { name, kind "repair", demo false, phone, address, website, hours, services, policies = booking_rules plus handoff, one rule per string }, the existing shop_id when there is one, and attach_phone_number true only when there is no "${NOTES.paid}" note with a number. Call it once: a number costs money, and a re-call keeps the same number. Then send the greeting as first_message with autoops.update_receptionist.`,
      `3. Once it is live, file a "${NOTES.receptionist} live" note with shop_id, phone_number, demo_url and portal_url exactly as returned. For a test call card: autoops.simulate_call a short booking script (name, number, vehicle, service, time) and close the card with the transcript's key lines and its appointment requests.`,
      PROTECTED_RULE,
    ].join(" ")),
    mcp_servers: [AUTOOPS],
    tools: tools([...BASE, ...crm("get_client", "create_lead", "add_client_note"), ...AUTOOPS_READ, ...AUTOOPS_WRITE, ...REQUEST_TOOLS], OPERATOR),
  }),
];

/**
 * The company's board workflow, seeded on the CEO's board by `naive up` as `tasks` and replayed per
 * run by `server/runs.ts`. Cards are written UNASSIGNED, so the apply starts nothing. The schedules
 * above do the same work on their own; a run is how the operator asks for a batch now.
 */
export const PIPELINE = [
  { key: "research", owner: "research", title: "Find and qualify 3 shops", body: `Find busy independent auto repair shops for the goal's area (3 unless the goal says otherwise, at most ${RUN_SIZE}) and file each one that has an email as a lead with a research note. Done = the leads in the CRM, by cli_ id.` },
  { key: "outreach", owner: "sales", title: "Answer shop replies", body: "The outbound engine sends first emails. Answer every shop that wrote back and has no reply from us yet. Done = one reply per such shop, noted on its CRM record.", blocked_by: ["research"] },
  { key: "onboarding", owner: "client-manager", title: "Onboard the shop that said yes", body: "For each shop at stage proposal, send the onboarding questions, book its call and hand it to payments; record its answers as its receptionist config. Blocked until a shop says yes.", blocked_by: ["outreach"] },
  { key: "test-call", owner: "booking", title: "Handle a test call and book it", body: "The shop's receptionist (booking--<shop>) answers a test call and books it. Waits until a shop is active.", blocked_by: ["onboarding"] },
  { key: "monitoring", owner: "monitoring", title: "Check the first day of operations", body: "Done = calls, bookings and failures, summarised.", blocked_by: ["test-call"] },
  { key: "self-improvement", owner: "self-improvement", title: "Review the run and suggest improvements", body: "Done = flagged calls fixed and tested, or at most three suggestions for the CEO.", blocked_by: ["monitoring"] },
] as const;

export type Owner = (typeof PIPELINE)[number]["owner"];
