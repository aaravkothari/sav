/**
 * The shop pages' server half: a shop's receptionist (from the autoops-voice MCP) and the company
 * inbox's mail (from AgentMail), read here so the browser never holds either credential.
 *
 *   GET /api/shops/:clientId/receptionist  the shop's current prompt, first message, facts and recent calls
 *   GET /api/shops/:clientId/emails        every email to or from the shop, with full text
 *   GET /api/mail/recent                   the inbox's latest messages, for the overview and the leads table
 *
 * Read-only by construction: nothing here sends, provisions or updates. Machine ids (the voice
 * shop_id, the Vapi assistant id, message ids) stay on the server, and so does the owner's portal
 * link, which carries the owner's token.
 *
 * Env: AUTOOPS_VOICE_TOKEN (the MCP bearer), AUTOOPS_MCP_URL (overrides `AUTOOPS.url` in
 * `templates/receptionist.ts` when the tunnel moves), AGENTMAIL_API_KEY. A missing one makes its
 * route answer `{ configured: false }` rather than fail.
 */
import { AUTOOPS } from "../templates/receptionist.ts";
import type { ApiContext, ApiReply, ApiRequest } from "./routes.ts";
import type { Client } from "../seed/clients.ts";
import { mailFor } from "../src/leads.ts";

type Env = Record<string, string | undefined>;
const env = (): Env => (typeof process === "undefined" ? {} : process.env);

const TIMEOUT_MS = 10_000;

// ── autoops-voice MCP ────────────────────────────────────────────────────────

export const autoopsUrl = (e: Env = env()): string => e.AUTOOPS_MCP_URL?.trim() || AUTOOPS.url;

/** One stateless MCP `tools/call`; the reply may be JSON or a one-event SSE stream. */
export async function callAutoops(tool: string, args: Record<string, unknown>, e: Env = env(), fetcher: typeof fetch = fetch): Promise<unknown> {
  const token = e.AUTOOPS_VOICE_TOKEN;
  if (!token) throw new Error("not configured");
  const res = await fetcher(autoopsUrl(e), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`the receptionist service answered ${res.status}`);
  const json = raw.trimStart().startsWith("{")
    ? raw
    : raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).find((line) => line.startsWith("{")) ?? "";
  const rpc = JSON.parse(json) as { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
  if (rpc.error) throw new Error(rpc.error.message ?? "the receptionist service refused the call");
  const text = rpc.result?.content?.find((c) => c.type === "text")?.text ?? "null";
  const parsed = (() => { try { return JSON.parse(text) as unknown; } catch { return text; } })();
  if (rpc.result?.isError) {
    const msg = typeof parsed === "object" && parsed !== null && "error" in parsed ? String((parsed as { error: unknown }).error) : String(parsed);
    throw new Error(msg);
  }
  return parsed;
}

/** The voice shop_id a shop's notes carry: `RECEPTIONIST: shop_id x`, or the worker's `voice shop_id x`. */
export function shopIdOf(client: Pick<Client, "notes">): string | null {
  let found: string | null = null;
  for (const note of client.notes) {
    const m = /\bshop_id["']?\s*[:=]?\s*["']?([A-Za-z0-9][\w-]*)/i.exec(note);
    if (m) found = m[1]!;
  }
  return found;
}

export interface CallSummary {
  at: string | null;
  duration_sec: number | null;
  outcome: string | null;
  summary: string;
  flags: string[];
  ended_by: string | null;
}

export interface ReceptionistView {
  shop_name: string;
  version: number | null;
  versions: number | null;
  /** True once the shop is trialing or paying and has its own number. */
  live: boolean;
  status: string | null;
  phone_number: string | null;
  system_prompt: string;
  first_message: string;
  hours: Record<string, string>;
  services: string[];
  policies: string[];
  demo_url: string | null;
}

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function receptionistView(r: Rec): ReceptionistView {
  const status = str(r.subscription_status);
  const phone = str(r.phone_number);
  const hours = typeof r.hours === "object" && r.hours !== null
    ? Object.fromEntries(Object.entries(r.hours as Rec).filter(([, v]) => typeof v === "string") as [string, string][])
    : {};
  return {
    shop_name: str(r.shop_name) ?? str(r.name) ?? "",
    version: num(r.version),
    versions: num(r.versions),
    live: phone !== null && (status === "trialing" || status === "active"),
    status,
    phone_number: phone,
    system_prompt: str(r.system_prompt) ?? "",
    first_message: str(r.first_message) ?? "",
    hours,
    services: strings(r.services),
    policies: strings(r.policies),
    demo_url: str(r.demo_url),
  };
}

const ENDED_BY: Record<string, string> = {
  "assistant-ended-call": "receptionist",
  "customer-ended-call": "caller",
};

export function callView(c: Rec, summaries: Map<string, string>): CallSummary {
  const id = str(c.id) ?? "";
  const reason = str(c.ended_reason);
  return {
    at: str(c.started_at) ?? str(c.created_at),
    duration_sec: num(c.duration_sec),
    outcome: str(c.outcome),
    summary: summaries.get(id) || str(c.summary) || "",
    flags: strings(c.flags),
    ended_by: reason ? ENDED_BY[reason] ?? reason.replace(/-/g, " ") : null,
  };
}

/**
 * Where the voice service serves its demo pages: the MCP URL's origin. A `RECEPTIONIST:` note can
 * carry a bare `/demo/<slug>`, and the shop page opens it on this base. Null when unparseable.
 */
export function demoBase(e: Env = env()): string | null {
  try {
    return new URL(autoopsUrl(e)).origin;
  } catch {
    return null;
  }
}

/** The receptionist reply, always carrying `demo_base` (a public address, no credential in it). */
async function receptionistRoute(client: Client): Promise<ApiReply> {
  const reply = await receptionistReply(client);
  return { ...reply, body: { ...(reply.body as Record<string, unknown>), demo_base: demoBase() } };
}

async function receptionistReply(client: Client): Promise<ApiReply> {
  const e = env();
  if (!e.AUTOOPS_VOICE_TOKEN) return { status: 200, body: { configured: false } };
  const shopId = shopIdOf(client);
  if (shopId === null) return { status: 200, body: { configured: true, receptionist: null, calls: [] } };
  const [r, summaries, calls] = await Promise.allSettled([
    callAutoops("get_receptionist", { shop_id: shopId }),
    callAutoops("list_call_summaries", { shop_id: shopId, limit: 10 }),
    callAutoops("list_calls", { shop_id: shopId, limit: 10 }),
  ]);
  if (r.status === "rejected") {
    const message = r.reason instanceof Error ? r.reason.message : "unreachable";
    const missing = /not found/i.test(message);
    return {
      status: 200,
      body: { configured: true, receptionist: null, calls: [], error: missing ? "The receptionist service has no record of this shop's demo." : "The receptionist service could not be reached just now." },
    };
  }
  const rows = (v: PromiseSettledResult<unknown>): Rec[] =>
    v.status === "fulfilled" && typeof v.value === "object" && v.value !== null && Array.isArray((v.value as Rec).calls) ? ((v.value as Rec).calls as Rec[]) : [];
  const full = rows(calls);
  const text = new Map(full.map((c) => [str(c.id) ?? "", str(c.summary) ?? ""]));
  const list = rows(summaries).length > 0 ? rows(summaries) : full;
  return {
    status: 200,
    body: { configured: true, receptionist: receptionistView(r.value as Rec), calls: list.map((c) => callView(c, text)) },
  };
}

// ── AgentMail ────────────────────────────────────────────────────────────────

const AGENTMAIL = "https://api.agentmail.to/v0";

export interface MailRow {
  direction: "sent" | "received";
  counterpart: string;
  subject: string;
  preview: string;
  at: string;
  /** Kept server-side to fetch the full text; never sent to the browser. */
  ref?: { inbox: string; message: string };
}

async function agentmail<T>(path: string, key: string, fetcher: typeof fetch = fetch): Promise<T> {
  const res = await fetcher(`${AGENTMAIL}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the inbox answered ${res.status}`);
  return (await res.json()) as T;
}

const addressOf = (v: string): string => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();

export function mailRow(m: Rec, inbox: string): MailRow {
  const labels = strings(m.labels);
  const sent = labels.includes("sent") || addressOf(str(m.from) ?? "") === inbox.toLowerCase();
  const to = strings(m.to);
  return {
    direction: sent ? "sent" : "received",
    counterpart: sent ? addressOf(to[0] ?? "") : addressOf(str(m.from) ?? ""),
    subject: str(m.subject) ?? "(no subject)",
    preview: str(m.preview) ?? "",
    at: str(m.timestamp) ?? str(m.created_at) ?? "",
    ref: { inbox, message: str(m.message_id) ?? "" },
  };
}

let mailCache: { at: number; rows: MailRow[] } | null = null;
const MAIL_TTL_MS = 30_000;

export async function recentMail(key: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<MailRow[]> {
  if (mailCache && now - mailCache.at < MAIL_TTL_MS) return mailCache.rows;
  const { inboxes = [] } = await agentmail<{ inboxes?: Rec[] }>("/inboxes", key, fetcher);
  const lists = await Promise.all(inboxes.map(async (box) => {
    const id = str(box.inbox_id) ?? "";
    const { messages = [] } = await agentmail<{ messages?: Rec[] }>(`/inboxes/${encodeURIComponent(id)}/messages?limit=200`, key, fetcher);
    return messages.map((m) => mailRow(m, id));
  }));
  const rows = lists.flat().filter((r) => r.at !== "").sort((a, b) => b.at.localeCompare(a.at));
  mailCache = { at: now, rows };
  return rows;
}

const publicRow = ({ ref: _ref, ...row }: MailRow) => row;

async function emailsRoute(client: Client, key: string): Promise<ApiReply> {
  // The same match the screens use (`src/leads.ts`): the contact or the shop's own domain (never a
  // webmail domain), a bounce report naming one of them, and never our own inbox's self-tests.
  const mine = mailFor(client, await recentMail(key)).slice(0, 12);
  const full = await Promise.all(mine.map(async (m) => {
    if (!m.ref?.message) return { ...publicRow(m), text: m.preview };
    try {
      const one = await agentmail<Rec>(`/inboxes/${encodeURIComponent(m.ref.inbox)}/messages/${encodeURIComponent(m.ref.message)}`, key);
      return { ...publicRow(m), text: str(one.extracted_text) ?? str(one.text) ?? m.preview };
    } catch {
      return { ...publicRow(m), text: m.preview };
    }
  }));
  return { status: 200, body: { configured: true, emails: full } };
}

// ── The route table ──────────────────────────────────────────────────────────

/** Null when the path is not one of these, so `routes.ts` goes on down its own table. */
export async function shopRoutes(req: ApiRequest, ctx: ApiContext): Promise<ApiReply | null> {
  const shop = /^\/api\/shops\/([\w-]+)\/(receptionist|emails)$/.exec(req.path);
  if (!shop && req.path !== "/api/mail/recent") return null;
  if (req.method !== "GET") return { status: 405, body: { error: "read-only route" } };
  const key = env().AGENTMAIL_API_KEY;
  try {
    if (!shop) {
      if (!key) return { status: 200, body: { configured: false, messages: [] } };
      return { status: 200, body: { configured: true, messages: (await recentMail(key)).slice(0, 200).map(publicRow) } };
    }
    const client = (await ctx.store()).read().clients.find((c) => c.id === shop[1]);
    if (!client) return { status: 404, body: { error: "no such shop" } };
    if (shop[2] === "receptionist") return await receptionistRoute(client);
    if (!key) return { status: 200, body: { configured: false, emails: [] } };
    return await emailsRoute(client, key);
  } catch {
    return { status: 502, body: { error: shop?.[2] === "receptionist" ? "the receptionist service is unreachable" : "the inbox is unreachable" } };
  }
}

/** Test seam: forget the cached inbox listing. */
export const resetMailCache = () => { mailCache = null; };
