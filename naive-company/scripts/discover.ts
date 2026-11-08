/**
 * Fast lead discovery: Google Maps listings with a verified contact email, no AI turns.
 *
 *   pnpm discover --sector auto                       # dry run (the default): prints the plan and the most it can cost
 *   pnpm discover --sector auto --execute             # really run it
 *   pnpm discover --sector salon --city "Oakland, CA" --per-query 10 --budget-usd 2 --execute
 *
 * Steps:
 *   1. One Monid `anyapi /maps.contacts` run per (sector, city) pair, started together (8 at a time)
 *      and polled together. That endpoint returns the listing plus emails found on the shop's site.
 *   2. Dedupe by registrable domain, then last-10 phone digits. Skip anything already in
 *      `leads/*.json`, an earlier `data/discovered-*.json`, or the CRM (`list_clients`, when
 *      DASHBOARD_MCP_URL and DASHBOARD_MCP_TOKEN are set; otherwise create_lead's `already_filed`
 *      catches it at import). Directories and chains are dropped.
 *   3. For shops still missing an email: a free scrape of the shop's own contact pages, then Hunter
 *      `domain-search` on Monid for what is left, all started at once. No email means no lead.
 *   4. Write `data/discovered-<timestamp>.json` (git-ignored). `pnpm crm-import --from discovered` files it.
 *
 * Idempotent: every paid Monid answer is cached in `data/discover-cache/`, so a re-run does not pay
 * twice, and shops from earlier output files are not found again. Spend stops at `--budget-usd`
 * (or the wallet balance, if lower).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { limiter, normalizePhone, type Priority, registrableDomain, type ShopInput, voiceClient, withRetry } from "./worker.ts";

const run = promisify(execFile);

export const DEFAULT_CITIES = [
  "San Francisco, CA", "Oakland, CA", "Berkeley, CA", "San Jose, CA", "Palo Alto, CA", "Mountain View, CA", "Sunnyvale, CA", "Santa Clara, CA",
  "Redwood City, CA", "San Mateo, CA", "Fremont, CA", "Hayward, CA", "Walnut Creek, CA", "Concord, CA", "San Rafael, CA",
];

/** Search phrase, and who is too busy to pick up the phone. Unknown sectors search on their own name. */
const SECTORS: Record<string, { query: string; busy: string }> = {
  auto: { query: "auto repair", busy: "techs are in the bays" },
  salon: { query: "hair salon", busy: "stylists are with clients" },
  "dry-cleaning": { query: "dry cleaner", busy: "staff are at the counter" },
  "physical-therapy": { query: "physical therapy clinic", busy: "therapists are with patients" },
  dental: { query: "dentist", busy: "the team is chairside" },
  hvac: { query: "hvac contractor", busy: "techs are out on jobs" },
  plumbing: { query: "plumber", busy: "plumbers are out on jobs" },
};

const MAPS = { provider: "anyapi", endpoint: "/maps.contacts", estimate: 0.00325 };
const HUNTER = { provider: "hunterio", endpoint: "/domain-search", estimate: 0.0245 };
const TERMINAL = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);

/** Not the shop's own site: directories, booking platforms, shared hosts, national chains. */
const NOT_A_SHOP_SITE = new Set([
  "stressfree.com", "findaloco.com", "surecritic.com", "yelp.com", "facebook.com", "instagram.com", "google.com", "yellowpages.com", "mapquest.com",
  "nextdoor.com", "linktr.ee", "booksy.com", "vagaro.com", "styleseat.com", "schedulicity.com", "glossgenius.com", "square.site", "squareup.com", "business.site",
  "wixsite.com", "godaddysites.com", "weebly.com", "carrd.co", "jany.io", "zocdoc.com", "healthgrades.com", "opencare.com", "angi.com", "thumbtack.com",
  "homeadvisor.com", "bbb.org", "carwise.com", "repairpal.com", "mechanicadvisor.com",
  "firestonecompleteautocare.com", "midas.com", "jiffylube.com", "pepboys.com", "meineke.com", "valvoline.com", "vioc.com", "aamco.com", "maaco.com", "goodyear.com",
  "lesschwab.com", "bigotires.com", "christianbrothersauto.com", "fixautousa.com", "caliber.com", "calibercollision.com", "drivenbrands.com",
  "greatclips.com", "supercuts.com", "sportclips.com", "fantasticsams.com", "costcutters.com", "aspendental.com", "westerndental.com", "brightnow.com", "pacificdentalservices.com",
  "stretchlab.com", "rinse.com", "commonspirit.org", "crossoverhealth.com", "marquiscompanies.com", "oilchangers.com", "zipthrucarwashes.com",
  "mvhealthcare.com", "haywardhcc.com", "stfranciscarecenter.com", "salonrepublic.com",
  "athletico.com", "selectphysicaltherapy.com", "usphclinic.com", "zipsdrycleaners.com", "rotorooter.com", "mrrooter.com", "benjaminfranklinplumbing.com", "onehourheatandair.com",
]);

export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "sbcglobal.net", "att.net", "pacbell.net", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "aol.com", "comcast.net", "icloud.com", "me.com", "earthlink.net", "verizon.net", "cox.net", "protonmail.com", "proton.me",
]);

const JUNK_DOMAIN = /(^|\.)(example|mysite|email|domain|yourdomain|yoursite|website|sentry|sentry-next|wix|wixpress|squarespace|godaddy|wordpress|schema|test|sansoxygen)\.[a-z.]+$/;
const IMAGE_ENDING = /\.(png|jpe?g|gif|webp|svg|ico|css|js)$/i;
const REJECT_LOCAL = /^(no-?reply|do-?not-?reply|privacy|webmaster|abuse|postmaster|hostmaster|careers?|jobs?|hr|recruiting|billing|accounting|payroll|legal|press|media|sales|marketing|seo|user|username|name|your|you|email|first|firstname|test)$/;
const HEX_ID = /^[a-f0-9]{16,}$/;
const PHONE_GLUED = /^\d{3}-\d{3,4}/;
const ROLE_INBOX = /^(info|service|services|contact|contactus|office|hello|hi|appointments?|appt|schedule|scheduling|booking|bookings|frontdesk|front\.desk|reception|shop|team|customerservice|care|admin|support|mail|inquiries|inquiry|repairs?)$/;
const OWNER_LOCAL = /^(owner|manager|gm)$/;
const OWNER_ROLE = /\b(owner|co-?owner|founder|president|ceo|principal|proprietor|general manager|manager|director|office manager|service manager)\b/i;
const GENERIC_TOKENS = new Set([
  "auto", "autos", "automotive", "repair", "repairs", "shop", "care", "service", "services", "center", "centre", "garage", "motor", "motors", "tire", "tires",
  "salon", "hair", "beauty", "nails", "barber", "spa", "dental", "dentist", "dentistry", "orthodontics", "clinic", "therapy", "physical", "rehab", "wellness",
  "plumbing", "plumber", "heating", "cooling", "hvac", "air", "cleaners", "cleaner", "cleaning", "laundry", "group", "company", "the", "and", "inc", "llc",
  "contact", "info", "mail", "office", "email", "bay", "area", "san", "santa",
]);

export interface Listing {
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  domain: string | null;
  rating: number | null;
  reviewCount: number | null;
  category: string | null;
  categories: string[];
  emails: string[];
}

export interface EmailCandidate {
  email: string;
  source: "listing" | "site" | "hunter";
  first_name?: string | null;
  position?: string | null;
}

export interface Contact {
  contact_email: string;
  contact_first_name: string | null;
  contact_role: string | null;
  source: EmailCandidate["source"];
}

export interface DiscoveredLead {
  name: string;
  sector: string;
  kind: "repair" | "service";
  domain: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  rating: number | null;
  review_count: number | null;
  website: string | null;
  contact_first_name: string | null;
  contact_email: string;
  contact_role: string | null;
  email_source: EmailCandidate["source"];
  personalized_detail: string;
  note: string;
  priority: Priority;
  source: "outreach";
  operator_called: false;
  shop_input: Omit<ShopInput, "kind"> & { kind: "repair" | "service"; sector?: string };
}

export interface Options {
  execute: boolean;
  sectors: string[];
  cities: string[];
  perQuery: number;
  budgetUsd: number;
  out?: string;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { execute: false, sectors: [], cities: [], perQuery: 20, budgetUsd: 10 };
  const number = (flag: string, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} takes a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const take = () => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--execute") opts.execute = true;
    else if (flag === "--dry-run") opts.execute = false;
    else if (flag === "--sector") opts.sectors.push(take().toLowerCase());
    else if (flag === "--city") opts.cities.push(take());
    else if (flag === "--per-query") {
      const n = number(flag, take());
      if (!Number.isInteger(n) || n > 20) throw new Error("--per-query takes an integer from 1 to 20 (the endpoint's limit)");
      opts.perQuery = n;
    } else if (flag === "--budget-usd") opts.budgetUsd = number(flag, take());
    else if (flag === "--out") opts.out = take();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (argv.includes("--execute") && argv.includes("--dry-run")) throw new Error("pick one of --dry-run and --execute");
  if (!opts.sectors.length) throw new Error("give at least one --sector (auto, salon, dry-cleaning, physical-therapy, dental, hvac, plumbing, ...)");
  if (!opts.cities.length) opts.cities = [...DEFAULT_CITIES];
  return opts;
}

export function sectorQuery(sector: string): string {
  return SECTORS[sector]?.query ?? sector.replace(/-/g, " ");
}

/** One row of the maps.contacts answer, tolerant of missing fields. */
export function parseListings(output: unknown): Listing[] {
  const items = (output as { data?: { items?: unknown[] } } | null)?.data?.items;
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const r = raw as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const website = text(r["website"]);
    return {
      name: text(r["name"]) ?? "",
      address: text(r["address"]),
      phone: text(r["phone"]),
      website,
      domain: registrableDomain(website),
      rating: num(r["rating"]),
      reviewCount: num(r["reviewCount"]),
      category: text(r["category"]),
      categories: list(r["categories"]),
      emails: list(r["emails"]),
    };
  }).filter((l) => l.name);
}

export interface DedupeResult {
  kept: Array<Listing & { sector: string; searchCity: string }>;
  dropped: Record<"no_domain" | "directory_or_chain" | "known" | "duplicate", number>;
}

/**
 * Drop listings without a usable site, then listings already known, then repeats. A domain used by
 * listings with different phone numbers is a chain or a directory, and every one of them goes.
 */
export function dedupeListings(listings: Array<Listing & { sector: string; searchCity: string }>, known: { domains: Set<string>; phones: Set<string> }): DedupeResult {
  const dropped = { no_domain: 0, directory_or_chain: 0, known: 0, duplicate: 0 };
  const phonesByDomain = new Map<string, Set<string>>();
  for (const l of listings) {
    const phone = normalizePhone(l.phone);
    if (!l.domain || !phone) continue;
    if (!phonesByDomain.has(l.domain)) phonesByDomain.set(l.domain, new Set());
    phonesByDomain.get(l.domain)?.add(phone);
  }
  const seenDomains = new Set<string>();
  const seenPhones = new Set<string>();
  const kept: DedupeResult["kept"] = [];
  for (const l of listings) {
    if (!l.domain) {
      dropped.no_domain++;
      continue;
    }
    if (NOT_A_SHOP_SITE.has(l.domain) || (phonesByDomain.get(l.domain)?.size ?? 0) > 1) {
      dropped.directory_or_chain++;
      continue;
    }
    const phone = normalizePhone(l.phone);
    if (known.domains.has(l.domain) || (phone && known.phones.has(phone))) {
      dropped.known++;
      continue;
    }
    if (seenDomains.has(l.domain) || (phone && seenPhones.has(phone))) {
      dropped.duplicate++;
      continue;
    }
    seenDomains.add(l.domain);
    if (phone) seenPhones.add(phone);
    kept.push(l);
  }
  return { kept, dropped };
}

/** Email addresses in a page, with `[at]` / `(dot)` spellings and HTML or URL escapes decoded. */
export function extractEmails(html: string): string[] {
  const text = html
    .replace(/&#0*64;|&#x0*40;|&commat;|%40/gi, "@")
    .replace(/&#0*46;|&#x0*2e;|&period;/gi, ".")
    .replace(/\\u0040/gi, "@")
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, "@")
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, ".");
  const found = new Set<string>();
  for (const match of text.matchAll(/[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/gi)) {
    const email = match[0].toLowerCase().replace(/^u003e/, "").replace(/\.+$/, "");
    found.add(email);
  }
  return [...found];
}

function nameTokens(name: string, domain: string): string[] {
  const label = domain.split(".")[0] ?? "";
  const words = `${name} ${label}`.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/);
  return [...new Set(words)].filter((w) => w.length >= 4 && !GENERIC_TOKENS.has(w));
}

/** Lowercase, without the `mailto:`, `http://` or URL-escaped spaces that some listings carry. */
export function cleanEmail(raw: string): string {
  return raw.replace(/^(mailto:|https?:\/\/)/i, "").replace(/%20/gi, "").trim().toLowerCase();
}

/**
 * Lower is better; null means do not use this address. A named owner or manager, then the shop's
 * role inboxes, then other addresses on its own domain, then free mail that names the shop.
 */
export function scoreEmail(candidate: EmailCandidate, shop: { name: string; domain: string }): number | null {
  const email = cleanEmail(candidate.email);
  const at = email.indexOf("@");
  if (at < 1) return null;
  const local = email.slice(0, at);
  const host = email.slice(at + 1);
  if (IMAGE_ENDING.test(email) || JUNK_DOMAIN.test(host) || REJECT_LOCAL.test(local) || HEX_ID.test(local) || PHONE_GLUED.test(local)) return null;
  if (FREE_MAIL.has(host)) return nameTokens(shop.name, shop.domain).some((t) => local.includes(t)) ? 50 : null;
  if (registrableDomain(host) !== shop.domain) return null;
  if (candidate.position && OWNER_ROLE.test(candidate.position)) return 0;
  if (OWNER_LOCAL.test(local)) return 10;
  if (ROLE_INBOX.test(local)) return 20;
  return candidate.first_name ? 30 : 40;
}

export function pickContact(candidates: EmailCandidate[], shop: { name: string; domain: string }): Contact | null {
  let best: { score: number; candidate: EmailCandidate } | null = null;
  for (const candidate of candidates) {
    const score = scoreEmail(candidate, shop);
    if (score === null) continue;
    if (!best || score < best.score) best = { score, candidate };
  }
  if (!best) return null;
  const c = best.candidate;
  return { contact_email: cleanEmail(c.email), contact_first_name: c.first_name?.trim() || null, contact_role: c.position?.trim() || null, source: c.source };
}

/** Hunter rows worth using: verified, or seen on the web with high confidence. Inferred patterns stay out. */
export function hunterCandidates(output: unknown): EmailCandidate[] {
  const root = output as { data?: { emails?: unknown[]; data?: { emails?: unknown[] } }; emails?: unknown[] } | null;
  const emails = root?.data?.emails ?? root?.data?.data?.emails ?? root?.emails;
  if (!Array.isArray(emails)) return [];
  const out: EmailCandidate[] = [];
  for (const raw of emails) {
    const row = raw as { value?: string; first_name?: string | null; position?: string | null; confidence?: number; sources?: unknown[]; verification?: { status?: string | null } };
    if (!row.value) continue;
    const status = row.verification?.status ?? null;
    const verified = status === "valid";
    const seenOnWeb = Array.isArray(row.sources) && row.sources.length > 0 && (row.confidence ?? 0) >= 70;
    if (status === "invalid" || !(verified || seenOnWeb)) continue;
    out.push({ email: row.value, source: "hunter", first_name: row.first_name ?? null, position: row.position ?? null });
  }
  return out;
}

/** Name patterns that say what a business focuses on, each only for the sectors where the words mean that. */
const SPECIALTIES: Array<[RegExp, string, readonly string[]]> = [
  [/\b(european|euro)\b/i, "you specialize in European cars", ["auto"]],
  [/\b(bmw|bimmer)\b/i, "you specialize in BMWs", ["auto"]],
  [/\b(mercedes|benz)\b/i, "you specialize in Mercedes", ["auto"]],
  [/\bporsche\b/i, "you specialize in Porsches", ["auto"]],
  [/\b(audi|vw|volkswagen)\b/i, "you specialize in Audi and VW", ["auto"]],
  [/\b(volvo)\b/i, "you specialize in Volvos", ["auto"]],
  [/\bsubaru\b/i, "you specialize in Subarus", ["auto"]],
  [/\b(toyota|lexus)\b/i, "you specialize in Toyota and Lexus", ["auto"]],
  [/\b(honda|acura)\b/i, "you specialize in Honda and Acura", ["auto"]],
  [/\b(japanese|asian)\b/i, "you specialize in Japanese cars", ["auto"]],
  [/\b(ev|tesla|electric vehicle)\b/i, "you work on EVs", ["auto"]],
  [/\bhybrid\b/i, "you work on hybrids", ["auto"]],
  [/\bdiesel\b/i, "you work on diesels", ["auto"]],
  [/\btransmission\b/i, "you focus on transmission work", ["auto"]],
  [/\bpediatric\b/i, "you focus on kids", ["physical-therapy", "dental"]],
  [/\bsports? (physical therapy|medicine|rehab)\b/i, "you focus on sports injuries", ["physical-therapy"]],
  [/\bbridal\b/i, "you do bridal work", ["salon"]],
];

function formatRating(rating: number): string {
  return rating === 5 ? "a perfect 5-star" : `a ${rating.toFixed(1)}`;
}

/** Street name without the number or suite: `1700 El Camino Real, San Carlos` -> `El Camino Real`. */
export function streetName(address: string | null | undefined): string | null {
  const first = address?.split(",")[0]?.trim();
  if (!first) return null;
  const street = first.replace(/^\d+[a-z]?\s+/i, "").replace(/\s+(#.*|(suite|ste|unit|apt)\b.*)$/i, "").replace(/\s+[A-Z]$/, "").trim();
  if (!street || street === first || /^\d/.test(street)) return null;
  return street.replace(/^[NSEW]\s+/, "");
}

export function listingCity(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const stateAt = parts.findIndex((p) => /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(p));
  return stateAt > 0 ? (parts[stateAt - 1] ?? null) : null;
}

/** One true clause that completes "I came across {shop} and noticed ...". From listing fields only. */
export function personalizedDetail(listing: Pick<Listing, "name" | "rating" | "reviewCount" | "address">, city: string | null, sector: string): string {
  for (const [pattern, clause, sectors] of SPECIALTIES) if (sectors.includes(sector) && pattern.test(listing.name)) return clause;
  const { rating, reviewCount: reviews } = listing;
  if (rating !== null && reviews !== null && rating >= 4.5 && reviews >= 15) {
    return reviews >= 100 ? `you've kept ${formatRating(rating)} rating across ${reviews} Google reviews` : `you have ${formatRating(rating)} rating from ${reviews} Google reviews`;
  }
  const street = streetName(listing.address);
  if (street && city) return `you're on ${street} in ${city}`;
  return city ? `you're based in ${city}` : "you're listed on Google Maps";
}

function displayPhone(phone: string | null): string | null {
  const digits = normalizePhone(phone);
  return digits ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : null;
}

export function researchNote(listing: Listing, sector: string, detail: string): string {
  const what = listing.category ?? sectorQuery(sector);
  const rated = listing.rating !== null && listing.reviewCount !== null ? `${what} rated ${listing.rating} on ${listing.reviewCount} Google reviews.` : `${what} with no Google rating listed.`;
  const where = [displayPhone(listing.phone) ? `Phone ${displayPhone(listing.phone)}` : null, listing.address].filter(Boolean).join(", ");
  const busy = SECTORS[sector]?.busy ?? "the team is with customers";
  const size = listing.reviewCount ? `independent shop with ${listing.reviewCount} reviews` : "independent shop";
  return `RESEARCH: ${rated}${where ? ` ${where}.` : ""} Fit: ${size}, busy enough that calls likely go unanswered while ${busy}. Detail: ${detail}.`;
}

export function priorityFor(listing: Pick<Listing, "rating" | "reviewCount">): Priority {
  const reviews = listing.reviewCount ?? 0;
  if (reviews >= 100 && (listing.rating ?? 0) >= 4.5) return "A";
  return reviews >= 30 ? "B" : "C";
}

export function buildLead(listing: Listing & { sector: string; searchCity: string }, contact: Contact): DiscoveredLead {
  const city = listingCity(listing.address) ?? listing.searchCity.split(",")[0]?.trim() ?? null;
  const kind = listing.sector === "auto" ? "repair" : "service";
  const detail = personalizedDetail(listing, city, listing.sector);
  const services = [...new Set(listing.categories.map((c) => c.toLowerCase()))].slice(0, 8);
  return {
    name: listing.name,
    sector: listing.sector,
    kind,
    domain: listing.domain ?? "",
    phone: listing.phone,
    address: listing.address,
    city,
    rating: listing.rating,
    review_count: listing.reviewCount,
    website: listing.website,
    contact_first_name: contact.contact_first_name,
    contact_email: contact.contact_email,
    contact_role: contact.contact_role,
    email_source: contact.source,
    personalized_detail: detail,
    note: researchNote(listing, listing.sector, detail),
    priority: priorityFor(listing),
    source: "outreach",
    operator_called: false,
    shop_input: {
      name: listing.name,
      kind,
      ...(kind === "service" ? { sector: listing.sector } : {}),
      demo: true,
      phone: listing.phone,
      address: listing.address,
      website: listing.website,
      services,
      policies: ["Do not quote prices."],
    },
  };
}

/** Reserves the estimate before a run starts and settles it to the real cost after. Refuses past the cap. */
export class Budget {
  spent = 0;
  private reserved = 0;
  readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  reserve(estimate: number): boolean {
    if (this.spent + this.reserved + estimate > this.cap + 1e-9) return false;
    this.reserved += estimate;
    return true;
  }
  settle(estimate: number, actual: number): void {
    this.reserved = Math.max(0, this.reserved - estimate);
    this.spent += actual;
  }
}

export interface RunResult {
  status: string;
  output: unknown;
  cost: number;
  httpStatus: number | null;
}

export interface Monid {
  start(provider: string, endpoint: string, body: Record<string, unknown>): Promise<string>;
  get(runId: string): Promise<RunResult>;
}

export function parseRun(raw: unknown): RunResult {
  const r = raw as { status?: string; output?: unknown; cost?: { value?: number }; providerResponse?: { httpStatus?: number } };
  return { status: r.status ?? "UNKNOWN", output: r.output ?? null, cost: r.cost?.value ?? 0, httpStatus: r.providerResponse?.httpStatus ?? null };
}

/** The Monid CLI, which holds the API key. */
export function monidCli(): Monid {
  const cli = async (args: string[]) => {
    try {
      const { stdout } = await run("monid", args, { env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 64 * 1024 * 1024 });
      return JSON.parse(stdout) as unknown;
    } catch (e) {
      const stdout = (e as { stdout?: string }).stdout;
      if (stdout) {
        try {
          return JSON.parse(stdout) as unknown;
        } catch {
          // fall through to the original error
        }
      }
      throw e;
    }
  };
  return {
    async start(provider, endpoint, body) {
      const started = (await cli(["run", "-p", provider, "-e", endpoint, "-i", JSON.stringify(body), "-j"])) as { runId?: string; error?: { message?: string } };
      if (!started.runId) throw new Error(`monid run ${endpoint}: ${started.error?.message ?? "no run id"}`);
      return started.runId;
    },
    async get(runId) {
      return parseRun(await cli(["runs", "get", runId, "-j"]));
    },
  };
}

export interface Job {
  key: string;
  provider: string;
  endpoint: string;
  body: Record<string, unknown>;
  estimate: number;
}

export interface JobOutcome {
  output: unknown;
  cost: number;
  status: "completed" | "cached" | "failed" | "over_budget";
  error?: string;
}

export interface RunnerDeps {
  monid: Monid;
  budget: Budget;
  concurrency?: number;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  readCache?: (job: Job) => Promise<unknown | undefined>;
  writeCache?: (job: Job, output: unknown) => Promise<void>;
  now?: () => number;
}

/**
 * Start every job the budget allows (bounded), then poll all of the live runs in one sweep until
 * each one ends. Runs that bill less than their estimate free up room, so whatever was held back
 * goes in another wave until nothing more fits. A run that outlives the timeout keeps its estimate
 * on the budget, since it may still bill.
 */
export async function runJobs(jobs: Job[], deps: RunnerDeps): Promise<Map<string, JobOutcome>> {
  const { monid, budget } = deps;
  const limit = limiter(deps.concurrency ?? 8);
  const pollMs = deps.pollMs ?? 4000;
  const timeoutMs = deps.timeoutMs ?? 180_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const outcomes = new Map<string, JobOutcome>();
  const live = new Map<string, { job: Job; startedAt: number }>();

  let waiting = jobs;
  for (;;) {
    const heldBack: Job[] = [];
    await Promise.all(waiting.map((job) => limit(async () => {
      const cached = await deps.readCache?.(job);
      if (cached !== undefined) {
        outcomes.set(job.key, { output: cached, cost: 0, status: "cached" });
        return;
      }
      if (!budget.reserve(job.estimate)) {
        heldBack.push(job);
        return;
      }
      try {
        const runId = await monid.start(job.provider, job.endpoint, job.body);
        live.set(runId, { job, startedAt: now() });
      } catch (e) {
        budget.settle(job.estimate, 0);
        outcomes.set(job.key, { output: null, cost: 0, status: "failed", error: (e as Error).message });
      }
    })));
    const startedAny = live.size > 0;

    while (live.size) {
      await Promise.all([...live].map(([runId, { job, startedAt }]) => limit(async () => {
        let result: RunResult | null = null;
        try {
          result = await monid.get(runId);
        } catch {
          // A failed poll is retried on the next sweep.
        }
        if (result && TERMINAL.has(result.status)) {
          live.delete(runId);
          budget.settle(job.estimate, result.cost);
          const ok = result.status === "COMPLETED" && (result.httpStatus === null || result.httpStatus < 400);
          if (ok) await deps.writeCache?.(job, result.output);
          outcomes.set(job.key, ok
            ? { output: result.output, cost: result.cost, status: "completed" }
            : { output: null, cost: result.cost, status: "failed", error: `${result.status}${result.httpStatus ? ` http ${result.httpStatus}` : ""}` });
        } else if (now() - startedAt > timeoutMs) {
          live.delete(runId);
          outcomes.set(job.key, { output: null, cost: 0, status: "failed", error: `timed out, run ${runId}` });
        }
      })));
      if (live.size) await sleep(pollMs);
    }

    if (!heldBack.length) break;
    if (!startedAny) {
      for (const job of heldBack) outcomes.set(job.key, { output: null, cost: 0, status: "over_budget" });
      break;
    }
    waiting = heldBack;
  }
  return outcomes;
}

const CONTACT_PATHS = ["/", "/contact", "/contact-us", "/about", "/about-us"];

/** Fetch one page; empty string on anything but an HTML 200. */
export async function fetchPage(url: string, timeoutMs = 8000): Promise<string> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "Mozilla/5.0 (compatible; SAVResearch/1.0)", Accept: "text/html" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return "";
    return (await res.text()).slice(0, 1_500_000);
  } catch {
    return "";
  }
}

export function contactUrls(website: string): string[] {
  const start = /^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`;
  try {
    const origin = new URL(start).origin;
    return [...new Set([start, ...CONTACT_PATHS.map((p) => `${origin}${p}`)])];
  } catch {
    return [];
  }
}

/** Addresses from the shop's own pages, every page fetched at once under one shared pool. */
export async function scrapeSite(website: string, limit: <T>(task: () => Promise<T>) => Promise<T>, fetcher: (url: string) => Promise<string> = fetchPage): Promise<EmailCandidate[]> {
  const pages = await Promise.all(contactUrls(website).map((url) => limit(() => fetcher(url))));
  return [...new Set(pages.flatMap(extractEmails))].map((email) => ({ email, source: "site" as const }));
}

function cacheFile(dir: string, job: Job): string {
  return join(dir, `${createHash("sha256").update(JSON.stringify([job.provider, job.endpoint, job.body])).digest("hex").slice(0, 32)}.json`);
}

/** Domains and phones already in a list of leads (leads/*.json or data/discovered-*.json). */
export function collectKnown(leads: unknown, known: { domains: Set<string>; phones: Set<string> }): void {
  if (!Array.isArray(leads)) return;
  for (const raw of leads) {
    const lead = raw as { domain?: string | null; phone?: string | null; shop_input?: { website?: string | null; phone?: string | null } };
    for (const domain of [lead.domain ? registrableDomain(lead.domain) : null, registrableDomain(lead.shop_input?.website)]) if (domain) known.domains.add(domain);
    for (const phone of [normalizePhone(lead.phone), normalizePhone(lead.shop_input?.phone)]) if (phone) known.phones.add(phone);
  }
}

async function readJsonFiles(dir: string, match: (name: string) => boolean): Promise<unknown[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(names.filter(match).map((n) => readFile(join(dir, n), "utf8").then((t) => JSON.parse(t) as unknown).catch(() => null)));
  return files.filter((f) => f !== null);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, "../data");
  const cacheDir = join(dataDir, "discover-cache");
  const pairs = opts.sectors.flatMap((sector) => opts.cities.map((city) => ({ sector, city })));

  const known = { domains: new Set<string>(), phones: new Set<string>() };
  for (const file of await readJsonFiles(resolve(here, "../../leads"), (n) => n.endsWith(".json"))) collectKnown(file, known);
  for (const file of await readJsonFiles(dataDir, (n) => /^discovered-.*\.json$/.test(n))) collectKnown(file, known);
  const url = process.env["DASHBOARD_MCP_URL"];
  const token = process.env["DASHBOARD_MCP_TOKEN"];
  if (url && token) {
    const clients = await withRetry(() => voiceClient(url, token)<Array<{ domain?: string }>>("list_clients", {}));
    collectKnown(clients, known);
    console.log(`CRM: ${clients.length} client(s) read`);
  } else {
    console.log("CRM: no dashboard token here, create_lead's already_filed catches repeats at import");
  }
  console.log(`known: ${known.domains.size} domain(s), ${known.phones.size} phone(s)`);

  const mapsCost = pairs.length * MAPS.estimate;
  console.log(`${opts.execute ? "EXECUTE" : "DRY RUN"}: ${pairs.length} search(es), ${opts.sectors.length} sector(s) x ${opts.cities.length} cit(ies), up to ${opts.perQuery} listings each. Budget $${opts.budgetUsd}.`);
  if (!opts.execute) {
    for (const { sector, city } of pairs) console.log(`search  ${sectorQuery(sector)}  in ${city}`);
    console.log(`dry run: Maps searches would cost about $${mapsCost.toFixed(2)}; Hunter only for shops the scrape misses, at $${HUNTER.estimate} each, inside the budget. Re-run with --execute.`);
    return;
  }

  const monid = monidCli();
  let cap = opts.budgetUsd;
  try {
    const { stdout } = await run("monid", ["balance", "-j"], { env: { ...process.env, NO_COLOR: "1" } });
    const parsed = JSON.parse(stdout) as { balance?: { value?: number } | number; amount?: number };
    const balance = typeof parsed.balance === "number" ? parsed.balance : (parsed.balance?.value ?? parsed.amount);
    if (typeof balance === "number" && balance < cap) {
      console.log(`wallet holds $${balance.toFixed(2)}, below the budget: capping spend there`);
      cap = balance;
    }
  } catch {
    console.log("could not read the wallet balance, using the budget alone");
  }
  const budget = new Budget(cap);
  await mkdir(cacheDir, { recursive: true });
  const cache = {
    readCache: (job: Job) => readFile(cacheFile(cacheDir, job), "utf8").then((t) => JSON.parse(t) as unknown).catch(() => undefined),
    writeCache: async (job: Job, output: unknown) => {
      const file = cacheFile(cacheDir, job);
      await writeFile(`${file}.tmp`, JSON.stringify(output));
      await rename(`${file}.tmp`, file);
    },
  };

  const started = Date.now();
  const mapsJobs: Job[] = pairs.map(({ sector, city }) => ({
    key: `${sector}|${city}`, provider: MAPS.provider, endpoint: MAPS.endpoint, estimate: MAPS.estimate,
    body: { query: sectorQuery(sector), location: `${city}, USA`, limit: opts.perQuery, website: "withWebsite" },
  }));
  const maps = await runJobs(mapsJobs, { monid, budget, ...cache });
  const listings = pairs.flatMap(({ sector, city }) => parseListings(maps.get(`${sector}|${city}`)?.output).map((l) => ({ ...l, sector, searchCity: city })));
  const mapsStatus = (s: JobOutcome["status"]) => [...maps.values()].filter((o) => o.status === s).length;
  console.log(`maps: ${listings.length} listing(s) from ${maps.size} search(es) (${mapsStatus("completed")} run, ${mapsStatus("cached")} cached, ${mapsStatus("failed")} failed, ${mapsStatus("over_budget")} over budget)`);
  for (const [key, o] of maps) if (o.status === "failed") console.log(`  failed ${key}: ${o.error}`);

  const { kept, dropped } = dedupeListings(listings, known);
  console.log(`dedupe: ${kept.length} new shop(s); dropped ${JSON.stringify(dropped)}`);

  const candidates = new Map(kept.map((l) => [l.domain ?? "", l.emails.map((email): EmailCandidate => ({ email, source: "listing" }))]));
  const shopOf = (l: Listing) => ({ name: l.name, domain: l.domain ?? "" });
  const missing = () => kept.filter((l) => !pickContact(candidates.get(l.domain ?? "") ?? [], shopOf(l)));
  const fromListing = kept.length - missing().length;

  const toScrape = missing();
  const pageLimit = limiter(24);
  await Promise.all(toScrape.map(async (l) => {
    if (l.website) candidates.get(l.domain ?? "")?.push(...(await scrapeSite(l.website, pageLimit)));
  }));
  const afterScrape = missing();
  console.log(`email: ${fromListing} from the listing, ${toScrape.length - afterScrape.length} from a site scrape, ${afterScrape.length} left for Hunter`);

  // Busiest shops first, so a tight budget goes where a lead is worth the most.
  const hunterOrder = [...afterScrape].sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
  const hunterJobs: Job[] = hunterOrder.map((l) => ({ key: l.domain ?? "", provider: HUNTER.provider, endpoint: HUNTER.endpoint, estimate: HUNTER.estimate, body: { domain: l.domain, limit: 10 } }));
  const hunter = await runJobs(hunterJobs, { monid, budget, ...cache });
  for (const [domain, outcome] of hunter) candidates.get(domain)?.push(...hunterCandidates(outcome.output));
  const hunterStatus = (s: JobOutcome["status"]) => [...hunter.values()].filter((o) => o.status === s).length;
  const leftover = missing();
  console.log(`hunter: ${afterScrape.length - leftover.length} found (${hunterStatus("completed")} run, ${hunterStatus("cached")} cached, ${hunterStatus("failed")} failed, ${hunterStatus("over_budget")} over budget)`);

  const leads: DiscoveredLead[] = [];
  for (const l of kept) {
    const contact = pickContact(candidates.get(l.domain ?? "") ?? [], shopOf(l));
    if (contact) leads.push(buildLead(l, contact));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = opts.out ? resolve(opts.out) : join(dataDir, `discovered-${stamp}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(`${out}.tmp`, `${JSON.stringify(leads, null, 2)}\n`);
  await rename(`${out}.tmp`, out);

  const bySector: Record<string, { shops: number; with_email: number }> = {};
  for (const l of kept) (bySector[l.sector] ??= { shops: 0, with_email: 0 }).shops++;
  for (const l of leads) (bySector[l.sector] ??= { shops: 0, with_email: 0 }).with_email++;
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s: ${leads.length} lead(s) with email of ${kept.length} new shop(s). ${JSON.stringify(bySector)}`);
  console.log(`spent $${budget.spent.toFixed(4)} of $${cap.toFixed(2)}. Output: ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error((e as Error).message ?? e);
    process.exit(1);
  });
}
