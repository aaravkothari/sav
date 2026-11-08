/**
 * What the crew has done with each shop, read back out of its CRM notes.
 *
 * Every agent writes plain-text notes with an agreed prefix (`AGENTS.md`, `templates/receptionist.ts`):
 * research files `RESEARCH:`, the demo build files `RECEPTIONIST:` (or the worker's "Demo receptionist
 * built"), sales files `OUTREACH SENT` / `REPLY RECEIVED` / `REPLY SENT` / `SAID YES:`, the free-week
 * form files `FREE WEEK STARTED`, billing files `PAID:`, and a bounce is `BOUNCED:`. This module turns
 * those notes into the few facts a person wants on a screen: where the shop is in the funnel, what
 * happened in what order, and where and what kind of business it is.
 *
 * Pure functions, no DOM, so the table, the board, the shop page and the tests all read the same
 * answer.
 */
import type { Client } from "./data.ts";

/** The funnel, in the order a shop moves through it. */
export const STATUSES = ["researched", "emailed", "replied", "demo", "free_week", "paying"] as const;
export type LeadStatus = (typeof STATUSES)[number] | "bounced" | "new";

export const STATUS_LABEL: Record<LeadStatus, string> = {
  researched: "Researched",
  emailed: "Emailed",
  replied: "Replied",
  demo: "Demo sent",
  free_week: "Free week",
  paying: "Paying",
  bounced: "Bounced",
  new: "New",
};

/** The kind of event one note records, or `note` for anything without a prefix we know. */
export type EventKind =
  | "research"
  | "demo_built"
  | "drafted"
  | "emailed"
  | "bounced"
  | "replied"
  | "reply_sent"
  | "said_yes"
  | "onboarding"
  | "free_week"
  | "config"
  | "live"
  | "call"
  | "operator_called"
  | "paid"
  | "skipped"
  | "blocked"
  | "note";

export interface LeadEvent {
  kind: EventKind;
  /** A short plain-English headline: "Emailed Pat Banks". */
  title: string;
  /** The note's text after its prefix line, with message ids and other machine detail removed. */
  body: string;
  /** A time written inside the note, when there is one. Most notes carry none. */
  at: string | null;
  /** Position in the notes, so undated events keep their order. */
  index: number;
}

const PREFIXES: { kind: EventKind; re: RegExp }[] = [
  { kind: "config", re: /^RECEPTIONIST CONFIG\b:?/i },
  { kind: "live", re: /^RECEPTIONIST:\s*live\b/i },
  { kind: "demo_built", re: /^RECEPTIONIST\b:?/i },
  { kind: "demo_built", re: /^Demo receptionist built\b/i },
  { kind: "research", re: /^RESEARCH\b:?/i },
  { kind: "drafted", re: /^OUTREACH DRAFTED\b:?/i },
  { kind: "skipped", re: /^OUTREACH SKIPPED\b:?/i },
  { kind: "emailed", re: /^OUTREACH SENT\b:?/i },
  { kind: "bounced", re: /^BOUNCED\b:?/i },
  { kind: "replied", re: /^REPLY RECEIVED\b:?/i },
  { kind: "reply_sent", re: /^REPLY SENT\b:?/i },
  { kind: "free_week", re: /^FREE WEEK STARTED\b:?/i },
  { kind: "free_week", re: /^SAID YES:\s*started a free week\b/i },
  { kind: "said_yes", re: /^SAID YES\b:?/i },
  { kind: "onboarding", re: /^ONBOARDING SENT\b:?/i },
  { kind: "blocked", re: /^ONBOARDING BLOCKED\b:?/i },
  { kind: "operator_called", re: /^OPERATOR CALLED\b:?/i },
  { kind: "call", re: /^CALL\b:?/i },
  { kind: "paid", re: /^PAID\b:?/i },
];

export function kindOf(note: string): { kind: EventKind; rest: string } {
  const text = note.trimStart();
  for (const { kind, re } of PREFIXES) {
    const m = re.exec(text);
    if (m) return { kind, rest: text.slice(m[0].length).trim() };
  }
  return { kind: "note", rest: text.trim() };
}

/** Message ids, UUIDs, thread ids and voice shop ids are the agents' bookkeeping, not the reader's. */
export function scrub(text: string): string {
  return text
    .replace(/<[^<>\s]+@[^<>\s]+>/g, "")
    .replace(/\b(?:message id|thread|voice shop_id|shop_id|call_id|id)\s*[:=]?\s*[0-9a-f]{8}-[0-9a-f-]{27,}\b\.?/gi, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/\(\s*voice shop_id [\w-]+\s*\)/gi, "")
    .replace(/\bshop_id\s*[:=]?\s*["']?[\w-]+["']?[,;]?/gi, "")
    .replace(/\b(?:cli|ses|agt|msg|dep|idn|tok)_[A-Za-z0-9]+\b/g, "")
    .replace(/[?&]t=[0-9a-f]{16,}/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]*[—–-]\s*/, "")
    .split("\n").filter((line) => !/^\s*[.,;:—–-]+\s*$/.test(line)).join("\n")
    .trim();
}

/**
 * A time written inside a note: `2026-11-08T04:20Z` or `2026-11-08 ~04:20Z`. A bare date is not
 * taken: research notes quote dates about the shop ("valid as of 2026-10-26") that are not when
 * anything happened.
 */
export function timeIn(text: string): string | null {
  const m = /\b(20\d\d-\d\d-\d\d)[ T]~?(\d\d:\d\d)(?::\d\d(?:\.\d+)?)?\s?(Z|[+-]\d\d:?\d\d)?/.exec(text);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:00${m[3] ?? "Z"}`;
  return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
}

const firstName = (c: Client) => c.contact.name.trim().split(/\s+/)[0] || "the shop";

function titleFor(kind: EventKind, c: Client, rest: string): string {
  const who = c.contact.name.trim() || shopName(c.name);
  switch (kind) {
    case "research": return "Researched";
    case "demo_built": return "Demo receptionist ready";
    case "drafted": return `Drafted a first email to ${who}`;
    case "skipped": return "Outreach skipped";
    case "emailed": return `Emailed ${who}`;
    case "bounced": return `Email to ${shopName(c.name)} bounced`;
    case "replied": return `${firstName(c) === "the shop" ? shopName(c.name) : firstName(c)} replied`;
    case "reply_sent": return /\/demo\//.test(rest) ? "Replied with the demo link" : "Replied";
    case "said_yes": return `${firstName(c) === "the shop" ? shopName(c.name) : firstName(c)} said yes`;
    case "onboarding": return /\bsent\b/i.test(rest) && !/drafted|awaits/i.test(rest) ? "Sent the setup questions" : "Drafted the setup questions";
    case "blocked": return "Onboarding is blocked";
    case "free_week": return "Started a free week";
    case "config": return "Receptionist set up from the owner's answers";
    case "live": return "Receptionist is live";
    case "call": return "A call came in";
    case "operator_called": return "You called the shop";
    case "paid": return "Became a paying customer";
    case "note": return "Note";
  }
}

/** Drop the bookkeeping first line of an outreach note ("<id> to pat@x.com") and keep the email. */
function bodyFor(kind: EventKind, rest: string): string {
  // A bounce is a fact, not a message to read: the SMTP report and the returned email stay out.
  // The demo note is a path and a mode; the timeline links it instead (`demoLink`).
  if (kind === "bounced" || kind === "demo_built") return "";
  if (kind === "research") return researchText(rest);
  let text = rest;
  if (kind === "emailed" || kind === "drafted" || kind === "reply_sent") {
    const [first, ...others] = text.split("\n");
    if (others.length > 0 && /^[\w-]*\s*(to\s+\S+@\S+)?(\s+from\s+\S+@\S+)?\s*$/i.test(scrub(first ?? ""))) text = others.join("\n");
  }
  return scrub(text);
}

export function eventsOf(c: Client): LeadEvent[] {
  const events = c.notes.map((note, index) => {
    const { kind, rest } = kindOf(note);
    return { kind, title: titleFor(kind, c, rest), body: bodyFor(kind, rest), at: timeIn(note), index };
  });
  // One bounce is one fact: the engine can file the returned email and the bounce report as two notes.
  return events.filter((e, i) => e.kind !== "bounced" || !events.slice(0, i).some((x) => x.kind === "bounced"));
}

/** The demo page path or URL a `RECEPTIONIST:` note carries (`/demo/<slug>`), or null. */
export function demoPathOf(note: string): string | null {
  const m = /\bdemo_url\s*[:=]?\s*(https?:\/\/\S+?\/demo\/[\w-]+|\/demo\/[\w-]+)/i.exec(note) ?? /(https?:\/\/\S+?\/demo\/[\w-]+)/.exec(note);
  return m ? m[1]! : null;
}

/** The demo page as a link: an absolute URL as written, a bare path on the voice service's base, or null. */
export function demoLink(note: string, base: string | null | undefined): string | null {
  const path = demoPathOf(note);
  if (path === null) return null;
  if (/^https?:\/\//.test(path)) return path;
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}${path}`;
}

// ── Readable research ────────────────────────────────────────────────────────

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAME: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** `17:00` → "5", `8:30` → "8:30", `12:00` → "12": clock times as a shop's door sign writes them. */
export function clock(t: string): string {
  const m = /^(\d{1,2})(?::(\d\d))?$/.exec(t.trim());
  if (!m) return t.trim();
  const h = Number(m[1]) % 24;
  const hour = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return m[2] && m[2] !== "00" ? `${hour}:${m[2]}` : String(hour);
}

/** `8:30-17:00` → "8:30–5"; `closed` stays "closed"; anything else is kept as written. */
export function hoursRange(value: string): string {
  const v = value.trim();
  if (/^closed$/i.test(v)) return "closed";
  return v.split(/\s*[,&]\s*/).map((part) => {
    const m = /^(\d{1,2}(?::\d\d)?)\s*[-–]\s*(\d{1,2}(?::\d\d)?)$/.exec(part);
    return m ? `${clock(m[1]!)}–${clock(m[2]!)}` : part;
  }).join(", ");
}

/** A week of hours keyed `mon..sun`, as one line: "Mon–Fri 8:30–5, Sat–Sun closed". */
export function readableWeek(hours: Record<string, string>): string {
  const groups: { from: number; to: number; value: string }[] = [];
  WEEK.forEach((d, i) => {
    if (hours[d] === undefined) return;
    const value = hoursRange(hours[d]!);
    const last = groups[groups.length - 1];
    if (last && last.value === value && last.to === i - 1) last.to = i;
    else groups.push({ from: i, to: i, value });
  });
  return groups.map((g) => `${DAY_NAME[WEEK[g.from]!]}${g.to !== g.from ? `–${DAY_NAME[WEEK[g.to]!]}` : ""} ${g.value}`).join(", ");
}

/** `Hours: mon 8:30-17:00; tue …; sun closed` inside a note, parsed; null when the note words them freely. */
function hoursIn(text: string): { match: string; week: Record<string, string> } | null {
  const m = /Hours:?\s*((?:mon|tue|wed|thu|fri|sat|sun)\s+[^;\n]+?(?:;\s*(?:mon|tue|wed|thu|fri|sat|sun)\s+[^;\n]+?)*)(?:\.\s|\.?$|\.?\n)/im.exec(text);
  if (!m) return null;
  const week: Record<string, string> = {};
  for (const part of m[1]!.split(/;\s*/)) {
    const d = /^(mon|tue|wed|thu|fri|sat|sun)\s+(.+)$/i.exec(part.trim());
    if (d) week[d[1]!.toLowerCase()] = d[2]!.trim();
  }
  return Object.keys(week).length > 0 ? { match: m[0], week } : null;
}

const sentence = (s: string): string => {
  const t = s.trim().replace(/\s+/g, " ");
  if (t === "") return "";
  const up = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?)"'”]$/.test(up) ? up : `${up}.`;
};

/**
 * A research note as plain sentences: the hours as a readable week, and the crew's labels
 * ("Opener detail:", "Fit:", "Why it fits:", "Sector:", "RESEARCH:") taken off their content.
 */
export function researchText(rest: string): string {
  let text = rest.replace(/\bRESEARCH:\s*/g, "");
  const hours = hoursIn(text);
  if (hours) text = text.replace(hours.match, `Hours: ${readableWeek(hours.week)}.${/\n$/.test(hours.match) ? "\n" : " "}`);
  // Hours worded freely ("Hours Mon–Fri 8–17, closed weekends"): the 24-hour times read as a sign would.
  else text = text.replace(/(Hours:?\s)([^.\n]*?\d[^.\n]*)/i, (_m, label: string, span: string) =>
    label + span.replace(/\b(\d{1,2}(?::\d\d)?)\s*[-–]\s*(\d{1,2}(?::\d\d)?)\b/g, (_r, a: string, b: string) => `${clock(a)}–${clock(b)}`));
  const lines = text.split("\n")
    .filter((line) => !/^\s*(?:Sector|City):/i.test(line))
    .map((line) => line.replace(/(^|[.;]\s+)(?:Why it fits|Fits?|Opener detail|Opener):\s*(\S)/gi, (_m, lead: string, ch: string) => lead + ch.toUpperCase()))
    .map(sentence)
    .filter((line) => line !== "");
  return scrub(lines.join(" "));
}

// ── Display names, next steps, addresses ─────────────────────────────────────

/**
 * A shop's name without the SEO tail its listing carries: "A-1 Imports Autoworks - Auto Repair
 * Shop In San Rafael" → "A-1 Imports Autoworks". Display only; the CRM keeps the name as filed.
 */
export function shopName(name: string): string {
  let n = name.trim();
  // "Name - City Auto Repair for …", "Name | Best mechanic", "Name – Concord": the part before the dash.
  const parts = n.split(/\s+[-–—|]\s+/);
  if (parts.length > 1 && parts[0]!.length >= 3) n = parts[0]!;
  // "Name, Complete Automotive Repair": a comma tail that only names the trade.
  n = n.replace(/,\s+(?:complete\s+|full[- ]service\s+)?(?:auto(?:motive)?|car)\b[^,]*$/i, "");
  // "… Shop in San Jose, Ca." / "… in San Rafael": a trailing "in <City>[, ST]".
  n = n.replace(/\s+(?:shop\s+)?in\s+[A-Z][A-Za-z .'-]+?(?:,\s*(?:CA|Ca|California)\.?)?\.?$/i, "");
  return n.trim() || name.trim();
}

const AGENT_TEXT = /[\w.+-]+@[\w-]+\.[\w.]+|\bfile (?:them|it|this|that) as\b|RECEPTIONIST CONFIG|\b(?:OUTREACH|REPLY|RESEARCH|RECEPTIONIST|ONBOARDING|SAID YES|FREE WEEK|BOUNCED|PAID|CALL)\b[A-Z —-]*:|\b(?:cli|ses|agt|crd)_\w+|\bshop_id\b|\b(?:autoops|dashboard|agentmail)\.\w+|\bmove (?:it |them )?to active\b/;

/**
 * The CRM's "next step" as a person reads it. The crew writes it as an instruction to the next
 * agent ("Waiting for Pat's answers in <inbox> — file them as RECEPTIONIST CONFIG…"); that is shown
 * as the short human version instead.
 */
export function nextStepText(text: string | null | undefined): string | null {
  const s = (text ?? "").trim();
  if (s === "") return null;
  if (!AGENT_TEXT.test(s)) return s;
  if (/\banswers?\b/i.test(s)) return "Waiting for the owner's setup answers";
  if (/\brepl(?:y|ies)\b/i.test(s)) return "Waiting for a reply";
  if (/\bonboard/i.test(s)) return "Onboarding the shop";
  if (/\bdraft/i.test(s)) return "Writing the next email";
  return "The crew has the next step";
}

/** The shop page's address: `/leads/<slug>`, or the id for a row filed without a slug. */
export const leadPath = (c: Pick<Client, "id" | "slug">): string => `/leads/${encodeURIComponent(c.slug || c.id)}`;

/** The lead a `/leads/:id` address names: by slug, or by the `cli_…` id older links carry. */
export function findLead<T extends { client: Pick<Client, "id" | "slug"> }>(leads: readonly T[], param: string): T | undefined {
  let key = param;
  try { key = decodeURIComponent(param); } catch { /* a malformed escape is looked up as written */ }
  return leads.find((l) => l.client.slug === key) ?? leads.find((l) => l.client.id === key);
}

export interface Lead {
  client: Client;
  status: LeadStatus;
  /** The furthest step reached, ignoring a bounce, for sorting. */
  rank: number;
  city: string | null;
  sector: string;
  phone: string | null;
  rating: string | null;
  demoReady: boolean;
  /** The newest time any note or email gives us for this shop. */
  lastAt: string | null;
  /** What the last thing that happened was, in words. */
  lastEvent: string | null;
  events: LeadEvent[];
}

/** The rank each event kind proves, on the funnel `STATUSES`. */
const REACHES: Partial<Record<EventKind, number>> = {
  research: 0,
  emailed: 1,
  bounced: 1,
  replied: 2,
  said_yes: 2,
  config: 4,
  free_week: 4,
  live: 4,
  paid: 5,
};

export function statusOf(c: Client, events = eventsOf(c)): { status: LeadStatus; rank: number } {
  let rank = 0;
  for (const e of events) {
    const r = REACHES[e.kind];
    if (r !== undefined && r > rank) rank = r;
    // A reply that carried the demo link is the demo step.
    if (e.kind === "reply_sent" && /\/demo\//.test(c.notes[e.index] ?? "") && rank < 3) rank = 3;
  }
  // A shop the operator moved to active is at least on its free week.
  if (c.stage === "active" && rank < 4) rank = 4;
  const bounced = events.some((e) => e.kind === "bounced") && rank <= 1;
  return { status: bounced ? "bounced" : STATUSES[rank]!, rank };
}

const SF_ZIPS = /\b941\d\d\b/;

/** The city from a street address in the research note, or the worker's `City:` line. */
export function cityOf(c: Client): string | null {
  const text = c.notes.join("\n");
  const tagged = /\bCity:\s*([A-Z][A-Za-z .'-]+?)\s*(?:\n|$|\.)/.exec(text);
  if (tagged) return tagged[1]!.trim();
  const addr = /,\s*([A-Z][A-Za-z .'-]{2,30}?),\s*(?:CA|California|[A-Z]{2})\b\s*\d{5}/.exec(text);
  if (addr) return addr[1]!.trim();
  if (SF_ZIPS.test(text)) return "San Francisco";
  return null;
}

export function sectorOf(c: Client): string {
  const research = c.notes.find((n) => kindOf(n).kind === "research") ?? "";
  const tagged = /(?:^|\n|[.;]\s+)Sector:\s*([^\n.;]+)/i.exec(research)?.[1]?.trim();
  if (tagged && !/^auto\b/i.test(tagged)) return tagged.replace(/\b\w/g, (ch) => ch.toUpperCase());
  const head = `${c.name} ${research.slice(0, 120)}`.toLowerCase();
  if (/\btow(ing)?\b|roadside/.test(head)) return "Towing";
  if (/collision|body shop|auto body/.test(head)) return "Body & collision";
  if (/\bsmog\b/.test(c.name.toLowerCase())) return "Smog & repair";
  if (/\btires?\b/.test(c.name.toLowerCase())) return "Tires";
  if (/oil change|lube/.test(c.name.toLowerCase())) return "Oil & quick service";
  return "Auto repair";
}

const phoneOf = (c: Client): string | null =>
  /(?:Phone|phone \(public\)):?\s*(\+?1?[\s-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/.exec(c.notes.join("\n"))?.[1] ?? null;

const ratingOf = (c: Client): string | null => {
  const m = /(\d(?:\.\d)?)\s*(?:★|stars?)?\s*(?:\/|on|from)\s*([\d,]+)\s*(?:Google\s*)?reviews/i.exec(c.notes.join("\n"));
  return m ? `${m[1]} from ${m[2]} reviews` : null;
};

/** An email the inbox holds, as `/api/mail/recent` returns it. */
export interface MailMessage {
  direction: "sent" | "received";
  /** The other party's address. */
  counterpart: string;
  subject: string;
  preview: string;
  at: string;
}

/** The company's own inboxes. Mail between them is a self-test, never a send or a reply. */
export const OWN_INBOXES: readonly string[] = ["aarav.sav@agentmail.to"];

/** Ours: a listed inbox, or any AgentMail address (no shop writes from one). */
export const isOwnAddress = (address: string): boolean => {
  const a = address.trim().toLowerCase();
  return OWN_INBOXES.includes(a) || a.endsWith("@agentmail.to");
};

/** A mail server reporting on delivery, not a person. */
export const isBounceSender = (address: string): boolean =>
  /^(?:mailer-daemon|mail-daemon|postmaster|mail-delivery-subsystem)@/i.test(address.trim());

const BOUNCE_SUBJECT = /delivery status notification|undeliverable|undelivered mail|returned mail|delivery (?:has )?failed|failure notice|mail delivery failed/i;
const AUTO_SUBJECT = /\bauto(?:matic)?[- ]?(?:reply|response)\b|out of (?:the )?office|\baway from (?:the|my) (?:office|desk)\b|\bon vacation\b|thank you for (?:your (?:email|message)|contacting)|we(?:'ve| have) received your (?:email|message)/i;

export type MailKind = "internal" | "bounce" | "auto" | "real";

/** What one message is: our own test traffic, a bounce report, an auto-reply, or a real email. */
export function mailKind(m: MailMessage): MailKind {
  if (isOwnAddress(m.counterpart)) return "internal";
  if (m.direction === "received" && (isBounceSender(m.counterpart) || BOUNCE_SUBJECT.test(m.subject))) return "bounce";
  if (m.direction === "received" && AUTO_SUBJECT.test(m.subject)) return "auto";
  return "real";
}

/** The inbox without our own test traffic: what every count and every list is made from. */
export const realMail = (mail: readonly MailMessage[]): MailMessage[] => mail.filter((m) => mailKind(m) !== "internal");

/** A message the shop itself wrote: not ours, not a bounce, not an auto-reply. */
export const isRealReply = (m: MailMessage): boolean => m.direction === "received" && mailKind(m) === "real";

/** A real email we sent a shop: not a self-test. */
export const isRealSend = (m: MailMessage): boolean => m.direction === "sent" && mailKind(m) === "real";

/** The address a bounce report says it could not deliver to, when it names one. */
export function bouncedTo(m: MailMessage): string | null {
  for (const found of `${m.subject}\n${m.preview}`.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
    const a = found[0].toLowerCase();
    if (!isOwnAddress(a) && !isBounceSender(a) && !/amazonses\.com$/.test(a)) return a;
  }
  return null;
}

/** Webmail domains: two shops on gmail.com are not the same shop, so these never match by domain. */
const SHARED_DOMAINS = /^(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|sbcglobal|att|proton|protonmail|gmx)\.(?:com|net)$/;

const addressMatches = (c: Pick<Client, "contact" | "domain">, address: string): boolean => {
  const addr = address.trim().toLowerCase();
  if (addr === "" || isOwnAddress(addr) || isBounceSender(addr)) return false;
  const email = c.contact.email.trim().toLowerCase();
  const domain = c.domain.trim().toLowerCase().replace(/^www\./, "");
  return (email !== "" && addr === email) || (domain !== "" && !SHARED_DOMAINS.test(domain) && addr.endsWith(`@${domain}`));
};

/**
 * Messages to or from this shop: its contact's address, or anyone at its own domain, plus a bounce
 * report that names one of those addresses. Our own inboxes never match.
 */
export function mailFor<M extends MailMessage>(c: Pick<Client, "contact" | "domain">, mail: readonly M[]): M[] {
  return mail.filter((m) => {
    const kind = mailKind(m);
    if (kind === "internal") return false;
    if (kind === "bounce") {
      const to = bouncedTo(m);
      return to !== null && addressMatches(c, to);
    }
    return addressMatches(c, m.counterpart);
  });
}

/** One message as a line a person scans: `Emailed: "Subject"`, "Email to X bounced", `Reply: "…"`. */
export function mailLine(m: MailMessage, c?: Client): string {
  const kind = mailKind(m);
  if (kind === "bounce") return c ? `Email to ${shopName(c.name)} bounced` : "An email bounced";
  if (kind === "auto") return "Automatic reply";
  return m.direction === "sent" ? `Emailed: "${m.subject}"` : `Reply: "${m.subject}"`;
}

export function leadOf(c: Client, mail: readonly MailMessage[] = []): Lead {
  const events = eventsOf(c);
  const { status, rank } = statusOf(c, events);
  const mine = mailFor(c, mail);
  // A message the shop wrote proves a reply even before an agent filed it. A bounce report or an
  // auto-reply proves nothing; a bounce report alone marks the email bounced.
  const repliedByMail = mine.some(isRealReply);
  const bouncedByMail = mine.some((m) => mailKind(m) === "bounce");
  const fixedRank = repliedByMail && rank < 2 ? 2 : bouncedByMail && rank < 1 ? 1 : rank;
  const fixedStatus: LeadStatus = fixedRank >= 2
    ? (fixedRank === rank ? status : STATUSES[fixedRank]!)
    : status === "bounced" || bouncedByMail ? "bounced" : STATUSES[fixedRank]!;
  const dated = [
    ...events.filter((e) => e.at).map((e) => ({ at: e.at!, what: e.title })),
    ...mine.map((m) => ({ at: m.at, what: mailLine(m, c) })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  // An unprefixed note says nothing a person can scan; show the last event that does, or nothing.
  const undatedLast = [...events].reverse().find((e) => e.kind !== "note")?.title ?? null;
  // Someone who filled the site form in has not been researched by anyone yet.
  const fromSite = c.source === "site" && fixedRank === 0 && !events.some((e) => e.kind === "research");
  return {
    client: c,
    status: fromSite ? "new" : fixedStatus,
    rank: fixedRank,
    city: cityOf(c),
    sector: sectorOf(c),
    phone: phoneOf(c),
    rating: ratingOf(c),
    demoReady: events.some((e) => e.kind === "demo_built" || e.kind === "live"),
    lastAt: dated[0]?.at ?? null,
    lastEvent: dated[0]?.what ?? undatedLast,
    events,
  };
}

/**
 * The funnel, counted once. Every screen that prints a pipeline number reads it from here, so the
 * overview, the leads table, the pipeline and the rail can never disagree.
 *
 * `shops` is every lead; `emailed` every shop a cold email went to, bounced ones included;
 * `bounced` the shops whose email came back; each later step counts the shops that reached it.
 */
export interface Funnel {
  shops: number;
  emailed: number;
  bounced: number;
  replied: number;
  demo: number;
  free_week: number;
  paying: number;
}

export function funnelOf(leads: readonly Lead[]): Funnel {
  const reached = (rank: number) => leads.filter((l) => l.rank >= rank).length;
  return {
    shops: leads.length,
    emailed: reached(1),
    bounced: leads.filter((l) => l.status === "bounced").length,
    replied: reached(2),
    demo: reached(3),
    free_week: reached(4),
    paying: reached(5),
  };
}

/** Real emails out and real replies in on one day: no self-tests, no bounce reports, no auto-replies. */
export function mailToday(mail: readonly MailMessage[], now = new Date()): { sent: number; replies: number; bounces: number } {
  const today = (iso: string) => new Date(iso).toDateString() === now.toDateString();
  const day = mail.filter((m) => today(m.at));
  return {
    sent: day.filter(isRealSend).length,
    replies: day.filter(isRealReply).length,
    bounces: day.filter((m) => mailKind(m) === "bounce").length,
  };
}

/** "3 min ago", "2 h ago", "yesterday", "Nov 3". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** An agent's platform name as a person would say it: `booking--pats-garage` → "Pats Garage receptionist". */
export function agentLabel(name: string | undefined | null): string {
  if (!name || /^agt_/.test(name)) return "An agent";
  const per = /^booking--(.+)$/.exec(name);
  if (per) return `${titleCase(per[1]!.replace(/-/g, " "))} receptionist`;
  const known: Record<string, string> = {
    research: "Research",
    sales: "Sales",
    "client-manager": "Client manager",
    booking: "Shop receptionist",
    monitoring: "Monitoring",
    "self-improvement": "Self-improvement",
    ceo: "CEO",
  };
  return known[name] ?? titleCase(name.replace(/[-_]+/g, " "));
}

const titleCase = (s: string) => s.replace(/\b\w/g, (ch) => ch.toUpperCase());
