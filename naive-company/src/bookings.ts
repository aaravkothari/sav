/**
 * The Bookings page's reading of the CRM: onboarding calls booked between SAV and a shop, the
 * prep script for each one, and the feedback filed after it.
 *
 * Every fact comes from a note with an agreed prefix (`NOTES` in `templates/receptionist.ts`):
 * sales files `CALL REQUESTED: <time as they wrote it>`, client-manager files
 * `CALL BOOKED: <time, zone> <event id or no calendar>` and `MEETING SCRIPT: …`, and the
 * dashboard's own form files `MEETING FEEDBACK: …` once the call is over.
 *
 * Pure functions, no DOM and no LLM: the same notes always give the same bookings and the same
 * prep script, so the page, the server and the tests agree.
 */
import type { Client } from "./data.ts";
import { kindOf, readableWeek, researchText, scrub, shopName } from "./leads.ts";

export const BOOKING_NOTES = {
  requested: "CALL REQUESTED:",
  booked: "CALL BOOKED:",
  script: "MEETING SCRIPT:",
  feedback: "MEETING FEEDBACK:",
} as const;

/** Where an onboarding call is: asked for, on the calendar, or over with notes filed. */
export type CallStatus = "requested" | "booked" | "done";

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  requested: "Requested",
  booked: "Booked",
  done: "Done",
};

export interface OnboardingCall {
  /** 0-based position among this shop's calls, oldest first. Part of the detail page's address. */
  n: number;
  status: CallStatus;
  /** The time as written, without the calendar bookkeeping: "2026-11-09 10:00 PT", "Tuesday afternoon". */
  when: string;
  /** The time as an instant, when the note gives one we can read. */
  at: string | null;
  /** True when the note said a calendar event was made. */
  onCalendar: boolean;
  /** The note index of the booking, and of the feedback that closed it. */
  noteIndex: number;
  feedbackIndex: number | null;
}

// ── Reading a time ───────────────────────────────────────────────────────────

const ZONES: Record<string, string> = {
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pacific: "America/Los_Angeles",
  mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver", mountain: "America/Denver",
  ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago", central: "America/Chicago",
  et: "America/New_York", est: "America/New_York", edt: "America/New_York", eastern: "America/New_York",
  utc: "UTC", gmt: "UTC", z: "UTC",
};
/** SAV works in Pacific time (`AGENCY_TIMEZONE`); a time written without a zone is read in it. */
export const DEFAULT_ZONE = "America/Los_Angeles";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Minutes east of UTC that `zone` is at the instant `utc`. */
function offsetMinutes(utc: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - utc) / 60_000);
}

/** A wall-clock time in a zone, as an instant (DST handled by asking the zone twice). */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, zone: string): number {
  const guess = Date.UTC(y, m, d, h, min);
  const first = guess - offsetMinutes(guess, zone) * 60_000;
  return guess - offsetMinutes(first, zone) * 60_000;
}

/** The calendar day `utc` falls on in `zone`. */
function dayIn(utc: number, zone: string): { y: number; m: number; d: number; wd: number } {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(new Date(utc));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { y: Number(get("year")), m: Number(get("month")) - 1, d: Number(get("day")), wd: WEEKDAYS.indexOf(get("weekday").slice(0, 3).toLowerCase()) };
}

function zoneIn(text: string): string | null {
  const iana = /\b([A-Z][a-z]+\/[A-Z][A-Za-z_]+)\b/.exec(text);
  if (iana) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: iana[1] }); return iana[1]!; } catch { /* not a zone */ }
  }
  const abbr = /(?:\d|\b)(PT|PST|PDT|MT|MST|MDT|CT|CST|CDT|ET|EST|EDT|UTC|GMT|Z|Pacific|Mountain|Central|Eastern)\b/i.exec(text);
  return abbr ? ZONES[abbr[1]!.toLowerCase()] ?? null : null;
}

/** "10am", "2:30 pm", "14:00", "at 3" → hours and minutes; null when no clock time is written. */
function clockIn(text: string): { h: number; min: number } | null {
  const ampm = /\b(\d{1,2})(?::(\d\d))?\s*([ap])\.?\s?m\.?(?![a-z])/i.exec(text);
  if (ampm) {
    const h = Number(ampm[1]) % 12 + (ampm[3]!.toLowerCase() === "p" ? 12 : 0);
    return { h, min: Number(ampm[2] ?? 0) };
  }
  const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  if (h24) return { h: Number(h24[1]), min: Number(h24[2]) };
  if (/\bnoon\b/i.test(text)) return { h: 12, min: 0 };
  // "at 3": a bare hour after "at", read as a working-day hour (8–6), so 3 is 3 pm.
  const at = /\bat\s+(\d{1,2})\b(?!\s*(?:\/|-|st|nd|rd|th))/i.exec(text);
  if (at) {
    const n = Number(at[1]);
    if (n >= 1 && n <= 12) return { h: n < 7 ? n + 12 : n, min: 0 };
  }
  return null;
}

/**
 * The instant a booking note's time names, or null. Reads ISO times (`2026-11-09T10:00-08:00`,
 * `2026-11-09 10:00 PT`), month names (`Nov 9 at 2:30pm`), `11/9 10am`, and a weekday or
 * today/tomorrow with a clock time, resolved against `ref` (when the note was most likely written).
 * A day with no clock time is not a time: it reads as null, and the page shows the words.
 */
export function parseCallTime(text: string, ref: Date = new Date()): string | null {
  const zone = zoneIn(text) ?? DEFAULT_ZONE;
  const iso = /\b(20\d\d)-(\d\d)-(\d\d)(?:[T ]~?(\d\d):(\d\d)(?::\d\d(?:\.\d+)?)?\s?(Z|[+-]\d\d:?\d\d)?)?/.exec(text);
  const clock = clockIn(iso ? text.slice(iso.index + 10) : text) ?? (iso?.[4] ? { h: Number(iso[4]), min: Number(iso[5]) } : null);
  const out = (y: number, m: number, d: number): string | null => {
    if (!clock) return null;
    const t = zonedTime(y, m, d, clock.h, clock.min, zone);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  };
  if (iso) {
    if (iso[4] && iso[6]) {
      const t = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:00${iso[6] === "Z" ? "Z" : iso[6]!.replace(/^([+-]\d\d)(\d\d)$/, "$1:$2")}`);
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    }
    return out(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }
  const refDay = dayIn(ref.getTime(), zone);
  // A date with no year is the next one on or after a week before the note (a call is booked ahead).
  const withYear = (m: number, d: number, y?: number): string | null => {
    if (y) return out(y, m, d);
    let year = refDay.y;
    if (Date.UTC(year, m, d) < Date.UTC(refDay.y, refDay.m, refDay.d) - 7 * 86_400_000) year += 1;
    return out(year, m, d);
  };
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(20\d\d))?/i.exec(text);
  if (named) return withYear(MONTHS.indexOf(named[1]!.slice(0, 3).toLowerCase()), Number(named[2]), named[3] ? Number(named[3]) : undefined);
  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b(?:\s+(20\d\d))?/i.exec(text);
  if (dayFirst) return withYear(MONTHS.indexOf(dayFirst[2]!.slice(0, 3).toLowerCase()), Number(dayFirst[1]), dayFirst[3] ? Number(dayFirst[3]) : undefined);
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(20\d\d|\d\d))?\b/.exec(text);
  if (slash) {
    const y = slash[3] ? (slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3])) : undefined;
    return withYear(Number(slash[1]) - 1, Number(slash[2]), y);
  }
  const plus = (days: number) => {
    const t = Date.UTC(refDay.y, refDay.m, refDay.d) + days * 86_400_000;
    const d = new Date(t);
    return out(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  if (/\btoday\b|\btonight\b/i.test(text)) return plus(0);
  if (/\btomorrow\b/i.test(text)) return plus(1);
  const wd = /\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?\b/i.exec(text);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[1]!.slice(0, 3).toLowerCase());
    let ahead = (target - refDay.wd + 7) % 7;
    if (/\bnext\s+(?:sun|mon|tue|wed|thu|fri|sat)/i.test(text) && ahead === 0) ahead = 7;
    return plus(ahead);
  }
  return null;
}

/** "2026-11-09 10:00 PT, no calendar (…)" → "2026-11-09 10:00 PT": the time without the calendar bookkeeping. */
export function whenText(rest: string): string {
  const first = (rest.split("\n")[0] ?? "").trim();
  const cut = first
    .replace(/[,;(]?\s*\(?\b(?:no calendar|calendar event|google event|event(?:\s+id)?)\b.*$/i, "")
    .replace(/\s*[,;:.—–-]+\s*$/, "")
    .trim();
  return scrub(cut) || "Time not set yet";
}

// ── Reading the bookings ─────────────────────────────────────────────────────

/** Whose note this is, by its prefix. `CALL BOOKED:` and friends must win over the monitor's `CALL:`. */
export function bookingKind(note: string): keyof typeof BOOKING_NOTES | null {
  const t = note.trimStart();
  if (/^CALL REQUESTED\b:?/i.test(t)) return "requested";
  if (/^CALL BOOKED\b:?/i.test(t)) return "booked";
  if (/^MEETING SCRIPT\b:?/i.test(t)) return "script";
  if (/^MEETING FEEDBACK\b:?/i.test(t)) return "feedback";
  return null;
}

const afterPrefix = (note: string): string => note.trimStart().replace(/^[A-Z ]+:?\s*/, "");

/**
 * The onboarding calls a shop's notes record, oldest first. A `CALL REQUESTED:` is a call the shop
 * asked for; a later `CALL BOOKED:` puts that same call on the calendar (it does not add a second
 * one); a `MEETING FEEDBACK:` closes the latest open call. `ref` resolves "Tuesday at 2".
 */
export function callsOf(c: Pick<Client, "notes">, ref: Date = new Date()): OnboardingCall[] {
  const calls: OnboardingCall[] = [];
  c.notes.forEach((note, i) => {
    const kind = bookingKind(note);
    if (kind === "requested" || kind === "booked") {
      const rest = afterPrefix(note);
      const when = rest.trim() === "" ? "Time not set yet" : whenText(rest);
      const fields = { when, at: parseCallTime(when, ref), onCalendar: kind === "booked" && !/\bno calendar\b/i.test(rest) && /\b(?:event|calendar)\b/i.test(rest), noteIndex: i };
      const open = calls[calls.length - 1];
      if (kind === "booked" && open && open.status === "requested") Object.assign(open, fields, { status: "booked" as const });
      else calls.push({ n: calls.length, status: kind, feedbackIndex: null, ...fields });
    } else if (kind === "feedback") {
      const open = [...calls].reverse().find((x) => x.status !== "done");
      if (open) {
        open.status = "done";
        open.feedbackIndex = i;
      }
    }
  });
  return calls;
}

/** The newest `MEETING SCRIPT:` note's text, without its prefix, or null. */
export function scriptNoteOf(c: Pick<Client, "notes">): string | null {
  for (let i = c.notes.length - 1; i >= 0; i -= 1) {
    if (bookingKind(c.notes[i]!) === "script") return afterPrefix(c.notes[i]!).trim();
  }
  return null;
}

export interface BookingRow {
  client: Client;
  call: OnboardingCall;
  scriptReady: boolean;
  /** Upcoming: not done, and either no time yet or a time not more than an hour gone. */
  upcoming: boolean;
}

/** Every onboarding call across the CRM: upcoming first (soonest first, untimed last), then past (newest first). */
export function bookingRows(clients: readonly Client[], now: Date = new Date(), refFor: (c: Client) => Date = () => now): BookingRow[] {
  const rows = clients.flatMap((client) => {
    const scriptReady = scriptNoteOf(client) !== null;
    return callsOf(client, refFor(client)).map((call) => ({
      client,
      call,
      scriptReady,
      upcoming: call.status !== "done" && (call.at === null || Date.parse(call.at) >= now.getTime() - 3_600_000),
    }));
  });
  const time = (r: BookingRow) => (r.call.at ? Date.parse(r.call.at) : null);
  return rows.sort((a, b) => {
    if (a.upcoming !== b.upcoming) return a.upcoming ? -1 : 1;
    const ta = time(a), tb = time(b);
    if (a.upcoming) {
      if (ta === null && tb === null) return a.client.name.localeCompare(b.client.name);
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta - tb;
    }
    return (tb ?? 0) - (ta ?? 0) || a.client.name.localeCompare(b.client.name);
  });
}

/** "Mon, Nov 9, 10:00 AM" in Pacific time, with the zone, or the words as written. */
export function callTimeLabel(call: Pick<OnboardingCall, "at" | "when">, zone = DEFAULT_ZONE): string {
  if (!call.at) return call.when;
  const t = new Date(call.at);
  const day = t.toLocaleDateString("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" });
  const clock = t.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  return `${day}, ${clock} PT`;
}

// ── The prep script, assembled ───────────────────────────────────────────────

export interface ScriptSection {
  heading: string;
  /** Plain lines, shown as a list. */
  items: string[];
  /** The owner's own words, shown as quotes. */
  quotes?: string[];
}

/** What the receptionist service says the shop's receptionist holds, as `/api/shops/:id/receptionist` returns it. */
export interface ScriptReceptionist {
  live: boolean;
  version: number | null;
  first_message: string;
  hours: Record<string, string>;
  services: string[];
  policies: string[];
}

export interface ScriptInput {
  client: Client;
  city: string | null;
  sector: string;
  phone: string | null;
  rating: string | null;
  call: Pick<OnboardingCall, "at" | "when" | "status">;
  /** Replies the shop sent that the inbox holds (full text), newest last. Optional: notes are enough. */
  inboxReplies?: string[];
  /** Null: no receptionist built yet. Undefined: the service was not asked or not reachable. */
  receptionist?: ScriptReceptionist | null;
  /** Calls the receptionist has taken (the owner trying the demo shows up here). */
  demoCalls?: number;
  /** What the receptionist service said when it had nothing to give, in its words. */
  receptionistError?: string;
}

export const PRICE_LINE = "free for 7 days, then $49.99 a month";

const quoteOf = (text: string): string => {
  const t = scrub(text)
    // A quoted thread below the reply is our own email, not theirs.
    .split(/\n\s*On .{4,80}wrote:\s*\n|\n>/)[0]!
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > 600 ? `${t.slice(0, 597).trimEnd()}…` : t;
};

/** The `Opener detail:` line research files, when there is one. */
export function openerDetail(research: string): string | null {
  const m = /Opener detail:\s*([^\n]+)/i.exec(research);
  return m ? m[1]!.trim().replace(/\.$/, "") : null;
}

/** What a reply already tells us they feel: the pain words in their own message. */
const PAIN_WORDS: { re: RegExp; line: string }[] = [
  { re: /\bmiss(?:ed|ing)? (?:a lot of |some |many )?calls?\b|\bcan'?t (?:always )?(?:get to|answer|pick up) the phone\b/i, line: "They mentioned missed calls themselves: ask how many a day, and what a missed call costs them." },
  { re: /\bvoicemail\b/i, line: "They brought up voicemail: ask how often callers leave one versus hang up." },
  { re: /\bafter[- ]hours?\b|\bweekends?\b|\bat night\b/i, line: "They raised after-hours calls: ask what happens to those today." },
  { re: /\bon hold\b|\bhold times?\b/i, line: "They talked about hold times: ask who answers when everyone is in the bay." },
  { re: /\bstaff|front desk|receptionist|short[- ]handed\b/i, line: "They talked about staffing the phone: ask who picks up today and what else that person does." },
];

function hoursGaps(hours: Record<string, string>): string[] {
  const closed = ["sat", "sun"].filter((d) => hours[d] !== undefined && /closed/i.test(hours[d]!));
  const out: string[] = [];
  if (closed.length === 2) out.push("They are closed on weekends: every Saturday and Sunday call goes to voicemail or rings out today.");
  else if (closed.length === 1) out.push(`They are closed on ${closed[0] === "sat" ? "Saturdays" : "Sundays"}: those calls go unanswered today.`);
  const close = Object.values(hours).map((v) => /[-–]\s*(\d{1,2})(?::\d\d)?\s*$/.exec(v)?.[1]).filter(Boolean).map(Number);
  if (close.length > 0 && Math.max(...close) <= 18) out.push("They close by early evening, which is when people off work call to book.");
  return out;
}

/**
 * The meeting script, assembled from what the CRM, the inbox and the receptionist service already
 * know. No model writes any of it: the same facts always give the same script.
 */
export function buildPrepScript(input: ScriptInput): ScriptSection[] {
  const c = input.client;
  const name = shopName(c.name);
  const owner = c.contact.name.trim();
  const first = owner.split(/\s+/)[0] ?? "";
  const notes = c.notes;
  const research = notes.find((n) => kindOf(n).kind === "research") ?? "";
  const researchRest = research ? kindOf(research).rest : "";
  const sections: ScriptSection[] = [];

  // 1. Who
  const who: string[] = [];
  who.push(owner
    ? `${owner}${c.contact.role ? `, ${c.contact.role.toLowerCase()}` : ""}, at ${name}${input.city ? ` in ${input.city}` : ""}.`
    : `${name}${input.city ? ` in ${input.city}` : ""}. We do not have the owner's name yet: ask for it first and who else answers the phone.`);
  who.push(`${input.sector}${input.rating ? `, ${input.rating}` : ""}.`);
  if (input.phone) who.push(`Shop phone: ${input.phone}.`);
  who.push(input.call.status === "requested"
    ? `They asked for a call (${input.call.when}); it is not on the calendar yet.`
    : `The call: ${callTimeLabel(input.call)}, 15 minutes.`);
  sections.push({ heading: "Who you are meeting", items: who });

  // 2. What they said
  const said: string[] = [];
  for (const n of notes) {
    const { kind, rest } = kindOf(n);
    if ((kind === "replied" || kind === "said_yes") && rest.trim() !== "") said.push(quoteOf(rest));
  }
  for (const r of input.inboxReplies ?? []) {
    const q = quoteOf(r);
    if (q !== "" && !said.some((s) => s.slice(0, 80) === q.slice(0, 80))) said.push(q);
  }
  sections.push(said.length > 0
    ? { heading: "What they said", items: [], quotes: said }
    : { heading: "What they said", items: ["Nothing they wrote is on file. Open by asking what made them say yes to a call."] });

  // 3. The shop
  const shop: string[] = [];
  if (researchRest) {
    const text = researchText(researchRest.replace(/\s*Opener detail:[^\n]*/i, "")).trim();
    if (text) shop.push(text);
    const opener = openerDetail(researchRest);
    if (opener) shop.push(`Something to mention: ${opener}.`);
  } else {
    shop.push("Research has not filed anything on this shop yet.");
  }
  if (c.domain && !/[a-z0-9]{20,}/i.test(c.domain)) shop.push(`Website: ${c.domain}.`);
  sections.push({ heading: "What we know about the shop", items: shop });

  // 4. Their receptionist
  const demo: string[] = [];
  const r = input.receptionist;
  const built = notes.some((n) => ["demo_built", "live"].includes(kindOf(n).kind));
  if (r === null || (r === undefined && !built)) {
    demo.push("No receptionist has been built for them yet. Offer to set one up during the call.");
  } else if (r === undefined) {
    demo.push(input.receptionistError
      ? `Our notes say a preview receptionist was built for them, but it did not answer: ${input.receptionistError.replace(/\.$/, "").replace(/^The receptionist service/, "the receptionist service")}. Check it before the call.`
      : "A preview receptionist is built for them; the receptionist service could not be asked for its details just now.");
  } else {
    demo.push(r.live
      ? `Their receptionist is live and answering calls${r.version !== null ? ` (version ${r.version})` : ""}.`
      : `A preview receptionist is built for them${r.version !== null ? ` (version ${r.version})` : ""}. It says it is a preview and books nothing.`);
    if (input.demoCalls !== undefined) {
      demo.push(input.demoCalls > 0
        ? `It has taken ${input.demoCalls} call${input.demoCalls === 1 ? "" : "s"}. Ask what they thought when they tried it.`
        : "Nobody has called it yet. Offer to call it together on this call.");
    }
    if (r.first_message) demo.push(`It answers: "${r.first_message}"`);
    demo.push(Object.keys(r.hours).length > 0 ? `Hours it knows: ${readableWeek(r.hours)}.` : "It has no hours yet.");
    demo.push(r.services.length > 0 ? `Services it knows: ${r.services.join(", ")}.` : "It has no list of services yet.");
    if (r.policies.length > 0) demo.push(`Rules it follows: ${r.policies.join(" ")}`);
  }
  sections.push({ heading: "Their receptionist", items: demo });

  // 5. Pain points
  const pain: string[] = [];
  const theirWords = said.join("\n");
  for (const p of PAIN_WORDS) if (p.re.test(theirWords)) pain.push(p.line);
  const towing = /tow/i.test(input.sector);
  pain.push(towing
    ? "Missed dispatch calls: a stranded driver who reaches voicemail calls the next tow company on the list."
    : "Missed calls while everyone is under a car: a caller who reaches voicemail usually calls the next shop.");
  if (r && Object.keys(r.hours).length > 0) pain.push(...hoursGaps(r.hours));
  else pain.push("After-hours calls: evenings and weekends are when people off work call to book.");
  if (/\b(?:4\.\d|5\.0)\b.*reviews|\b[\d,]{3,}\s+(?:Google\s+)?reviews/i.test(researchRest)) pain.push("A busy, well-reviewed shop: the phone rings most when the bays are full.");
  sections.push({ heading: "Likely pain points", items: pain });

  // 6. Questions
  const known = r && Object.keys(r.hours).length > 0 ? ` We have ${readableWeek(r.hours)}: is that right?` : "";
  sections.push({
    heading: "Questions to ask",
    items: [
      `What are your hours, day by day?${known}`,
      "Which services do you offer, and how long does each one usually take?",
      `How should the phone be answered? (${r?.first_message ? "Read them the current greeting and ask what they would change." : "The exact greeting."})`,
      "Booking rules: how far ahead do you book, how many cars a day, and what always needs a call-back?",
      "Who gets urgent hand-offs, and by text, call or email?",
      "How do you book today: paper, a calendar, shop software?",
      "Which line should forward to the receptionist, and when: always, after a few rings, or only after hours?",
    ],
  });

  // 7. Close
  sections.push({
    heading: "The close",
    items: [
      `Offer the free week: ${PRICE_LINE}.`,
      "After the call they get a Stripe checkout link by email; nothing is charged for 7 days and they can cancel before then.",
      first ? `Confirm the best email and cell for ${first}, and tell them when the receptionist will be ready.` : "Confirm the best email and cell for the owner, and tell them when the receptionist will be ready.",
    ],
  });
  return sections;
}

/** A section list as plain text, for copying into a notes app. */
export function scriptText(sections: readonly ScriptSection[]): string {
  return sections.map((s) => [s.heading.toUpperCase(), ...(s.quotes ?? []).map((q) => `"${q}"`), ...s.items.map((i) => `- ${i}`)].join("\n")).join("\n\n");
}

/**
 * A `MEETING SCRIPT:` note, as sections a person reads: a short line ending in ":" or written in
 * capitals, or a markdown heading, starts a section; "-", "*", "•" and "1." lines are its items;
 * anything else is a line of its own. Machine ids are taken out.
 */
export function formatScriptNote(text: string): ScriptSection[] {
  const sections: ScriptSection[] = [];
  let current: ScriptSection = { heading: "", items: [] };
  const push = () => { if (current.heading !== "" || current.items.length > 0) sections.push(current); };
  for (const raw of scrub(text).split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const heading = /^#{1,4}\s+(.+)$/.exec(line)?.[1]
      ?? (/^\*\*(.+?)\*\*:?$/.exec(line)?.[1])
      ?? (line.length <= 60 && /:$/.test(line) && !/^[-*•\d]/.test(line) ? line.slice(0, -1) : undefined)
      ?? (line.length <= 60 && /^[A-Z][A-Z0-9 ,&/'()-]{2,}$/.test(line) ? line : undefined);
    if (heading !== undefined) {
      push();
      const h = heading.replace(/\*\*/g, "").trim();
      current = { heading: /^[A-Z0-9 ,&/'()-]+$/.test(h) ? h[0]! + h.slice(1).toLowerCase() : h, items: [] };
      continue;
    }
    // "Who: Pat Banks, owner" on one line: a heading and its item together.
    const inline = /^([A-Z][A-Za-z /&]{2,30}):\s+(.+)$/.exec(line);
    if (inline && current.items.length === 0 && current.heading === "" ) {
      push();
      current = { heading: inline[1]!, items: [inline[2]!] };
      continue;
    }
    current.items.push(line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1"));
  }
  push();
  return sections;
}

// ── After the call ───────────────────────────────────────────────────────────

/** What the operator learned on the call. Every field is optional; at least one must say something. */
export interface CallFeedback {
  hours?: string;
  services?: string;
  greeting?: string;
  booking_rules?: string;
  handoff?: string;
  fixes?: string;
  notes?: string;
}

export const FEEDBACK_FIELDS: { key: keyof CallFeedback; label: string; hint: string }[] = [
  { key: "hours", label: "Hours", hint: "Changes to their hours, day by day" },
  { key: "services", label: "Services and how long they take", hint: "Oil change 30 min, brakes 2 h…" },
  { key: "greeting", label: "Greeting", hint: "How they want the phone answered" },
  { key: "booking_rules", label: "Booking rules", hint: "How far ahead, cars a day, what needs a call-back" },
  { key: "handoff", label: "Urgent hand-off", hint: "Who to reach, and how" },
  { key: "fixes", label: "What the receptionist should say differently", hint: "Anything it got wrong on the demo" },
  { key: "notes", label: "Anything else", hint: "Free notes from the call" },
];

export const FEEDBACK_MAX = 2000;

/** The feedback trimmed to the fields that say something, each capped; null when nothing does. */
export function cleanFeedback(raw: unknown): CallFeedback | null {
  if (typeof raw !== "object" || raw === null) return null;
  const out: CallFeedback = {};
  for (const { key } of FEEDBACK_FIELDS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim() !== "") out[key] = v.trim().slice(0, FEEDBACK_MAX);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The feedback as readable lines, "Hours: …", one per field, in the form's order. */
export function feedbackLines(f: CallFeedback): string[] {
  return FEEDBACK_FIELDS.filter(({ key }) => f[key]).map(({ key, label }) => `${label}: ${f[key]!.replace(/\s*\n\s*/g, " / ")}`);
}
