/**
 * After an onboarding call: what Aarav learned goes to the shop's record and to onboarding, and
 * (once its endpoint exists) to the voice server, so the receptionist ends up saying what the
 * owner asked for.
 *
 * One function, `submitCallFeedback(shop, feedback)`, is the whole adapter. Today it
 *   (a) files a `MEETING FEEDBACK:` note on the shop, the fields as readable lines;
 *   (b) wakes `client-manager` with a message starting `MEETING FEEDBACK:` and the shop's
 *       client_id, asking for one `RECEPTIONIST CONFIG:` note (the format the booking seat applies);
 *   (c) has a marked slot for the voice server's feedback endpoint (BeigeElk, autoops-voice), whose
 *       contract is not settled yet.
 *
 * `requestMeetingScript` wakes the same seat for a fuller `MEETING SCRIPT:` note. Both wake the
 * seat the way the server already starts sessions (`POST /v1/sessions` through `proxyFetch`).
 */
import type { Client } from "../seed/clients.ts";
import { feedbackLines, type CallFeedback } from "../src/bookings.ts";
import { shopName } from "../src/leads.ts";
import { EVENTS, NOTES, PROTECTED_SHOPS } from "../templates/receptionist.ts";
import { proxyFetch, type ProxyConfig } from "./proxy.ts";
import { callAutoops, shopIdOf } from "./shop-routes.ts";

/** `client-manager`'s platform id (AGENTS.md, integration contract). `CLIENT_MANAGER_AGENT_ID` overrides it. */
export const CLIENT_MANAGER_ID = "agt_wnnf7kyvhcj6v9nbsbnw9pt4dp";

export interface FeedbackDeps {
  /** Files a note on the shop; the store's `addClientNote`. */
  addNote(id: string, note: string, nextAction?: string): Client | null;
  /** The org's platform config, or null when this server has no key (the note still lands). */
  config: ProxyConfig | null;
  /** True while the company is paused: nothing is woken, the note still lands. */
  paused?: boolean;
  agentId?: string;
  fetchImpl?: typeof fetch;
  /** The voice server's fetch (separate from the platform's). */
  voiceFetchImpl?: typeof fetch;
  now?: Date;
}

export interface WakeResult {
  woke: boolean;
  /** Why nothing was woken, in a sentence a person reads. */
  reason?: string;
}

const agentId = (deps: Pick<FeedbackDeps, "agentId">): string =>
  deps.agentId ?? (typeof process === "undefined" ? undefined : process.env.CLIENT_MANAGER_AGENT_ID?.trim()) ?? CLIENT_MANAGER_ID;

/** Start one `client-manager` session with `message`. Never throws: a failed wake is a reason. */
export async function wakeClientManager(message: string, deps: Pick<FeedbackDeps, "config" | "paused" | "agentId" | "fetchImpl">): Promise<WakeResult> {
  if (deps.config === null) return { woke: false, reason: "the platform is not connected on this server" };
  if (deps.paused) return { woke: false, reason: "the company is paused" };
  try {
    const res = await proxyFetch(deps.config, { method: "POST", path: "/v1/sessions" },
      JSON.stringify({ agent_id: agentId(deps), message }), deps.fetchImpl);
    return res.ok ? { woke: true } : { woke: false, reason: `the platform answered ${res.status}` };
  } catch {
    return { woke: false, reason: "the platform could not be reached" };
  }
}

/** The `MEETING FEEDBACK:` note, as filed on the shop. */
export function feedbackNote(shop: Pick<Client, "name">, feedback: CallFeedback, now: Date): string {
  return [`${NOTES.meetingFeedback} onboarding call with ${shopName(shop.name)}, filed ${now.toISOString().slice(0, 16)}Z`, ...feedbackLines(feedback)].join("\n");
}

/** The message that wakes client-manager with the feedback. */
export function feedbackMessage(shop: Pick<Client, "id" | "name" | "notes">, feedback: CallFeedback): string {
  const voice = shopIdOf(shop);
  return [
    `${EVENTS.meetingFeedback} ${shopName(shop.name)}`,
    `client_id: ${shop.id}`,
    ...(voice ? [`shop_id: ${voice}`] : []),
    "",
    "Aarav just finished the onboarding call. What he learned:",
    ...feedbackLines(feedback),
    "",
    `Turn this into one "${NOTES.config}" note on this shop: JSON with keys hours, services, greeting, booking_rules, handoff, taken only from this feedback and the shop's earlier answers; leave a key out rather than guess. Put what the receptionist should say differently into booking_rules as one rule per string, and a new greeting into greeting. Send no email and change no receptionist: the booking seat applies the config.`,
  ].join("\n");
}

/** The message that asks client-manager for a fuller meeting script. */
export function scriptMessage(shop: Pick<Client, "id" | "name">): string {
  return [
    `${EVENTS.writeScript} ${shopName(shop.name)}`,
    `client_id: ${shop.id}`,
    "",
    `Aarav asked for a fuller script for his onboarding call with this shop. Read its notes, the inbox thread and its receptionist, then file exactly one "${NOTES.meetingScript}" note: who the owner is and their role; what they said, quoted; likely pain points; demo status; the questions to ask; and the close. Short headed sections, one point per line. Send no email.`,
  ].join("\n");
}

export interface FeedbackResult {
  /** The shop with the note filed. */
  client: Client;
  /** (b): whether client-manager was woken. */
  onboarding: WakeResult;
  /** (c): the shop's call_instructions on the voice server. `not_connected` until autoops-voice #13 is live. */
  voice: "sent" | "not_connected" | "failed";
}

/** The voice server caps a shop's call_instructions at this many characters (autoops-voice #13). */
export const CALL_INSTRUCTIONS_MAX = 1500;

/**
 * What the owner told us on the call, in their words, merged into the shop's existing
 * call_instructions: the newest call goes last, and when the total passes the cap the oldest text
 * goes first. Plain lines, no markdown headings (the voice server strips `#`).
 */
export function mergeCallInstructions(existing: string | null | undefined, lines: readonly string[], now: Date): string {
  const block = [`From the onboarding call on ${now.toISOString().slice(0, 10)}:`, ...lines].join("\n");
  const merged = [(existing ?? "").trim(), block].filter((x) => x !== "").join("\n\n");
  return merged.length <= CALL_INSTRUCTIONS_MAX ? merged : merged.slice(merged.length - CALL_INSTRUCTIONS_MAX).replace(/^[^\n]*\n/, "");
}

/**
 * (c) The voice server's per-business call instructions (autoops-voice #13, BeigeElk): free text,
 * at most 1500 characters, rendered last in the receptionist's prompt under a fence that keeps the
 * fixed rules on top, live on the next call. The operator submits this form, so the dashboard writes
 * it as a person, server-side, with update_receptionist({ shop_id, call_instructions }). No crew seat
 * writes call_instructions on its own: the approval sweep parks those calls.
 *
 * Feature-detected: until #13 is live, get_receptionist has no call_instructions field and this
 * answers "not_connected", so only (a) and (b) happen. Never for the frozen stage demos.
 */
export async function sendFeedbackToVoice(voiceShopId: string | null, feedback: CallFeedback, deps: Pick<FeedbackDeps, "voiceFetchImpl" | "now">): Promise<FeedbackResult["voice"]> {
  if (voiceShopId === null || (PROTECTED_SHOPS as readonly string[]).includes(voiceShopId)) return "not_connected";
  const lines = feedbackLines(feedback);
  if (lines.length === 0) return "not_connected";
  try {
    const current = (await callAutoops("get_receptionist", { shop_id: voiceShopId }, undefined, deps.voiceFetchImpl)) as { call_instructions?: string | null } | null;
    if (current === null || typeof current !== "object" || !("call_instructions" in current)) return "not_connected";
    const call_instructions = mergeCallInstructions(current.call_instructions, lines, deps.now ?? new Date());
    await callAutoops("update_receptionist", { shop_id: voiceShopId, call_instructions }, undefined, deps.voiceFetchImpl);
    return "sent";
  } catch (e) {
    // No voice token on this server: the voice side is simply not connected here.
    return /not configured/.test(String((e as Error)?.message)) ? "not_connected" : "failed";
  }
}

/**
 * After the call. (a) always lands when the shop exists; (b) and (c) are best-effort and say how
 * they went. Null when the shop is not in the CRM.
 */
export async function submitCallFeedback(shop: Client, feedback: CallFeedback, deps: FeedbackDeps): Promise<FeedbackResult | null> {
  const now = deps.now ?? new Date();
  const client = deps.addNote(shop.id, feedbackNote(shop, feedback, now), "Onboarding turns the call notes into the receptionist's setup");
  if (client === null) return null;
  const onboarding = await wakeClientManager(feedbackMessage(shop, feedback), deps);
  // (c) The shop's call_instructions, written as the operator (see `sendFeedbackToVoice`).
  const voice = await sendFeedbackToVoice(shopIdOf(shop), feedback, { voiceFetchImpl: deps.voiceFetchImpl, now });
  return { client, onboarding, voice };
}

/** One script request per shop per ten minutes: a double click must not start two sessions. */
const SCRIPT_COOLDOWN_MS = 10 * 60_000;
const scriptAsked = new Map<string, number>();

export async function requestMeetingScript(shop: Client, deps: Pick<FeedbackDeps, "config" | "paused" | "agentId" | "fetchImpl" | "now">): Promise<WakeResult & { already?: boolean }> {
  const now = (deps.now ?? new Date()).getTime();
  const last = scriptAsked.get(shop.id);
  if (last !== undefined && now - last < SCRIPT_COOLDOWN_MS) return { woke: true, already: true };
  const result = await wakeClientManager(scriptMessage(shop), deps);
  if (result.woke) scriptAsked.set(shop.id, now);
  return result;
}

/** Test seam. */
export const resetScriptRequests = () => scriptAsked.clear();
