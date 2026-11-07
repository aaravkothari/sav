/**
 * Our business on the agency blueprint: an AI-receptionist service for independent auto repair
 * shops. A shop is a "client" in the CRM; the agency machine (CRM, public site, approvals,
 * per-client workspaces) is unchanged.
 *
 * Who coordinates: the organization's CEO — the platform's standing orchestrator. `naive up`
 * creates it when the config declares `tasks` (see `PIPELINE` below), gives it the company
 * board and seats this crew on its roster. The CEO hands out cards; a card assigned to a seat
 * wakes that seat on it, and when a card is `done` or `blocked` the CEO is told.
 *
 * FOR NOW EVERY SEAT IS A PLACEHOLDER: no intake, no schedules (so `naive up` starts no work and
 * spends nothing on its own), a cheap model, a small budget, and a prompt that says to return a
 * MOCK result on its card. Tools are deny-by-default; anything that reaches outside the company
 * (email, web search/fetch, paid data) is `ask`, so it lands on Approvals before it can run.
 *
 * `templates/agents.ts` stays as the blueprint ships it: `seo-geo` still builds on it.
 */
import type { AgentDecl } from "@usenaive-sdk/blueprints";
import { AGENCY_IDENTITY, CONTEXT, crm, gate, MAILBOX_READ, MAILBOX_SEND, mailbox, OPERATOR, PREAMBLE, tools } from "./agents.ts";

/** Cheap model from the Naïve quickstart, for placeholder seats. Upgrade per seat as it goes real. */
export const placeholderModel = "z-ai/glm-5.3-flash";

/** Placeholder budget per seat: $5 a month, $0.50 a task. Set real numbers before `naive up`. */
export const placeholderBudget = { cap_micro_usd: 5_000_000, max_task_micro_usd: 500_000, period: "month" } as const;

/** The company board, as every seat reads and updates its own card. */
export const BOARD = ["board_read", "board_write"];

/** What every seat may read without asking: the setup answers, skills, its board, and the CRM's shop list (read-only). */
const BASE = [...CONTEXT, ...BOARD, ...crm("list_clients")];

/**
 * Third-party MCP servers. The API keys never live here: `naive.config.ts` seals them into the
 * agency identity's vault (`AGENTMAIL_API_KEY`, `MONID_API_KEY` from `.env`), and the platform
 * injects each one as a bearer token when an agent's session connects to that server URL.
 * Tools reach the agent as `<server>.<tool>`; deny-by-default means each one is named below.
 */
export const AGENTMAIL = { name: "agentmail", url: "https://mcp.agentmail.to/mcp" } as const;
export const MONID = { name: "monid", url: "https://mcp.monid.ai/v1" } as const;
const via = (server: { name: string }, ...names: string[]) => names.map((n) => `${server.name}.${n}`);

/** AgentMail: read the inboxes freely. Drafting, sending, replying and creating an inbox wait for you. Deleting is not offered. */
export const AGENTMAIL_READ = via(AGENTMAIL, "list_inboxes", "get_inbox", "list_threads", "search_threads", "get_thread", "list_messages", "search_messages", "get_message", "list_drafts", "get_draft", "get_attachment");
/** Writing a draft changes nothing outside the inbox: the operator reviews it and is the one who sends. */
export const AGENTMAIL_DRAFT = via(AGENTMAIL, "create_draft", "update_draft");
export const AGENTMAIL_ASK = via(AGENTMAIL, "send_draft", "send_message", "reply_to_message", "forward_message", "create_inbox");

/** Monid: searching the catalogue and reading runs is free. A run spends the Monid balance, so it waits for you. Top-ups, promo codes, disputes and releases are not offered. */
export const MONID_READ = via(MONID, "monid_discover", "monid_inspect", "monid_get_run", "monid_list_runs", "monid_balance");
export const MONID_ASK = via(MONID, "monid_run");

/**
 * How outreach email reads. Personal, one-to-one, in the founder's voice. `EMAIL_FOOTER` is the
 * opt-out line and postal address US law (CAN-SPAM) requires on commercial email: until it is set,
 * outreach only drafts, and the operator adds it before approving any send.
 */
export const EMAIL_SIGNATURE = "Best,\nAarav\nSAV";
export const EMAIL_FOOTER = "";

/** The operator's own templates, verbatim. `{{…}}` is filled from the shop's CRM record and research note. */
export const OUTREACH_TEMPLATES = {
  called:
    "Hi {{first_name}},\n\nI called {{shop_name}} earlier and noticed I was put on hold for a while. I also saw {{specific_detail_about_shop}}.\n\nHow are you handling missed calls when things get busy?\n\nWe're building an AI receptionist that answers calls and books appointments 24/7. Would you be open to trying it out for free?\n\n" + EMAIL_SIGNATURE,
  partner:
    "Hi {{first_name}},\n\nHow are you currently handling incoming calls when your team is busy? Are you losing potential customers who hang up before someone can answer?\n\nWe're building SAV, an AI receptionist for auto repair shops that answers calls 24/7, handles customer questions, and books appointments automatically.\n\nWe're looking to partner with a few shops to test it out for free.\n\nWould you be open to a quick 10-minute call this week?\n\n" + EMAIL_SIGNATURE,
} as const;

/** The research note's first word, so every later seat can find what research filed. */
export const RESEARCH_NOTE = "RESEARCH:";
/** A note the operator writes after really calling a shop; only then may the "I called" opener be used. */
export const CALLED_NOTE = "OPERATOR CALLED:";
/** Where onboarding records the shop's receptionist setup, for the receptionist seat to read. */
export const CONFIG_NOTE = "RECEPTIONIST CONFIG:";

const PLACEHOLDER =
  "PLACEHOLDER SEAT — this capability is not built yet. Do not call any external service and do not write to the CRM. " +
  "Read your card with board_read, then close it with board_write: status done and a note that starts with MOCK: and describes, in one or two lines, what you would have produced.";

const system = (role: string) => `${PREAMBLE} ${gate} ${role} ${PLACEHOLDER}`;
/** A seat that is built for real: the shared preamble and gate, its role, and how it closes its card. */
const real = (role: string, mail = false) =>
  `${PREAMBLE} ${gate} ${mail ? `${mailbox} ` : ""}${role} When your card's work is done, close it with board_write: status done and a note that lists what you filed, by cli_ id. If you cannot finish, set it blocked with a comment that says exactly what is missing.`;

/** The company's one AgentMail inbox: outreach creates it once; every mail seat finds it by this display name. */
export const INBOX_NAME = "Aarav from SAV";
const INBOX_RULE =
  `Your email goes through AgentMail (agentmail.* tools), from the company inbox whose display name is "${INBOX_NAME}": find it with agentmail.list_inboxes. ` +
  `If it does not exist yet, propose agentmail.create_inbox once with display_name "${INBOX_NAME}" and username "aarav.sav" (it waits for the operator). ` +
  "Write every email as an AgentMail draft (agentmail.create_draft): drafts are reviewed by the operator, who sends them. Never call send_message, send_draft, reply_to_message or forward_message unless your card explicitly says the operator asked you to send.";

const seat = (decl: Omit<AgentDecl, "model" | "budget" | "identity" | "schedules" | "handoffs">): AgentDecl => ({
  model: placeholderModel,
  budget: placeholderBudget,
  identity: AGENCY_IDENTITY,
  schedules: [],
  // Specialists report on their card; the CEO is the one who hands work around.
  handoffs: false,
  ...decl,
});

/** The company-level crew. `sales` and `client-manager` keep the blueprint's names: the dashboard chat is wired to `client-manager`. */
export const receptionistRoster: AgentDecl[] = [
  seat({
    name: "research",
    role: "Research",
    description: "Finds busy independent auto repair shops on Google Maps and files them as qualified leads. Every paid data lookup waits for your approval.",
    system: real([
      "You are the research agent for SAV, an AI receptionist for independent auto repair shops.",
      "Your card says how many shops to find and where; if it does not, find 3 in the area the context names, or the San Francisco Bay Area when it names none.",
      "1. Read the CRM with dashboard.list_clients first, so you never file a shop that is already there.",
      "2. Find candidates with Monid. Run monid.monid_inspect on provider dataforseo, endpoint /serp/google-maps, then ONE monid.monid_run with keyword \"auto repair\", the city as location_name (e.g. \"San Francisco,California,United States\"), language_code \"en\" and depth 100. Read the results with monid.monid_get_run.",
      "3. Keep only independent shops: skip chains, franchises and dealerships (Midas, Meineke, Jiffy Lube, Firestone, Pep Boys, Goodyear, Valvoline and the like) and anything without a website. Prefer busy shops, rating 4.0 or more with 50 or more reviews: busy shops miss the most calls.",
      "4. For each shop you keep, run monid.monid_inspect once on provider hunterio, endpoint /domain-search, then one monid.monid_run per shop domain with limit 3, to find the owner's or manager's first name and email. Prefer an owner, manager or the shop's own address; never guess or construct an email, and file the shop without one when none is found.",
      `5. File each shop with dashboard.create_lead (name, domain, contact_name, contact_email when found, contact_role, source outreach). Then dashboard.add_client_note on it, starting with "${RESEARCH_NOTE}": rating and review count, phone, address, hours, one line on why it fits, and one specific detail you actually read in its listing that an opener could mention. Set next_action to "Draft opener".`,
      "Every monid_run spends the Monid balance and waits for the operator's approval: propose it and wait. Keep each run small, one keyword or one domain per run. Report the total Monid cost in your card's note. Never invent a shop, a name, an email, a number or a detail.",
    ].join(" ")),
    mcp_servers: [MONID],
    tools: tools([...BASE, ...crm("get_client", "create_lead", "add_client_note"), ...MONID_READ], [...MONID_ASK, ...OPERATOR]),
  }),
  seat({
    name: "sales",
    role: "Outreach",
    description: "Drafts a personal email to each qualified shop from the company's AgentMail inbox, and files replies. Nothing is sent without you.",
    system: real([
      "You are the outreach agent for SAV. You write to the shops research filed, as Aarav, the founder: a short, personal one-to-one email, never a marketing blast.",
      INBOX_RULE,
      `1. dashboard.list_clients, then dashboard.get_client for every lead whose notes hold a "${RESEARCH_NOTE}" note and that has a contact_email and no "OUTREACH DRAFTED" note yet.`,
      `2. Pick the template. Use the "called" template ONLY when the shop's notes hold an "${CALLED_NOTE}" note from the operator, and use what that note says; otherwise use the "partner" template, or a shorter version of it that keeps its words and adds one personal line. Never claim a call, a hold, a visit or anything else that did not happen.`,
      `Template "called": ${JSON.stringify(OUTREACH_TEMPLATES.called)}`,
      `Template "partner": ${JSON.stringify(OUTREACH_TEMPLATES.partner)}`,
      "Fill {{first_name}} from the contact name (use \"there\" when none is known), {{shop_name}} from the client name, and {{specific_detail_about_shop}} only from the detail in the research note. The subject is short and plain, like a person would write: e.g. \"Missed calls at <shop name>\".",
      EMAIL_FOOTER ? `End every email with this footer, verbatim: ${JSON.stringify(EMAIL_FOOTER)}` : "There is no footer yet: the operator adds the opt-out line and postal address before sending.",
      "3. Create one agentmail.create_draft per shop, to its contact_email. Then dashboard.add_client_note on that shop: \"OUTREACH DRAFTED: <draft id> to <email>\" followed by the email in full, with next_action \"Review and send the opener\".",
      "4. Replies: read the inbox (agentmail.list_threads, agentmail.get_thread). File each reply verbatim as a note on its shop. When a shop says yes, add a note \"SAID YES:\" with what they said and set next_action \"Move to proposal to start onboarding\".",
    ].join(" "), true),
    mcp_servers: [AGENTMAIL],
    tools: tools(
      [...BASE, ...crm("get_client", "add_client_note"), ...MAILBOX_READ, ...AGENTMAIL_READ, ...AGENTMAIL_DRAFT],
      [...MAILBOX_SEND, ...AGENTMAIL_ASK, ...OPERATOR],
    ),
  }),
  seat({
    name: "client-manager",
    role: "Onboarding",
    description: "Onboards a shop that said yes: drafts the setup questions, then records its hours, services, greeting and booking rules for its receptionist.",
    system: real([
      "You are the onboarding agent for SAV. A shop is ready to onboard when the operator has moved it to the proposal stage (it said yes).",
      INBOX_RULE,
      "1. dashboard.list_clients and dashboard.get_client for every shop at stage proposal. If there is none, set your card blocked with the comment \"Waiting for a shop to say yes: move it to proposal on the CRM, then reassign this card.\" and stop.",
      "2. For each such shop with no \"ONBOARDING SENT\" note: draft (agentmail.create_draft, to its contact) a short, friendly email from Aarav that thanks them and asks the six things its receptionist needs: business hours for each day; the services they offer with typical duration and price range; how they want the phone answered (the greeting); booking rules (how far ahead, how many cars per slot, which services need a call-back); a number or email for urgent hand-offs; and the shop's calendar or how they track appointments today. Sign it " + JSON.stringify(EMAIL_SIGNATURE) + ". Then add the note \"ONBOARDING SENT: <draft id>\" with next_action \"Review and send the onboarding questions\".",
      `3. When the shop's answers arrive in the inbox, file them as one note that starts with "${CONFIG_NOTE}" followed by JSON with keys hours, services, greeting, booking_rules, handoff, calendar, taken only from what the shop wrote; leave a key out rather than guess. Set next_action \"Move to active to create its receptionist\".`,
    ].join(" "), true),
    mcp_servers: [AGENTMAIL],
    tools: tools(
      [...BASE, ...crm("get_client", "add_client_note"), ...MAILBOX_READ, ...AGENTMAIL_READ, ...AGENTMAIL_DRAFT],
      [...MAILBOX_SEND, ...AGENTMAIL_ASK, ...OPERATOR],
    ),
  }),
  seat({
    name: "monitoring",
    role: "Monitoring",
    description: "Watches every shop's calls, bookings and failures, and flags anything off.",
    system: system("You are the monitoring agent: review each live shop's calls answered, bookings made and failures, and flag anything that needs the operator."),
    tools: tools(BASE, OPERATOR),
  }),
  seat({
    name: "self-improvement",
    role: "Self-improvement",
    description: "Reviews finished work and proposes concrete changes to prompts and process. Never applies them.",
    system: system("You are the self-improvement agent: review what the crew finished and propose at most three concrete changes to prompts or process, for the CEO and the operator to decide on."),
    tools: tools(BASE, OPERATOR),
  }),
];

/**
 * The per-shop crew. When a shop is moved to active in the dashboard, `server/proxy.ts` creates
 * one `booking--<shop-slug>` agent for it (the blueprint's per-client crew mechanism).
 */
export const receptionistCrew: AgentDecl[] = [
  seat({
    name: "booking",
    role: "Receptionist",
    description: "This shop's AI receptionist: answers its calls and books appointments.",
    system: system("You are this shop's receptionist: answer its callers and book appointments within its hours and services."),
    tools: tools(BASE, OPERATOR),
  }),
];

/**
 * The company's first workflow, seeded on the CEO's board by `naive up` as `tasks`. Cards are
 * written UNASSIGNED, so the apply starts nothing; the CEO assigns each to its `owner` when asked
 * (`pnpm live:run`), and the local simulation (`sim/`) plays the same plan for free.
 */
export const PIPELINE = [
  { key: "research", owner: "research", title: "Find and qualify 3 shops", body: "Find 3 busy independent auto repair shops for the goal's area and file each as a lead with a research note. Done = 3 leads in the CRM, by cli_ id." },
  { key: "outreach", owner: "sales", title: "Draft intro emails", body: "Draft one personal email per new lead from the company inbox. Done = one AgentMail draft per shop, noted on its CRM record. Nothing is sent: the operator reviews and sends.", blocked_by: ["research"] },
  { key: "onboarding", owner: "client-manager", title: "Onboard the shop that said yes", body: "For each shop at stage proposal, draft the onboarding questions; record its answers as its receptionist config. Blocked until a shop says yes.", blocked_by: ["outreach"] },
  { key: "test-call", owner: "booking", title: "Handle a test call and book it", body: "The shop's receptionist (booking--<shop>) answers a test call and books it. Waits until a shop is active.", blocked_by: ["onboarding"] },
  { key: "monitoring", owner: "monitoring", title: "Check the first day of operations", body: "Done = calls, bookings and failures, summarised.", blocked_by: ["test-call"] },
  { key: "self-improvement", owner: "self-improvement", title: "Review the run and suggest improvements", body: "Done = at most three suggestions for the CEO.", blocked_by: ["monitoring"] },
] as const;

export type Owner = (typeof PIPELINE)[number]["owner"];
