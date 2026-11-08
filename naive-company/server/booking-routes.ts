/**
 * The Bookings page's server half (`src/screens/Bookings.tsx`).
 *
 *   GET  /api/bookings/requests             appointment requests the shops' receptionists took, every shop
 *   POST /api/bookings/:clientId/script     wake client-manager for a fuller MEETING SCRIPT note
 *   POST /api/bookings/:clientId/feedback   file MEETING FEEDBACK and wake client-manager (`server/feedback.ts`)
 *
 * The onboarding calls themselves need no route: they are CRM notes the page already reads.
 *
 * The requests come from the voice server's dashboard API (autoops-voice `src/api/router.ts`,
 * `GET /api/shops` and `GET /api/shops/:id`) on the same host and bearer as its MCP
 * (`autoopsUrl`, `AUTOOPS_VOICE_TOKEN`; `AUTOOPS_API_TOKEN` when the voice server sets its own
 * `DASHBOARD_API_TOKEN`). That API already gives first names and masked numbers; this file masks
 * again anyway, and drops every id, the portal link (it carries the owner's token) and the shop's
 * contact details before anything reaches the browser.
 */
import type { Client } from "../seed/clients.ts";
import { cleanFeedback } from "../src/bookings.ts";
import { autoopsUrl, shopIdOf } from "./shop-routes.ts";
import { requestMeetingScript, submitCallFeedback } from "./feedback.ts";
import type { ApiContext, ApiReply, ApiRequest } from "./routes.ts";

type Env = Record<string, string | undefined>;
type Rec = Record<string, unknown>;
const env = (): Env => (typeof process === "undefined" ? {} : process.env);

const TIMEOUT_MS = 10_000;
/** Shops read at once from the voice server: a quick tunnel off a laptop, so a small number. */
export const FAN_OUT = 4;
const CACHE_MS = 30_000;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** "+14155550123" or "•••-0123" → "•••-0123". Never more than the last four digits. */
export function maskPhone(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 4 ? `•••-${digits.slice(-4)}` : "•••";
}

/** A caller's first name only. */
export const firstNameOnly = (v: unknown): string | null => str(v)?.split(/\s+/)[0] ?? null;

/** Phone numbers and email addresses inside free text (a caller's notes, a call summary), masked. */
export const scrubContact = (text: string): string =>
  text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "(email)")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => (m.replace(/\D/g, "").length >= 10 ? maskPhone(m)! : m));

export type RequestStatus = "pending" | "confirmed" | "declined";

export interface AppointmentRow {
  /** A position, not an id: React needs a key and the browser needs nothing more. */
  key: string;
  shop: string;
  /** The CRM shop page's slug, when the voice shop is one of ours. */
  lead: string | null;
  /** True for a preview receptionist (the owner trying the demo, usually). */
  demo: boolean;
  caller: string | null;
  callback: string | null;
  vehicle: string | null;
  service: string | null;
  preferred_time: string | null;
  notes: string | null;
  status: RequestStatus;
  /** Plain-English flags: "vehicle unclear", "quoted a price", … */
  flags: string[];
  created_at: string | null;
  call: {
    at: string | null;
    duration_sec: number | null;
    outcome: string | null;
    ended_by: string | null;
    summary: string;
  } | null;
}

/** Call flags a person cares about on a request, in words. The rest (appointment_request itself) say nothing new. */
const FLAG_WORDS: Record<string, string> = {
  vehicle_unclear: "vehicle unclear",
  vehicle_corrected: "vehicle corrected",
  quoted_price: "quoted a price",
  confirmed_appointment: "promised a booking",
  too_long: "ran long",
  no_transcript: "no transcript",
  short_call: "short call",
};

const ENDED_BY: Record<string, string> = { "assistant-ended-call": "receptionist", "customer-ended-call": "caller" };

const statusOf = (v: unknown): RequestStatus => (v === "confirmed" || v === "declined" ? v : "pending");

/** One voice shop's detail (`GET /api/shops/:id`) as browser-safe rows. */
export function requestRows(shop: Rec, leadSlug: string | null): AppointmentRow[] {
  const calls = new Map((Array.isArray(shop.calls) ? (shop.calls as Rec[]) : []).map((c) => [str(c.id) ?? "", c]));
  const name = str(shop.name) ?? "A shop";
  const requests = Array.isArray(shop.requests) ? (shop.requests as Rec[]) : [];
  return requests.map((r, i) => {
    const call = calls.get(str(r.call_id) ?? "") ?? null;
    const reason = call ? str(call.ended_reason) : null;
    const flags = [...new Set(strings(call?.flags).map((f) => FLAG_WORDS[f]).filter((f): f is string => f !== undefined))];
    return {
      key: String(i),
      shop: name,
      lead: leadSlug,
      demo: shop.demo === true,
      caller: firstNameOnly(r.customer_name),
      callback: maskPhone(r.callback_number),
      vehicle: str(r.vehicle),
      service: str(r.service),
      preferred_time: str(r.preferred_time),
      notes: str(r.notes) === null ? null : scrubContact(str(r.notes)!),
      status: statusOf(r.status),
      flags,
      created_at: str(r.created_at),
      call: call ? {
        at: str(call.started_at) ?? str(call.ended_at),
        duration_sec: num(call.duration_sec),
        outcome: str(call.outcome),
        ended_by: reason ? ENDED_BY[reason] ?? reason.replace(/-/g, " ") : null,
        summary: scrubContact(str(call.summary) ?? ""),
      } : null,
    };
  });
}

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The voice server's dashboard API base: the MCP URL's origin, plus `/api`. */
export function voiceApiBase(e: Env = env()): string | null {
  try {
    return `${new URL(autoopsUrl(e)).origin}/api`;
  } catch {
    return null;
  }
}

const voiceToken = (e: Env = env()): string | undefined => e.AUTOOPS_API_TOKEN?.trim() || e.AUTOOPS_VOICE_TOKEN?.trim() || undefined;

async function voiceGet(path: string, token: string, base: string, fetcher: typeof fetch): Promise<Rec> {
  const res = await fetcher(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the receptionist service answered ${res.status}`);
  return (await res.json()) as Rec;
}

export interface RequestsReply {
  configured: boolean;
  requests: AppointmentRow[];
  /** Shops whose detail could not be read this time; their requests are missing from the list. */
  missing: number;
  error?: string;
}

let cache: { at: number; reply: RequestsReply } | null = null;

/**
 * Every appointment request, newest first. The shop list says which shops have any
 * (`appointment_requests`), so only those are read, `FAN_OUT` at a time, and the whole answer is
 * kept for 30 s.
 */
export async function appointmentRequests(clients: readonly Client[], e: Env = env(), fetcher: typeof fetch = fetch, now = Date.now()): Promise<RequestsReply> {
  const token = voiceToken(e);
  const base = voiceApiBase(e);
  if (!token || base === null) return { configured: false, requests: [], missing: 0 };
  if (cache && now - cache.at < CACHE_MS) return cache.reply;
  let shops: Rec[];
  try {
    const list = await voiceGet("/shops", token, base, fetcher);
    shops = Array.isArray(list.shops) ? (list.shops as Rec[]) : [];
  } catch {
    return { configured: true, requests: [], missing: 0, error: "The receptionist service could not be reached just now." };
  }
  const slugs = new Map<string, string>();
  for (const c of clients) {
    const id = shopIdOf(c);
    if (id) slugs.set(id, c.slug || c.id);
  }
  const busy = shops.filter((s) => (num(s.appointment_requests) ?? 0) > 0 && str(s.shop_id) !== null);
  let missing = 0;
  const lists = await mapLimit(busy, FAN_OUT, async (s) => {
    const id = str(s.shop_id)!;
    try {
      return requestRows(await voiceGet(`/shops/${encodeURIComponent(id)}`, token, base, fetcher), slugs.get(id) ?? null);
    } catch {
      missing += 1;
      return [];
    }
  });
  const requests = lists
    .flatMap((rows, s) => rows.map((r, i) => ({ ...r, key: `${s}-${i}` })))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const reply: RequestsReply = { configured: true, requests, missing };
  cache = { at: now, reply };
  return reply;
}

/** Test seam: forget the cached requests. */
export const resetRequestsCache = () => { cache = null; };

/** Null when the path is not one of these, so `routes.ts` goes on down its table. */
export async function bookingRoutes(req: ApiRequest, ctx: ApiContext): Promise<ApiReply | null> {
  if (req.path === "/api/bookings/requests") {
    if (req.method !== "GET") return { status: 405, body: { error: "read-only route" } };
    return { status: 200, body: await appointmentRequests((await ctx.store()).read().clients) };
  }
  const action = /^\/api\/bookings\/([\w-]+)\/(script|feedback)$/.exec(req.path);
  if (!action) return null;
  if (req.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
  const store = await ctx.store();
  const shop = store.read().clients.find((c) => c.id === action[1]);
  if (!shop) return { status: 404, body: { error: "no such shop" } };
  const paused = store.company().paused;
  if (action[2] === "script") {
    const result = await requestMeetingScript(shop, { config: ctx.config, paused });
    return result.woke
      ? { status: 202, body: { requested: true } }
      : { status: 503, body: { error: `onboarding could not be asked: ${result.reason ?? "unknown"}` } };
  }
  let body: unknown;
  try { body = JSON.parse(req.body || "{}"); } catch { return { status: 400, body: { error: "the feedback is not JSON" } }; }
  const feedback = cleanFeedback(body);
  if (feedback === null) return { status: 400, body: { error: "write down at least one thing you learned" } };
  const result = await submitCallFeedback(shop, feedback, { addNote: (id, note, next) => store.addClientNote(id, note, next), config: ctx.config, paused });
  if (result === null) return { status: 404, body: { error: "no such shop" } };
  return {
    status: 200,
    body: {
      client: result.client,
      onboarding: result.onboarding.woke ? "woken" : "not_woken",
      ...(result.onboarding.reason ? { onboarding_reason: result.onboarding.reason } : {}),
      voice: result.voice,
    },
  };
}
