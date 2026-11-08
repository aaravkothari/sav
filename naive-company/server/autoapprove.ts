/**
 * Approving, on the operator's behalf, the calls Naïve holds that are known to be safe.
 *
 * Why this exists: Naïve holds every MCP call, `board_write` and `data_run` of a chat it has
 * flagged for reading people's data, even at `allow`, and the flag spreads to every chat that chat
 * hands work to (docs: capabilities/tools, "Once a chat has read people's data"). In this crew that
 * puts the whole research step on Approvals: the Maps search, the demo builds, its own card notes.
 * Aarav asked for those to run without him (Nov 8).
 *
 * Aarav's call (Nov 8, after a first version that approved by rule): approve EVERY held tool call.
 * Nothing the crew proposes waits on a person any more, sends and phone numbers included; only a
 * question an agent asks (`ask_operator`) still does, because it needs an answer, not a yes.
 * `ruleFor` survives only to label each approval in the log ("Google Maps search", "email to a CRM
 * contact", or "approved everything" for a call no rule names), so the log still says what ran.
 *
 * Any open dashboard screen asks for a sweep every 2 s (`src/Shell.tsx`), backing off when the
 * platform answers 429. Never while the company is paused.
 */
import { proxyFetch, type ProxyConfig } from "./proxy.ts";
import type { Store } from "./store.ts";

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

/** The decision for one held call: the rule that allows it, or null for "a person decides". */
export function ruleFor(action: PendingAction, session: ParkedSession, crmEmails: ReadonlySet<string>): string | null {
  if (action.kind !== undefined && action.kind !== "tool") return null; // a question is the operator's
  const args = action.args ?? {};
  const name = action.name;
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  // Monid: reading the catalogue and runs is free; a run only on the two sources research uses.
  if (["monid.monid_discover", "monid.monid_inspect", "monid.monid_get_run", "monid.monid_list_runs", "monid.monid_balance"].includes(name)) return "Monid read";
  if (name === "monid.monid_run") {
    const provider = str(args.provider);
    const endpoint = str(args.endpoint);
    if (provider === "dataforseo" && endpoint === "/serp/google-maps") return "Google Maps search";
    if (provider === "hunterio" && endpoint === "/domain-search") return "owner email lookup";
    return null;
  }

  // autoops-voice: reads and free text-mode calls; a demo only when it is a preview (no number).
  if (["autoops.get_receptionist", "autoops.list_call_summaries", "autoops.list_calls", "autoops.get_call", "autoops.list_shops", "autoops.simulate_call"].includes(name)) return "receptionist read";
  if (name === "autoops.provision_demo") {
    const shop = args.shop as { demo?: unknown } | undefined;
    return shop?.demo === true ? "free preview demo" : null;
  }

  // The board: an agent writing on the one card it was woken for.
  if (name === "board_write") {
    const own = session.metadata?.board?.card_id;
    const op = str(args.op);
    return own !== undefined && str(args.card_id) === own && (op === "comment" || op === "update") ? "note on its own card" : null;
  }

  // Our CRM and the company inbox: filing, notes and drafts stay inside the company.
  if (["dashboard.create_lead", "dashboard.add_client_note", "dashboard.get_client", "dashboard.list_clients"].includes(name)) return "our CRM";
  if (["agentmail.create_draft", "agentmail.update_draft", "agentmail.create_inbox", "agentmail.list_inboxes", "agentmail.get_inbox",
    "agentmail.list_threads", "agentmail.search_threads", "agentmail.get_thread", "agentmail.list_messages", "agentmail.search_messages",
    "agentmail.get_message", "agentmail.list_drafts", "agentmail.get_draft", "agentmail.get_attachment", "email.inboxes", "email.read"].includes(name)) {
    return "company inbox";
  }

  // An email out: only when every recipient is a contact already in the CRM.
  if (name === "email.send" || name === "agentmail.send_message" || name === "agentmail.reply_to_message") {
    const recipients = [args.to, args.cc, args.bcc].flatMap((v) => (Array.isArray(v) ? v : v === undefined ? [] : [v])).map((v) => str(v).trim().toLowerCase());
    if (name === "agentmail.reply_to_message" && recipients.length === 0) return null; // a reply's recipient is not in its arguments
    return recipients.length > 0 && recipients.every((r) => crmEmails.has(r)) ? "email to a CRM contact" : null;
  }
  return null;
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

/**
 * Held calls the dashboard never approves for the operator: changing the public site is posting
 * publicly, which AGENTS.md keeps for a person. The SEO seat proposes it; a person decides.
 */
export const NEVER_AUTO: ReadonlySet<string> = new Set(["dashboard.update_site"]);

/** Approves every held call a rule allows, logs each one, and leaves the rest for a person. */
export async function autoApprove(config: ProxyConfig, store: Store, now: Date, fetchImpl: typeof fetch = fetch): Promise<{ approved: AutoApproval[]; left: number; rate_limited?: boolean }> {
  if (store.company().paused) return { approved: [], left: 0 };
  const sessions = await parkedSessions(config, fetchImpl);
  if (sessions === "rate_limited") return { approved: [], left: 0, rate_limited: true };
  const crmEmails = new Set(store.read().clients.map((c) => c.contact.email.trim().toLowerCase()).filter((e) => e !== ""));
  const approved: AutoApproval[] = [];
  let left = 0;
  for (const session of sessions) {
    for (const action of session.pending_actions ?? []) {
      // A question needs an answer from a person, and so does the public site; every other tool call is approved.
      if ((action.kind !== undefined && action.kind !== "tool") || NEVER_AUTO.has(action.name)) {
        left += 1;
        continue;
      }
      const rule = ruleFor(action, session, crmEmails) ?? "approved everything";
      const res = await proxyFetch(config, { method: "POST", path: `/v1/sessions/${encodeURIComponent(session.id)}/tool_confirmations` },
        JSON.stringify({ tool_call_id: action.tool_call_id, decision: "allow", reason: `Approved automatically by the dashboard: ${rule}.` }), fetchImpl);
      if (res.ok) approved.push({ at: now.toISOString(), session_id: session.id, agent_id: session.agent_id, tool: action.name, rule });
      else left += 1;
    }
  }
  if (approved.length > 0) store.logAutoApprovals(approved, LOG_CAP);
  return { approved, left };
}
