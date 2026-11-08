/**
 * The first cold email, verbatim from Aarav (Nov 7). The outbound engine (`scripts/engine.ts`)
 * fills it in code; no AI writes it. Nothing comes after the signature: no footer, no links.
 *
 * `{{personalized_detail}}` comes only from the shop's `RESEARCH:` note. A shop with no usable
 * detail is skipped, never given an invented one.
 */

export const OUTREACH_TEMPLATE = `Hi {{first_name}},

I came across {{shop_name}} and noticed {{personalized_detail}}.

The Automotive Service Association reportedly found that nearly 1 in 4 calls to auto repair shops go unanswered when staff are busy. How many potential customers are you losing when nobody picks up or your shop is closed?

We're building SAV to answer those calls and book appointments 24/7.

Would you be open to trying it for free?

Best,
Aarav`;

/**
 * The same email for a business outside auto repair (salons, dry cleaners, physical therapy…).
 * The Automotive Service Association figure is about auto repair shops, so it is dropped, with no
 * substitute statistic (Vedant's review of #52), and "your shop" names the kind of place it is.
 * Everything else is Aarav's text, word for word.
 */
export const OUTREACH_TEMPLATE_GENERAL = `Hi {{first_name}},

I came across {{shop_name}} and noticed {{personalized_detail}}.

How many potential customers are you losing when nobody picks up or your {{place}} is closed?

We're building SAV to answer those calls and book appointments 24/7.

Would you be open to trying it for free?

Best,
Aarav`;

/** What "your … is closed" calls the place, by sector. */
export function placeWord(sector: string | null | undefined): string {
  const s = (sector ?? "").toLowerCase();
  if (/salon|barber|hair|nail|spa|beauty/.test(s)) return /barber/.test(s) ? "shop" : "salon";
  if (/physical therap|physio|chiropract|clinic|dental|dentist|medical|massage/.test(s)) return "clinic";
  if (/studio|gym|fitness|yoga|pilates/.test(s)) return "studio";
  if (/dry clean|laundr|tailor|cleaner/.test(s)) return "shop";
  return "business";
}

export const OUTREACH_SUBJECT = "Missed calls at {{shop_name}}";

export interface ColdEmailLead {
  shop_name: string;
  /** The CRM contact's name, as filed; anything that is not a person's name reads as "there". */
  contact_name?: string | null;
  /** The detail from the RESEARCH note, already cleaned by `personalizedDetail`. */
  personalized_detail: string;
  /** The business's sector, when it is not auto repair (null or absent means auto repair: Aarav's exact template). */
  sector?: string | null;
}

/** Mailbox words people file as a contact's name that are not a name. */
const NOT_A_NAME = new Set([
  "info", "service", "services", "office", "admin", "administrator", "team", "contact", "sales", "support", "hello", "hi",
  "front", "desk", "frontdesk", "manager", "owner", "shop", "mail", "email", "booking", "bookings", "appointments", "parts",
  "general", "customer", "customers", "reception", "receptionist", "staff", "the", "dear", "service-desk", "noreply", "no-reply",
  "unknown", "n/a", "na", "none", "null", "auto", "repair", "garage", "accounts", "billing", "careers", "jobs", "marketing",
]);

/** The contact's first name, or "there" when there is none or it is not a person's name. */
export function firstName(contactName: string | null | undefined): string {
  const first = (contactName ?? "").trim().split(/\s+/)[0] ?? "";
  if (first.length < 2 || first.includes("@") || NOT_A_NAME.has(first.toLowerCase())) return "there";
  if (!/^[\p{L}][\p{L}'’-]*$/u.test(first)) return "there";
  return first === first.toLowerCase() || first === first.toUpperCase() ? first[0]!.toUpperCase() + first.slice(1).toLowerCase() : first;
}

/** Labels a research note may put the opener detail under, most specific first. */
const DETAIL_LABELS = [/personali[sz]ed detail\s*:\s*/i, /opener detail\s*:\s*/i, /\bdetail\s*:\s*/i];

/** Words that make a "detail" an instruction to the writer rather than a fact about the shop. */
const NOT_A_DETAIL = /@|https?:\/\/|\bhunter\b|\bopener\b|\breference\b|\baddress (him|her|them|\w+) as\b|\bcontact (them|by)\b|\bmention\b|\bnatural\b|\bno email\b|\bverified\b/i;

/** The first word keeps its capital when it is an acronym, a brand with an inner capital, or a proper noun people always capitalise. */
const KEEP_CAPITAL = /^(?:[A-Z0-9]{2,}|[A-Z][a-z]+[A-Z]\w*|I|Google|Yelp|Facebook|Instagram|ASE|AAA|BMW|Toyota|Honda|Ford|Tesla|Subaru|Mercedes|Audi|Lexus|Nissan|Volvo|Porsche)\b/;

/**
 * The opener detail from a RESEARCH note, ready for "noticed {{…}}.": first letter lowered, no
 * trailing period. Null when the note has no detail, or the detail is an instruction (an email
 * address, "Hunter found…", "a natural opener") rather than something observed about the shop.
 */
export function personalizedDetail(researchNote: string | null | undefined): string | null {
  const note = researchNote ?? "";
  for (const label of DETAIL_LABELS) {
    const m = label.exec(note);
    if (!m) continue;
    let detail = note.slice(m.index + m[0].length).split(/\r?\n/)[0]!.trim();
    detail = detail.replace(/[\s.]+$/, "").trim();
    if (detail.length < 8 || detail.length > 220 || NOT_A_DETAIL.test(detail)) return null;
    if (!KEEP_CAPITAL.test(detail)) detail = detail[0]!.toLowerCase() + detail.slice(1);
    return detail;
  }
  return null;
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`no value for {{${key}}}`);
    return value;
  });

/**
 * The shop's name as a person would write it, not its Google listing title: "Michael & Company Auto
 * Body And Auto Repair Shop in San Jose, Ca." -> "Michael & Company". The part before a dash or bar,
 * no "…, Complete Auto Repair" tail, no trailing "in <City>"; and on a long name (6+ words) a trailing
 * run of trade words. A short name like "Akins Auto Repair" is kept whole.
 */
export function emailShopName(name: string): string {
  let n = name.trim();
  const parts = n.split(/\s+[-–—|]\s+/);
  if (parts.length > 1 && parts[0]!.length >= 3) n = parts[0]!;
  n = n.replace(/,\s+(?:complete\s+|full[- ]service\s+)?(?:auto(?:motive)?|car)\b[^,]*$/i, "");
  n = n.replace(/\s+(?:shop\s+)?in\s+[A-Z][A-Za-z .'-]+?(?:,\s*(?:CA|Ca|California)\.?)?\.?$/i, "");
  if (n.split(/\s+/).length >= 6) {
    const trimmed = n.replace(/(?:\s+(?:auto|automotive|body|repair|shop|and|&|service|services|center|care|tires?|smog))+$/i, "");
    if (trimmed.split(/\s+/).length >= 2 && trimmed.length >= 6) n = trimmed;
  }
  return n.trim() || name.trim();
}

/** The cold email for one shop: the template exactly, filled in. Null when there is no detail to fill. */
export function renderColdEmail(lead: ColdEmailLead): { subject: string; text: string } | null {
  const shop = emailShopName(lead.shop_name);
  const detail = lead.personalized_detail.trim().replace(/[\s.]+$/, "");
  if (shop === "" || detail === "") return null;
  const values = { first_name: firstName(lead.contact_name), shop_name: shop, personalized_detail: detail, place: placeWord(lead.sector) };
  const template = lead.sector ? OUTREACH_TEMPLATE_GENERAL : OUTREACH_TEMPLATE;
  return { subject: fill(OUTREACH_SUBJECT, values), text: fill(template, values) };
}
