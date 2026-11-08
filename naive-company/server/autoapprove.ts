/**
 * Approving, on the operator's behalf, the calls Naïve holds, except the few that are never approved.
 *
 * Why this exists: Naïve holds every MCP call, `board_write` and `data_run` of a chat it has
 * flagged for reading people's data, even at `allow`, and the flag spreads to every chat that chat
 * hands work to (docs: capabilities/tools, "Once a chat has read people's data"). In this crew that
 * puts the whole research step on Approvals: the Maps search, the demo builds, its own card notes.
 * Aarav wants the crew unattended (Nov 8): every held call of THIS crew that `ruleFor` names is approved.
 * A call no rule names (e.g. `dashboard.update_site`, a new seat's new tool) is left for a person on Approvals.
 *
 * Issue #30: the server, not a person and not an AI, enforces hard limits that are never approved.
 * A call that hits one is denied with the reason, so the agent hears why and carries on:
 *   - buying a phone number (`provision_receptionist` with `attach_phone_number: true`), unless the
 *     shop's CRM notes show a completed Stripe checkout (`PAID:` or "subscription active");
 *   - any Stripe live-mode call (or a Stripe call whose mode it cannot tell);
 *   - `request_tools`;
 *   - any email send to an address that is not a CRM contact (a draft send, whose recipient is not
 *     in its arguments, counts: it cannot be checked);
 *   - any email send once the day's sends (Pacific time) reach `DAILY_SEND_CAP`.
 * Holds from agents outside this crew are ignored: neither approved nor denied.
 * A question an agent asks (`ask_operator`) still waits, because it needs an answer, not a yes.
 *
 * `ruleFor` labels each approval in the log ("Google Maps search", "email to a CRM contact", or
 * "approved everything" for a call no rule names), so the log still says what ran.
 *
 * Swept every 15 s by the outbound engine (`scripts/engine.ts`) and every 2 s by any open dashboard
 * screen (`src/Shell.tsx`), backing off when the platform answers 429. Never while the company is paused.
 */
import { collect, proxyFetch, type ProxyConfig } from "./proxy.ts";
import type { Store } from "./store.ts";
import type { Client } from "../seed/clients.ts";
import { PROTECTED_SHOPS, receptionistCrew, receptionistRoster } from "../templates/receptionist.ts";

/** Emails a day, across the crew and the engine, after which no send is approved. */
export const DAILY_SEND_CAP = 2500;

/** What `hardLimit` never approves, as `GET /api/approvals/auto` reports it (the engine sweeps only a dashboard that says so). */
export const HARD_LIMITS = [
  "phone number purchase without a PAID: note",
  "Stripe live mode",
  "request_tools",
  "public posts, SMS or outbound calls",
  "changes to the frozen stage demos (axl-roadside, demo-shop)",
  "email to an address not on a CRM contact",
  `any email past ${DAILY_SEND_CAP} a Pacific day`,
] as const;

export interface PendingAction {
  kind?: string;
  name: string;
  tool_call_id: string;
  args?: Record<string, unknown>;
  read_people?: boolean;
}

export interface ParkedSession {
  id: string;
  agent_id: string;
  stop_reason: string | null;
  pending_actions?: PendingAction[];
  metadata?: { board?: { card_id?: string } } | null;
}

export interface AutoApproval {
  at: string;
  session_id: string;
  agent_id: string;
  tool: string;
  rule: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

const EMAIL_SENDS = new Set(["email.send", "agentmail.send_message", "agentmail.reply_to_message", "agentmail.reply_all_message", "agentmail.forward_message", "agentmail.send_draft"]);

/** Every address an email call names, lower-cased. */
function recipientsOf(args: Record<string, unknown>): string[] {
  return [args.to, args.cc, args.bcc].flatMap((v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])).map((v) => str(v).trim().toLowerCase()).filter((v) => v !== "");
}

/** The decision for one held call: the rule that allows it, or null for "a person decides". */
export function ruleFor(action: PendingAction, session: ParkedSession, crmEmails: ReadonlySet<string>): string | null {
  if (action.kind !== undefined && action.kind !== "tool") return null; // a question is the operator's
  const args = action.args ?? {};
  const name = action.name;

  // The seat's own context, skills and board, and talking to the crew's other seats.
  if (["project_context", "read_skill", "board_read", "list_agents", "send_to_agent"].includes(name)) return "the crew's own context";
  // Onboarding calls on the company calendar (the owner asked for the call). Inert until the
  // Google Calendar connection is authorized.
  if (/^googlecalendar\.(get_current_date_time|find_free_slots|events_list|find_event|create_event|update_event)$/.test(name)) return "booking an onboarding call";

  // Reading the public web (research finds shop emails on the shop's own site).
  if (name === "web_fetch" || name === "web_search") return "reading the public web";

  // Monid: reading the catalogue and runs is free; a run only on the two sources research uses.
  if (["monid.monid_discover", "monid.monid_inspect", "monid.monid_get_run", "monid.monid_list_runs", "monid.monid_balance"].includes(name)) return "Monid read";
  if (name === "monid.monid_run") {
    const provider = str(args.provider);
    const endpoint = str(args.endpoint);
    if (provider === "dataforseo" && endpoint === "/serp/google-maps") return "Google Maps search";
    if (provider === "hunterio" && endpoint === "/domain-search") return "owner email lookup";
    if (provider === "anyapi" && endpoint === "/maps.contacts") return "Maps contacts search";
    return null;
  }

  // autoops-voice: reads and free text-mode calls; a demo only when it is a preview (no number).
  if (["autoops.get_receptionist", "autoops.list_calls", "autoops.get_call", "autoops.list_shops", "autoops.simulate_call", "autoops.list_call_summaries"].includes(name)) return "receptionist read";
  // Spends nothing: a Stripe TEST checkout link, an extra caller ID on the shared demo line, a prompt or fact change (frozen shops are a hard limit).
  if (name === "autoops.create_trial_checkout") return "test-mode checkout link";
  if (name === "autoops.add_caller") return "caller ID for the shared demo line";
  if (name === "autoops.update_receptionist") return "receptionist update";
  // Going live: a number purchase without a PAID: note is a hard limit, so what reaches here is safe.
  if (name === "autoops.activate_shop" || name === "autoops.provision_receptionist") return "go live after checkout";
  if (name === "autoops.provision_demo") {
    const shop = args.shop as { demo?: unknown } | undefined;
    return shop?.demo === true ? "free preview demo" : null;
  }

  // The board: an agent writing on the one card it was woken for.
  if (name === "board_write") {
    const own = session.metadata?.board?.card_id;
    const op = str(args.op);
    // A scheduled or woken run names no card_id: the platform applies the write to the session's own card.
    const target = str(args.card_id) === "" ? own : str(args.card_id);
    return own !== undefined && target === own && (op === "comment" || op === "update") ? "note on its own card" : null;
  }

  // Our CRM and the company inbox: filing, notes and drafts stay inside the company.
  if (["dashboard.create_lead", "dashboard.add_client_note", "dashboard.get_client", "dashboard.list_clients", "dashboard.advance_pipeline",
    "dashboard.list_posts", "dashboard.get_calendar", "dashboard.get_site", "dashboard.list_agents"].includes(name)) return "our CRM";
  // Promotion drafts into the content queue; nothing is published (publishing is a hard limit).
  if (name === "dashboard.create_draft_post") return "draft in the content queue";
  if (["agentmail.create_draft", "agentmail.update_draft", "agentmail.create_inbox", "agentmail.list_inboxes", "agentmail.get_inbox",
    "agentmail.list_threads", "agentmail.search_threads", "agentmail.get_thread", "agentmail.list_messages", "agentmail.search_messages",
    "agentmail.get_message", "agentmail.list_drafts", "agentmail.get_draft", "agentmail.get_attachment", "email.inboxes", "email.read"].includes(name)) {
    return "company inbox";
  }

  // An email out: only when every recipient is a contact already in the CRM.
  if (name === "email.send" || name === "agentmail.send_message" || name === "agentmail.reply_to_message") {
    const recipients = recipientsOf(args);
    // A reply goes back on the thread the shop wrote in (the hard limit checks any extra recipient).
    if (name === "agentmail.reply_to_message" && recipients.length === 0) return "reply on the shop's own thread";
    return recipients.length > 0 && recipients.every((r) => crmEmails.has(r)) ? "email to a CRM contact" : null;
  }
  return null;
}

/** A CRM note that shows the shop finished a Stripe checkout. */
const PAID = /^PAID:|subscription(?:_status)?\W{0,3}active\b/im;

/** The CRM shop a voice-server call is about: its `shop_id` named in a note, or its name. */
function clientForShop(args: Record<string, unknown>, clients: readonly Client[]): Client | undefined {
  const shopId = str(args.shop_id).trim().toLowerCase();
  const shopName = str((args.shop as { name?: unknown } | undefined)?.name).trim().toLowerCase();
  if (shopId !== "") {
    const pattern = new RegExp(`(^|[^a-z0-9-])${shopId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`, "i");
    const byId = clients.find((c) => c.slug === shopId || c.notes.some((n) => pattern.test(n)));
    if (byId) return byId;
  }
  return shopName === "" ? undefined : clients.find((c) => c.name.trim().toLowerCase() === shopName);
}

export interface LimitContext {
  crmEmails: ReadonlySet<string>;
  clients: readonly Client[];
  sendsToday: number;
}

/** Tool names (after the server prefix) that post publicly, text or place a call. */
const PUBLIC_OR_PHONE = /(^|_)(post|posts|publish|tweet|social|sms|text|call|dial|approve_post|schedule_post|post_now)(_|$)/i;
/** Names that match the pattern above but only read calls or draft a post. */
const SAFE_LOOKALIKES = new Set(["list_calls", "get_call", "list_call_summaries", "simulate_call", "list_posts", "create_draft_post", "get_calendar"]);
const PROTECTED = new Set<string>(PROTECTED_SHOPS);

/** Why a held call is never approved, or null when it may be. Checked before any rule, so no rule can override it. */
export function hardLimit(action: PendingAction, ctx: LimitContext): string | null {
  const name = action.name;
  const args = action.args ?? {};
  const bare = name.slice(name.lastIndexOf(".") + 1);

  if (bare === "request_tools") return "request_tools is never approved automatically";

  // Public posts, SMS and phone calls need a human (AGENTS.md). Reading calls and drafting posts do not.
  if (PUBLIC_OR_PHONE.test(bare) && !SAFE_LOOKALIKES.has(bare)) return "public posts, SMS and outbound calls need a human (AGENTS.md)";

  // The stage demos are frozen.
  if ((bare === "update_receptionist" || bare === "provision_receptionist" || bare === "activate_shop" || bare === "add_caller") &&
    PROTECTED.has(str(args.shop_id).trim().toLowerCase())) {
    return `${str(args.shop_id)} is a frozen stage demo`;
  }

  if (bare === "provision_receptionist" && args.attach_phone_number === true) {
    const client = clientForShop(args, ctx.clients);
    if (client && client.notes.some((n) => PAID.test(n))) return null;
    return "buying a phone number needs a completed Stripe checkout (a PAID: note) on the shop";
  }

  if (/stripe/i.test(name)) {
    const raw = JSON.stringify(args);
    const test = args.livemode === false || str(args.mode).toLowerCase() === "test" || /\b(sk|rk|pk)_test_/.test(raw);
    const live = args.livemode === true || str(args.mode).toLowerCase() === "live" || /\b(sk|rk|pk)_live_/.test(raw);
    if (live || !test) return "Stripe live-mode calls are never approved automatically";
  }

  if (EMAIL_SENDS.has(name)) {
    if (ctx.sendsToday >= DAILY_SEND_CAP) return `the daily send cap (${DAILY_SEND_CAP}) is reached`;
    const recipients = recipientsOf(args);
    if (name === "agentmail.send_draft") return "a draft's recipient is not in its arguments, so it cannot be checked against the CRM";
    const replying = name === "agentmail.reply_to_message" || name === "agentmail.reply_all_message";
    // A reply goes to the thread the shop wrote in; only extra recipients it names are checked.
    if (!replying && recipients.length === 0) return "an email with no recipient the CRM can check";
    const stranger = recipients.find((r) => !ctx.crmEmails.has(r));
    if (stranger !== undefined) return `${stranger} is not a CRM contact`;
  }
  return null;
}

/** This crew's seat names: the company roster, the per-shop seats (`booking--<slug>`), and the CEO. */
const ROSTER = new Set(receptionistRoster.map((a) => a.name));
const PER_SHOP = receptionistCrew.map((a) => `${a.name}--`);

export function isCrewAgent(agent: { name: string; metadata?: Record<string, unknown> | null }): boolean {
  return ROSTER.has(agent.name) || PER_SHOP.some((p) => agent.name.startsWith(p)) || agent.metadata?.["role"] === "orchestrator";
}

/** The held sessions, read the way the Approvals screen reads them. */
async function parkedSessions(config: ProxyConfig, fetchImpl: typeof fetch): Promise<ParkedSession[] | "rate_limited"> {
  const res = await proxyFetch(config, { method: "GET", path: "/v1/sessions?status=idle&limit=100" }, null, fetchImpl);
  if (res.status === 429) return "rate_limited";
  if (!res.ok) return [];
  const page = (await res.json()) as { data?: ParkedSession[] };
  return (page.data ?? []).filter((s) => s.stop_reason === "awaiting_approval" && (s.pending_actions?.length ?? 0) > 0);
}

const LOG_CAP = 200;

export interface SweepResult {
  approved: AutoApproval[];
  /** Calls denied by a hard limit, with the reason. */
  denied: AutoApproval[];
  /** Calls left for a person: questions, and confirmations the platform refused. */
  left: number;
  /** Held calls from agents outside this crew, untouched. */
  ignored: number;
  rate_limited?: boolean;
}

/** Approves every held call of this crew that no hard limit stops, denies the ones one does, and logs both. */
export async function autoApprove(config: ProxyConfig, store: Store, now: Date, fetchImpl: typeof fetch = fetch): Promise<SweepResult> {
  const none: SweepResult = { approved: [], denied: [], left: 0, ignored: 0 };
  if (store.company().paused) return none;
  const sessions = await parkedSessions(config, fetchImpl);
  if (sessions === "rate_limited") return { ...none, rate_limited: true };
  if (sessions.length === 0) return none;
  // Without the roster nothing is known to be ours, so nothing is approved this sweep.
  const agents = await collect<{ id: string; name: string; metadata?: Record<string, unknown> | null }>(config, "/v1/agents", fetchImpl);
  if (agents === null) return { ...none, ignored: sessions.reduce((n, s) => n + (s.pending_actions?.length ?? 0), 0) };
  const crew = new Set(agents.filter(isCrewAgent).map((a) => a.id));

  const clients = store.read().clients;
  const crmEmails = new Set(clients.map((c) => c.contact.email.trim().toLowerCase()).filter((e) => e !== ""));
  const limits: LimitContext = { crmEmails, clients, sendsToday: store.sendsOn(now) };
  const result: SweepResult = { approved: [], denied: [], left: 0, ignored: 0 };
  for (const session of sessions) {
    if (!crew.has(session.agent_id)) {
      result.ignored += session.pending_actions?.length ?? 0;
      continue;
    }
    for (const action of session.pending_actions ?? []) {
      // A question needs an answer from a person.
      if (action.kind !== undefined && action.kind !== "tool") {
        result.left += 1;
        continue;
      }
      const limit = hardLimit(action, limits);
      const rule = limit === null ? ruleFor(action, session, crmEmails) : null;
      // No rule names it: a person decides on Approvals (PinkFalcon's review of #52). A tool a new
      // seat brings is never approved silently; add it to `ruleFor` when it is safe.
      if (limit === null && rule === null) {
        result.left += 1;
        continue;
      }
      const reason = limit === null ? `Approved automatically by the dashboard: ${rule}.` : `Denied by the dashboard's hard limit: ${limit}. This is never approved automatically; do not retry it.`;
      const res = await proxyFetch(config, { method: "POST", path: `/v1/sessions/${encodeURIComponent(session.id)}/tool_confirmations` },
        JSON.stringify({ tool_call_id: action.tool_call_id, decision: limit === null ? "allow" : "deny", reason }), fetchImpl);
      const row = { at: now.toISOString(), session_id: session.id, agent_id: session.agent_id, tool: action.name, rule: limit === null ? (rule ?? "") : `DENIED: ${limit}` };
      if (!res.ok) result.left += 1;
      else if (limit === null) result.approved.push(row);
      else result.denied.push(row);
    }
  }
  const logged = [...result.approved, ...result.denied];
  if (logged.length > 0) store.logAutoApprovals(logged, LOG_CAP);
  return result;
}
