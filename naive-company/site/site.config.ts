/**
 * THE SEED OF THE PUBLIC SITE. The site is data: this object is the `site_profile` record the
 * dashboard store is created with (once, for the active template), the public site renders
 * whatever `GET /api/site` answers, and the site-builder agent rewrites it from the setup answers
 * through `dashboard.update_site` — every change waiting for the operator's approval. Components
 * never hard-code copy; they read the profile and nothing else.
 *
 * What the agency *does* is not written here twice: the hero, the services and the footer are the
 * active template's (`templates/index.ts`), so the public site sells the same specialism the
 * dashboard runs, and switching template changes both. Everything below that — your name, your
 * palette, your process and your prices — is a generic starting point the crew replaces.
 *
 * One rule that is not about taste: the proof strip carries facts about how the agency works and
 * **no number**, and there is no case study and no testimonial. A result is a factual claim about
 * someone else's business and a quote is words in a named person's mouth, so this template
 * carries neither — an unedited deploy must never publish client work nobody did.
 */

import { ACTIVE } from "../templates/index.ts";

export interface Service {
  name: string;
  headline: string;
  description: string;
  deliverables: string[];
}

export interface ProcessStep {
  title: string;
  description: string;
}

export interface PricingTier {
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  includes: string[];
  featured?: boolean;
}

/** The public site, as one record: `site_profile` in the store, the body of `GET /api/site`. */
export interface SiteProfile {
  company: string;
  tagline: string;
  /** One sentence of voice guidance for whoever (or whatever) rewrites the copy. */
  tone: string;
  /** Optional measurement for this one deployed agency; an empty id disables analytics. */
  analytics: { googleMeasurementId: string };
  /** The site's whole colour budget; everything else is ink on paper. */
  palette: { accent: string; accentInk: string; ground: string; ink: string; muted: string };
  hero: { eyebrow: string; title: string; subtitle: string; cta: string; secondaryCta: string };
  /** Facts about how the agency works — never a result, a count or a client name. */
  proof: { facts: string[] };
  services: Service[];
  whoWeServe: { title: string; subtitle: string; segments: { name: string; description: string }[] };
  process: { title: string; subtitle: string; steps: ProcessStep[] };
  pricing: { title: string; subtitle: string; tiers: PricingTier[] };
  faq: { title: string; items: { question: string; answer: string }[] };
  contact: { title: string; subtitle: string; email: string; offlineNote: string };
  footer: { note: string };
}

/** The section names an `update_site` may replace; anything else is refused by name. */
export const SITE_SECTIONS = [
  "company", "tagline", "tone", "analytics", "palette", "hero", "proof", "services", "whoWeServe", "process", "pricing", "faq", "contact", "footer",
] as const satisfies readonly (keyof SiteProfile)[];

/**
 * A section is accepted when it has the seed's shape all the way down: the same type, every key
 * the seed has, and each list's items shaped like the seed's first — so a page never renders a
 * tier without a price or a step without a title. The store judges an `update_site` by it and the
 * page judges what `GET /api/site` served by it.
 */
export const sameShape = (seed: unknown, value: unknown): boolean => {
  if (Array.isArray(seed)) {
    return Array.isArray(value) && (seed.length === 0 || value.every((item) => sameShape(seed[0], item)));
  }
  if (typeof seed !== "object" || seed === null) return typeof value === typeof seed;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const given = value as Record<string, unknown>;
  return Object.entries(seed).every(([key, inner]) => key in given && sameShape(inner, given[key]));
};

/**
 * The size a section may be, on top of the shape it must have. `sameShape` judges types and keys
 * and nothing else, so a perfectly shaped hero whose title is ten megabytes long passes it — and
 * the writer is a language model working from an operator's answers, so a runaway generation is
 * the ordinary failure here, not the exotic one. These are the page's own limits, with room to
 * spare: the longest thing the seed says is a two-sentence FAQ answer, and its longest list is
 * four items.
 */
export const MAX_TEXT = 2_000;
export const MAX_ITEMS = 24;

/** Every string and every list inside `value` within those bounds, all the way down. */
export const withinBounds = (value: unknown): boolean => {
  if (typeof value === "string") return value.length <= MAX_TEXT;
  if (Array.isArray(value)) return value.length <= MAX_ITEMS && value.every(withinBounds);
  if (typeof value === "object" && value !== null) return Object.values(value).every(withinBounds);
  return true;
};

/**
 * Whether a stored profile may replace the safe holding page on the public route. An incomplete
 * draft stays editable in the store; visitors keep seeing the holding profile until identity is
 * real and unsupported price, term, timeline and result language is absent.
 */
export function launchSafeSite(profile: SiteProfile): boolean {
  const copy = JSON.stringify(profile);
  const pricing = JSON.stringify(profile.pricing);
  const verifiedIdentity = profile.company.trim() !== "" && profile.company !== "Your agency" &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(profile.contact.email) && !/\.example$/i.test(profile.contact.email);
  // Dollar figures can legitimately describe the audience (for example "$2M–$50M ARR"). Only
  // the pricing section can publish this agency's price; promises and result claims remain unsafe
  // wherever they appear.
  const unsupportedPrice = /\$\s*\d|\b\d[\d,.]*\s*(?:%|per\s+month|\/month)/i.test(pricing);
  const unsupportedClaim = /month[- ]to[- ]month|first quarter|guarantee(?:d|s)?\b|within\s+\d+\s+(?:days?|weeks?)/i.test(copy);
  return verifiedIdentity && !unsupportedPrice && !unsupportedClaim;
}

export const site: SiteProfile = {
  // A fresh install is public before the site-builder's first approved rewrite. Keep that state
  // deliberately generic and commercially silent: setup supplies the real brand, contact and
  // pricing posture, but an interrupted intake must never leave invented terms on the internet.
  company: "Your agency",
  tagline: ACTIVE.site.tagline,
  tone: "Confident, plain-spoken, evidence-first. No jargon, no hype.",
  analytics: { googleMeasurementId: "" },
  palette: { accent: "#1d4ed8", accentInk: "#ffffff", ground: "#fbfaf8", ink: "#111114", muted: "#63605a" },
  hero: {
    eyebrow: ACTIVE.site.eyebrow,
    title: ACTIVE.site.title,
    subtitle: ACTIVE.site.subtitle,
    cta: ACTIVE.site.cta,
    secondaryCta: "See how we work",
  },
  proof: {
    facts: [
      "Every deliverable passes your approval queue before it ships.",
      "Public claims require a source or explicit operator approval.",
      "Campaign changes and spend remain operator-controlled.",
    ],
  },
  services: ACTIVE.site.services,
  whoWeServe: {
    title: "Who we work with",
    subtitle: "Companies that want the work shown before it ships and the scope agreed before work begins.",
    segments: [
      { name: "Founder-led companies", description: "You are the marketing team. We bring a documented plan; you keep the last word." },
      { name: "Small marketing teams", description: "One or two people who need production capacity without losing control of the voice." },
      { name: "Multi-location businesses", description: "Several sites or markets that need one plan and one report." },
    ],
  },
  process: {
    title: "How an engagement runs",
    subtitle: "Four steps, no mystery. Scope and timing are agreed with the operator before work begins.",
    steps: [
      { title: "Baseline", description: "We document the available evidence and the questions the engagement must answer." },
      { title: "Plan", description: "We agree the deliverables, measurement approach and operator-controlled boundaries." },
      { title: "Ship", description: "Every public deliverable passes through your approval queue first." },
      { title: "Review", description: "We compare completed work with the agreed evidence and decide the next scope together." },
    ],
  },
  pricing: {
    title: "Scoped pricing",
    subtitle: "Choose the work first. Commercial terms are provided only after the operator confirms the scope.",
    tiers: [
      {
        name: "Foundation",
        price: "Custom",
        cadence: "",
        blurb: "For teams that need a baseline and a prioritized first scope.",
        includes: ["Evidence review", "Prioritized scope", "Operator approval", "Handoff plan"],
      },
      {
        name: "Growth",
        price: "Custom",
        cadence: "",
        blurb: "For teams that need an ongoing, approval-gated delivery program.",
        includes: ["Everything in Foundation", "Agreed delivery scope", "Measurement plan", "Named owner"],
        featured: true,
      },
      {
        name: "Partner",
        price: "Custom",
        cadence: "",
        blurb: "For multi-site or multi-market programs that require a tailored operating model.",
        includes: ["Everything in Growth", "Multi-domain planning", "Custom dashboard scope", "Governance plan"],
      },
    ],
  },
  faq: {
    title: "Questions we get asked",
    items: [
      { question: "Who approves what goes out?", answer: "You do. Every draft, post and page waits in an approval queue until you release it; nothing is sent or published on your behalf." },
      { question: "How quickly does an engagement start?", answer: "Timing is agreed after the operator confirms the scope, required access and approval owner." },
      { question: "What do you need from us?", answer: "The relevant account access, one approval owner and the evidence needed to support public claims." },
      { question: "What are the commercial terms?", answer: "Pricing, term and cadence are custom-scoped and are not published until the operator approves them." },
    ],
  },
  contact: {
    title: ACTIVE.site.cta,
    subtitle: ACTIVE.site.contactSubtitle,
    email: "",
    offlineNote: "Contact details will appear after the operator verifies the agency inbox.",
  },
  footer: { note: ACTIVE.site.footerNote },
};
