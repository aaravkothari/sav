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
import type { Client } from "./data";

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
  const who = c.contact.name.trim() || c.name;
  switch (kind) {
    case "research": return "Researched";
    case "demo_built": return "Demo receptionist built";
    case "drafted": return `Drafted a first email to ${who}`;
    case "skipped": return "Outreach skipped";
    case "emailed": return `Emailed ${who}`;
    case "bounced": return "Email bounced";
    case "replied": return `${firstName(c) === "the shop" ? c.name : firstName(c)} replied`;
    case "reply_sent": return /\/demo\//.test(rest) ? "Replied with the demo link" : "Replied";
    case "said_yes": return `${firstName(c) === "the shop" ? c.name : firstName(c)} said yes`;
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
  let text = rest;
  if (kind === "emailed" || kind === "drafted" || kind === "reply_sent") {
    const [first, ...others] = text.split("\n");
    if (others.length > 0 && /^[\w-]*\s*(to\s+\S+@\S+)?\s*$/i.test(scrub(first ?? ""))) text = others.join("\n");
  }
  return scrub(text);
}

export function eventsOf(c: Client): LeadEvent[] {
  return c.notes.map((note, index) => {
    const { kind, rest } = kindOf(note);
    return { kind, title: titleFor(kind, c, rest), body: bodyFor(kind, rest), at: timeIn(note), index };
  });
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
  onboarding: 2,
  blocked: 2,
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

/** Messages to or from this shop: its contact's address, or anyone at its domain. */
export function mailFor(c: Client, mail: readonly MailMessage[]): MailMessage[] {
  const email = c.contact.email.trim().toLowerCase();
  const domain = c.domain.trim().toLowerCase().replace(/^www\./, "");
  return mail.filter((m) => {
    const addr = m.counterpart.toLowerCase();
    return (email !== "" && addr === email) || (domain !== "" && addr.endsWith(`@${domain}`));
  });
}

export function leadOf(c: Client, mail: readonly MailMessage[] = []): Lead {
  const events = eventsOf(c);
  const { status, rank } = statusOf(c, events);
  const mine = mailFor(c, mail);
  // A message the shop wrote proves a reply even before an agent filed it.
  const repliedByMail = mine.some((m) => m.direction === "received");
  const fixedRank = repliedByMail && rank < 2 ? 2 : rank;
  const fixedStatus: LeadStatus = fixedRank !== rank ? STATUSES[fixedRank]! : status;
  const dated = [
    ...events.filter((e) => e.at).map((e) => ({ at: e.at!, what: e.title })),
    ...mine.map((m) => ({ at: m.at, what: m.direction === "sent" ? `Emailed: ${m.subject}` : `Reply: ${m.subject}` })),
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
    monitoring: "Monitoring",
    "self-improvement": "Self-improvement",
    ceo: "CEO",
  };
  return known[name] ?? titleCase(name.replace(/[-_]+/g, " "));
}

const titleCase = (s: string) => s.replace(/\b\w/g, (ch) => ch.toUpperCase());
