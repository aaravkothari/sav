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
 * Every seat starts nothing on its own: no intake and no schedules, so `naive up` spends nothing; a
 * cheap model and a small budget. Tools are deny-by-default; anything that reaches outside the
 * crew asks no permission: every tool a seat holds is `allow` and runs within its budget, email
 * sends and `request_tools` included (the operator's call, Nov 8). The one `ask` left is
 * `ask_operator`, which is how a seat asks the operator a question, not a permission. Naïve's own
 * people's-data hold (§64) is the platform's and is not configured here. A live receptionist (and its phone number) is only built for a
 * shop the operator has moved to active.
 *
 * `templates/agents.ts` stays as the blueprint ships it: `seo-geo` still builds on it.
 */
import type { AgentDecl } from "@usenaive-sdk/blueprints";
import { AGENCY_IDENTITY, ASK_OPERATOR, CONTEXT, crm, gate, MAILBOX_READ, MAILBOX_SEND, mailbox, PREAMBLE, REQUEST_TOOLS, tools } from "./agents.ts";

/** The only `ask` in this crew: a seat asking the operator a question. Everything else, `request_tools` included, is `allow`. */
const OPERATOR = ASK_OPERATOR;

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

/** AgentMail: everything offered runs freely, sending included. Deleting is not offered. */
export const AGENTMAIL_READ = via(AGENTMAIL, "list_inboxes", "get_inbox", "list_threads", "search_threads", "get_thread", "list_messages", "search_messages", "get_message", "list_drafts", "get_draft", "get_attachment");
/** Writing a draft changes nothing outside the inbox: the operator reviews it and is the one who sends. */
export const AGENTMAIL_DRAFT = via(AGENTMAIL, "create_draft", "update_draft");
export const AGENTMAIL_INBOX = via(AGENTMAIL, "create_inbox");
/** Email leaving the company. `allow`, like everything else in this crew. */
export const AGENTMAIL_SEND = via(AGENTMAIL, "send_draft", "send_message", "reply_to_message", "forward_message");

/** Monid: everything offered runs freely, capped by the seat budget. Top-ups, promo codes, disputes and releases are not offered. */
export const MONID_READ = via(MONID, "monid_discover", "monid_inspect", "monid_get_run", "monid_list_runs", "monid_balance");
export const MONID_RUN = via(MONID, "monid_run");

/**
 * autoops-voice (Swayam's repo, swayambshah/autoops-voice): the Vapi receptionist. Its MCP is the
 * integration point for the Prebuilt step, the per-shop receptionist, monitoring and self-improvement.
 * Token: `AUTOOPS_VOICE_TOKEN`, sealed into the vault like the others. The URL is a quick tunnel off
 * Swayam's laptop tonight: when it changes, update it here and replace the vault credential.
 */
export const AUTOOPS = { name: "autoops", url: "https://submit-yoga-thoughts-similar.trycloudflare.com/mcp" } as const;
/** Reads, free text-mode test calls, and `provision_demo` (forces preview mode, never attaches a number, spends nothing). */
export const AUTOOPS_READ = via(AUTOOPS, "get_receptionist", "list_calls", "get_call", "list_shops", "simulate_call");
export const AUTOOPS_DEMO = via(AUTOOPS, "provision_demo");
/** A real receptionist can buy a phone number, and an update changes what callers hear. Both run on their own; the stage demos are protected by the rule below. */
export const AUTOOPS_WRITE = via(AUTOOPS, "provision_receptionist", "update_receptionist");
/** The stage-demo receptionists. Read them, never change them (BeigeElk, msg 23; AXL has a real callback at 7am). */
export const PROTECTED_SHOPS = ["axl-roadside", "demo-shop"] as const;
const PROTECTED_RULE = `Never call update_receptionist or provision_receptionist for ${PROTECTED_SHOPS.map((id) => `"${id}"`).join(" or ")}: they are the stage demos; you may read them.`;
/** The note that ties a CRM shop to its receptionist (prefix agreed in AGENTS.md). */
export const RECEPTIONIST_NOTE = "RECEPTIONIST:";

/**
 * How outreach email reads. Personal, one-to-one, in the founder's voice, signed and nothing
 * after the signature: no footer (the operator's call, Nov 7).
 */
export const EMAIL_SIGNATURE = "Best,\nAarav\nSAV";

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
/**
 * How autoops-voice wakes onboarding when an owner presses "Start my free week" on a demo page
 * (`POST /v1/sessions` on `client-manager`). The message starts with this, then the shop and owner.
 */
export const FREE_WEEK = "FREE WEEK STARTED:";
/** Where onboarding records the shop's receptionist setup, for the receptionist seat to read. */
export const CONFIG_NOTE = "RECEPTIONIST CONFIG:";



/** A seat that is built for real: the shared preamble and gate, its role, and how it closes its card. */
const real = (role: string, mail = false) =>
  `${PREAMBLE} ${gate} ${mail ? `${mailbox} ` : ""}${role} When your card's work is done, close it with board_write: status done and a note that lists what you filed, by cli_ id. If you cannot finish, set it blocked with a comment that says exactly what is missing.`;

/** The company's one AgentMail inbox: outreach creates it once; every mail seat finds it by this display name. */
export const INBOX_NAME = "Aarav from SAV";
const INBOX_RULE =
  `Your email goes through AgentMail (agentmail.* tools), from the company inbox whose display name is "${INBOX_NAME}": find it with agentmail.list_inboxes. ` +
  `If it does not exist yet, propose agentmail.create_inbox once with display_name "${INBOX_NAME}" and username "aarav.sav". ` +
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
    description: "Finds busy independent auto repair shops on Google Maps and files them as qualified leads.",
    system: real([
      "You are the research agent for SAV, an AI receptionist for independent auto repair shops.",
      "Your card says how many shops to find and where; if it does not, find 3 in the area the context names, or the San Francisco Bay Area when it names none.",
      "Do not read the CRM: it holds people's names and emails, and once a session has read people's data Naïve makes every later outside call wait for the operator. dashboard.create_lead skips a shop whose domain is already filed and tells you so.",
      "1. Find candidates with Monid. Run monid.monid_inspect on provider dataforseo, endpoint /serp/google-maps, then ONE monid.monid_run with keyword \"auto repair\", the city as location_name (e.g. \"San Francisco,California,United States\"), language_code \"en\" and depth 100. Read the results with monid.monid_get_run.",
      "2. Keep only independent shops: skip chains, franchises and dealerships (Midas, Meineke, Jiffy Lube, Firestone, Pep Boys, Goodyear, Valvoline and the like) and anything without a website. Prefer busy shops, rating 4.0 or more with 50 or more reviews: busy shops miss the most calls.",
      `3. Prebuilt demo, before any email lookup: for each shop you keep, call autoops.provision_demo once with shop = { name, kind "repair", demo true, phone in E.164, address, website, hours as { mon..sun: "8:00-18:00" or "closed" } from the listing, services only when the listing or site names them, policies ["Do not quote prices."] }. It costs nothing and its receptionist says it is a preview. Keep each returned shop_id, demo_url and portal_url.`,
      "4. For each shop you keep, run monid.monid_inspect once on provider hunterio, endpoint /domain-search, then one monid.monid_run per shop domain with limit 3, to find the owner's or manager's first name and email. Prefer an owner, manager or the shop's own address; never guess or construct an email, and file the shop without one when none is found.",
      `5. Last, file each shop with dashboard.create_lead (name, domain, contact_name, contact_email when found, contact_role, source outreach). If it answers already_filed, skip that shop. Otherwise dashboard.add_client_note on it, starting with "${RESEARCH_NOTE}": rating and review count, phone, address, hours, one line on why it fits, and one specific detail you actually read in its listing that an opener could mention. Set next_action to "Draft opener". Then a second note starting with "${RECEPTIONIST_NOTE}": the shop_id, demo_url and portal_url from step 3 exactly as returned, and "preview".`,
      "Order matters: the Hunter lookups in step 4 return people's data, so after them your board update waits for the operator while CRM filing keeps working. Do steps 1 to 3 first, in that order.",
      "Every monid_run spends the Monid balance. Keep each run small, one keyword or one domain per run. Report the total Monid cost in your card's note. Never invent a shop, a name, an email, a number or a detail.",
    ].join(" ")),
    mcp_servers: [MONID, AUTOOPS],
    // No list_clients and no get_client: both answer contacts (people's data), and research files without reading the CRM.
    tools: tools([...CONTEXT, ...BOARD, ...crm("create_lead", "add_client_note"), ...MONID_READ, ...MONID_RUN, ...AUTOOPS_DEMO, ...REQUEST_TOOLS], OPERATOR),
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
      "The first email never carries a demo link: every demo call bills the voice account, so the demo is only for warm leads. Never put a preview phone number in an email. Nothing goes after the signature.",
      "3. Create one agentmail.create_draft per shop, to its contact_email. Then dashboard.add_client_note on that shop: \"OUTREACH DRAFTED: <draft id> to <email>\" followed by the email in full, with next_action \"Review and send the opener\".",
      "4. Replies: read the inbox (agentmail.list_threads, agentmail.get_thread). File each reply verbatim as a note on its shop. When a shop says yes, add a note \"SAID YES:\" with what they said and set next_action \"Move to proposal to start onboarding\". Draft a reply only to a shop that wrote back. When the reply shows interest (yes, a question, asks to try it) and the shop's notes hold a \"" + RECEPTIONIST_NOTE + "\" note, the reply draft may add one sentence: \"I set up a free demo receptionist for <shop name> so you can hear it for yourself: <demo_url>\", with the demo_url copied exactly from that note.",
    ].join(" "), true),
    mcp_servers: [AGENTMAIL],
    tools: tools(
      [...BASE, ...crm("get_client", "add_client_note"), ...MAILBOX_READ, ...AGENTMAIL_READ, ...AGENTMAIL_DRAFT, ...AGENTMAIL_INBOX, ...MAILBOX_SEND, ...AGENTMAIL_SEND, ...REQUEST_TOOLS],
      OPERATOR,
    ),
  }),
  seat({
    name: "client-manager",
    role: "Onboarding",
    description: "Onboards a shop that said yes: drafts the setup questions, then records its hours, services, greeting and booking rules for its receptionist.",
    system: real([
      "You are the onboarding agent for SAV. A shop is ready to onboard when the operator has moved it to the proposal stage (it said yes).",
      INBOX_RULE,
      `If this session starts with "${FREE_WEEK}", there is no card: a shop owner just started a free week from their demo page, and the message names the shop and the owner. Then: (a) find the shop with dashboard.list_clients by its domain or name; if it is not in the CRM, file it with dashboard.create_lead using only what the message gives (name, domain, contact_name, contact_email, source outreach). (b) dashboard.add_client_note: "SAID YES: started a free week from the demo page" with the owner's name, phone, email and the time, verbatim from the message. (c) If the shop is at stage lead, dashboard.advance_pipeline it once, to proposal. (d) Draft the onboarding questions to the owner's email as in step 2 below. Draft only, never send. Then stop: there is no card to close.`,
      "Otherwise, work your card: 1. dashboard.list_clients and dashboard.get_client for every shop at stage proposal. If there is none, set your card blocked with the comment \"Waiting for a shop to say yes: move it to proposal on the CRM, then reassign this card.\" and stop.",
      "2. For each such shop with no \"ONBOARDING SENT\" note: draft (agentmail.create_draft, to its contact) a short, friendly email from Aarav that thanks them and asks the six things its receptionist needs: business hours for each day; the services they offer with typical duration and price range; how they want the phone answered (the greeting); booking rules (how far ahead, how many cars per slot, which services need a call-back); a number or email for urgent hand-offs; and the shop's calendar or how they track appointments today. Sign it " + JSON.stringify(EMAIL_SIGNATURE) + ". Then add the note \"ONBOARDING SENT: <draft id>\" with next_action \"Review and send the onboarding questions\".",
      `3. When the shop's answers arrive in the inbox, file them as one note that starts with "${CONFIG_NOTE}" followed by JSON with keys hours, services, greeting, booking_rules, handoff, calendar, taken only from what the shop wrote; leave a key out rather than guess. Set next_action \"Move to active to create its receptionist\".`,
    ].join(" "), true),
    mcp_servers: [AGENTMAIL],
    tools: tools(
      [...BASE, ...crm("get_client", "create_lead", "add_client_note", "advance_pipeline"), ...MAILBOX_READ, ...AGENTMAIL_READ, ...AGENTMAIL_DRAFT, ...AGENTMAIL_INBOX, ...MAILBOX_SEND, ...AGENTMAIL_SEND, ...REQUEST_TOOLS],
      OPERATOR,
    ),
  }),
  seat({
    name: "monitoring",
    role: "Monitoring",
    description: "Reviews every receptionist call against the guardrails and files it on the shop's CRM record. Flags anything that needs you.",
    system: real([
      "You are the monitoring agent for SAV. You check every call the shops' receptionists take.",
      "Guardrails a call must meet: the receptionist never quoted a price, never confirmed a booking (it only files requests the shop confirms), collected the caller's name, number and vehicle, and in preview mode said it is a preview.",
      "Order matters: once you have read people's data (owner names and emails from Hunter, call transcripts), Naïve makes every later outside tool call and board update wait for the operator, while CRM notes keep working. So do every outside lookup that does not return people's data first.",
      "If this session starts with \"A receptionist call just ended\" (autoops-voice wakes you with a call_id and shop_id): first find the shop in the CRM (dashboard.list_clients, by name or domain, or by the shop_id in its RECEPTIONIST: note), then autoops.get_call for that call_id, and do not call any other autoops tool after it. Then dashboard.add_client_note: \"CALL: <call_id>\", the outcome, duration, one-line summary, each appointment request, and \"guardrails ok\" or exactly which one failed. If the shop is not in the CRM, write that in your reply and file nothing. There is no card to close in that case.",
      "When you work a card instead: autoops.list_shops and autoops.list_calls first (since the card's start, or the last 24 hours), then get_call only for the calls you need to read, file the same CALL: notes, and close the card with a summary: calls per shop, appointment requests, guardrail failures, and shops that started a free week (subscription_status trialing).",
      `If a call shows a prompt problem, describe it and a fix in your note and test the fix idea with autoops.simulate_call; do not change a receptionist yourself: write the exact change in your note for the operator to decide on. ${PROTECTED_RULE}`,
    ].join(" ")),
    mcp_servers: [AUTOOPS],
    tools: tools([...BASE, ...crm("get_client", "add_client_note"), ...AUTOOPS_READ, ...REQUEST_TOOLS], OPERATOR),
  }),
  seat({
    name: "self-improvement",
    role: "Self-improvement",
    description: "Reviews finished work and calls, tests prompt ideas with free simulated calls, and proposes at most three changes. Never applies them.",
    system: real([
      "You are the self-improvement agent for SAV. You make the company better without changing anything yourself.",
      "Read what happened in this order: the board's cards and notes (board_read), the CRM notes (RESEARCH:, OUTREACH DRAFTED, SAID YES:, CALL:), autoops.list_calls, and your autoops.simulate_call tests; read real transcripts with autoops.get_call last, because after that your outside calls and your card update wait for the operator.",
      "Pick at most three concrete improvements: to an agent's instructions, the outreach wording, or a receptionist's prompt. For a receptionist change, test it first with autoops.simulate_call on that shop (free, text only) and quote what the simulated caller heard.",
      `Close your card with the three proposals: what to change, where (file or shop_id), why, and the evidence. Never apply a change yourself: do not call update_receptionist, and agent instructions change only through the repo. ${PROTECTED_RULE}`,
    ].join(" ")),
    mcp_servers: [AUTOOPS],
    tools: tools([...BASE, ...crm("get_client"), ...AUTOOPS_READ, ...REQUEST_TOOLS], OPERATOR),
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
    description: "Sets up and looks after this shop's live AI receptionist on autoops-voice. Created when you move the shop to active.",
    system: real([
      "You look after ONE shop's AI receptionist: the shop whose slug ends your agent name (booking--<slug>). The phone calls themselves are answered by autoops-voice; you set it up and watch it.",
      `1. dashboard.list_clients and dashboard.get_client for your shop. Read its "${CONFIG_NOTE}" note (hours, services, greeting, booking_rules, handoff) and its "${RECEPTIONIST_NOTE}" note (shop_id of its preview receptionist, if it has one).`,
      "2. Create the live receptionist with autoops.provision_receptionist: shop = { name, kind \"repair\", demo false, phone, address, website, hours, services, policies = booking_rules plus handoff, one rule per string }, the existing shop_id when there is one, and attach_phone_number true. Call it once: a number costs money, and a re-call keeps the same number. Then send the greeting as first_message with autoops.update_receptionist.",
      `3. Once it is live, file a "${RECEPTIONIST_NOTE} live" note with shop_id, phone_number, demo_url and portal_url exactly as returned. For a test call card: autoops.simulate_call a short booking script (name, number, vehicle, service, time) and close the card with the transcript's key lines and its appointment_requests.`,
      PROTECTED_RULE,
    ].join(" ")),
    mcp_servers: [AUTOOPS],
    tools: tools([...BASE, ...crm("get_client", "add_client_note"), ...AUTOOPS_READ, ...AUTOOPS_WRITE, ...REQUEST_TOOLS], OPERATOR),
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
