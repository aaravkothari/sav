/**
 * The `agency` blueprint's templates — the half a screen may read — and the one line that chooses
 * between them.
 *
 * The **blueprint** is the machine, and it is shared: the screens, `/api/*`, `/mcp`, the store and
 * its row lock, the operator bearer, the build, the deploy, the approval flow, the empty-state
 * policy. None of that is in here or in any template.
 *
 * A **template** is data: the agents and their prompts, their tool allow-lists, the deliverable
 * kinds, the schedules, the demo seed, the screen vocabulary and the onboarding copy. This repo
 * carries every template the blueprint has, so switching is the edit below plus `naive up` — never
 * a re-clone, never a new app, and never a lost row.
 *
 * Switching **widens and never narrows**: `naive up` creates the agents the new template declares
 * and reports the ones only the old one did (`kept` in the engine, and `provisionClientAgents` for
 * the per-client crew), and the operator's own rows — clients, posts, connections, the app, its URL,
 * its MCP token — are never touched by a switch.
 *
 * This module is the browser's half, so it carries no agents and no demo rows: those live in
 * `templates/blank.ts`, `templates/seo-geo.ts` and `templates/product-design.ts`, which only the
 * config and the server import.
 */
/**
 * One kind of work a template files — a deliverable kind, a post kind. `id` is what rows carry.
 * Declared here since engine 0.11, whose `Template` is only what the platform reads (name,
 * description, agents); the screens' half of a template is this blueprint's own business.
 */
export interface TemplateKind {
  id: string;
  label: string;
  description?: string;
}

export type TemplateName = "blank" | "seo-geo" | "product-design";

/**
 * The project's name on the platform — `defineProject({ name })` and the `?project=` the dashboard
 * narrows the installs list by when it looks up this project's context (`server/proxy.ts`).
 */
export const PROJECT = "autoshop-receptionist";

/** The words a screen prints that change with the template. The layout around them does not. */
export interface TemplateWords {
  /** The demo agency's name in the rail — rename it to yours. */
  brand: string;
  crmSubtitle: string;
  /** What graduating a client to active actually does under this template. */
  onboarding: string;
  clientsSubtitle: string;
  noActiveClients: string;
  agentsSubtitle: string;
  /** The client's Agents tab when the platform reports no crew for that client. */
  noCrew: string;
}

/** The specialism-bearing half of the public site; the rest of `site/site.config.ts` is the operator's. */
export interface TemplateSite {
  /** The one line under the company name. */
  tagline: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  cta: string;
  services: { name: string; headline: string; description: string; deliverables: string[] }[];
  contactSubtitle: string;
  footerNote: string;
}

export interface TemplateVocabulary {
  /** One line for the operator, shown on Settings. */
  description: string;
  /** The kinds of deliverable this template files; the screens name them in this order. */
  kinds: TemplateKind[];
  words: TemplateWords;
  site: TemplateSite;
}

const blank: TemplateVocabulary = {
  description: "An AI receptionist for independent auto repair shops: research, outreach, onboarding, a receptionist per shop, monitoring and self-improvement, coordinated by the CEO.",
  kinds: [
    { id: "script", label: "Call script", description: "What a shop's receptionist says: greeting, questions, booking rules." },
    { id: "report", label: "Report", description: "Calls answered, bookings made and anything missed, per shop." },
    { id: "audit", label: "Review", description: "A review of a shop's calls with suggested changes." },
    { id: "post", label: "Social post", description: "A drafted X or Reddit post about SAV, for a person to review and post." },
    { id: "ad", label: "Ad idea", description: "An ad concept: audience, hook, copy and where it would run. Never live spend." },
  ],
  words: {
    brand: "Shop Receptionist",
    crmSubtitle: "Every shop, by pipeline stage — research files them, outreach works this board.",
    onboarding:
      "Moving a shop to active onboards it and creates its receptionist (booking--<shop>), which answers its calls and books appointments.",
    clientsSubtitle: "Every live shop — open one to see its receptionist, calls and reports.",
    noActiveClients: "No live shops yet — advance one on the CRM.",
    agentsSubtitle: "The crew that runs the company, and each shop's receptionist.",
    noCrew: "No receptionist for this shop yet — moving it to active creates one.",
  },
  site: {
    tagline: "Every call answered. Every appointment booked.",
    eyebrow: "Calls · Bookings · Reports",
    title: "The receptionist your shop never had time to hire.",
    subtitle:
      "An AI receptionist that answers every call while you are under a car, books the appointment, and tells you what came in.",
    cta: "Start a free trial",
    services: [
      {
        name: "Answering",
        headline: "No more missed calls",
        description: "Every call picked up, day or night, in your shop's own greeting.",
        deliverables: ["24/7 answering", "Your greeting and hours", "Common questions handled", "Hand-off to you when it matters"],
      },
      {
        name: "Booking",
        headline: "Appointments straight into your calendar",
        description: "Callers are booked for the services you offer, in the slots you keep open.",
        deliverables: ["Booking rules per service", "Confirmation to the caller", "No double-booking", "Changes approved by you"],
      },
      {
        name: "Reporting",
        headline: "Know what came in",
        description: "A short summary of every day's calls and bookings, and anything that needs you.",
        deliverables: ["Daily summary", "Missed-call alerts", "Weekly report", "Suggestions to book more"],
      },
    ],
    contactSubtitle: "Tell us about your shop. We reply within one business day.",
    footerNote: "AI receptionists for independent auto repair shops.",
  },
};

const seoGeo: TemplateVocabulary = {
  description: "The agency, specialised in search: audits, SERP work and answer-engine optimization, with a team per client.",
  kinds: [
    { id: "article", label: "Article", description: "A ranking article written against the client's keyword map." },
    { id: "landing-page", label: "Landing page", description: "A page built for one query and one intent." },
    { id: "answer-block", label: "Answer block", description: "An entity-dense Q&A block written to be cited by AI answer engines." },
    { id: "serp-report", label: "SERP report", description: "Where the client ranks, and against whom." },
    { id: "audit", label: "Audit", description: "A technical and content sweep of the client's site." },
    { id: "ad-plan", label: "Paid ad plan", description: "A channel, audience, creative, budget-scenario and measurement proposal; never live spend." },
  ],
  words: {
    brand: "Meridian Search",
    crmSubtitle: "Every prospect and client, by pipeline stage — the sales agent works this board, search presence first.",
    onboarding:
      "Moving a client to active onboards them and provisions their team — an SEO writer, a GEO optimizer and an audit runner, each named for the client.",
    clientsSubtitle: "Every active engagement — open one to see its connections, calendar, team and deliverables.",
    noActiveClients: "No active clients yet — advance one on the CRM.",
    agentsSubtitle: "Every agent working for this agency — the seven that run it, and each client's team.",
    noCrew: "No agents for this client yet — onboarding a client provisions its team.",
  },
  site: {
    tagline: "Be the answer, everywhere people ask.",
    eyebrow: "SEO · GEO · Content",
    title: "Search is changing. Your visibility shouldn't.",
    subtitle:
      "We make companies findable in classic search and in AI answers alike — technical SEO, generative-engine optimization and content that earns citations, not just clicks.",
    cta: "Request a free audit",
    services: [
      {
        name: "SEO",
        headline: "Rank where buying decisions start",
        description:
          "Technical audits, site architecture and on-page work that compound. We fix what blocks crawlers before we chase keywords.",
        deliverables: ["Technical & content audits", "Keyword and topic maps", "Internal-link architecture", "Monthly ranking reports"],
      },
      {
        name: "GEO",
        headline: "Get cited by AI answer engines",
        description:
          "Generative-engine optimization: structured data, entity coverage, answer blocks and llms.txt so assistants quote you as the source.",
        deliverables: ["AI-citation baselines", "Schema & entity coverage", "llms.txt and answer blocks", "Citation tracking reports"],
      },
      {
        name: "Content",
        headline: "Pages that earn links and answers",
        description:
          "Briefs, pillar pages and landing copy written against your keyword map and reviewed by you before anything ships.",
        deliverables: ["Editorial calendar", "Pillar pages & briefs", "Landing-page copy", "Approval workflow — nothing posts unseen"],
      },
    ],
    contactSubtitle: "Tell us where you want to be found. We reply within one business day with a baseline of where you stand.",
    footerNote: "Search & generative-engine optimization.",
  },
};

/**
 * `product-design` — a studio for physical products, not a marketing agency. A deliverable is a
 * file the operator approves: a concept mesh (a look, no units), a studio still, a dimensioned part
 * (STEP + STL, checked) or a product video. It runs on the same machine — CRM, site, approvals —
 * and adds one screen, Studio, where those files are shown (`src/screens/Studio.tsx`).
 */
const productDesign: TemplateVocabulary = {
  description: "A product design studio: concept meshes for looks, dimensioned parts when a brief names millimetres, studio stills, and product video on request — every file held for your approval.",
  kinds: [
    { id: "concept", label: "Concept mesh", description: "A textured 3D look, no units." },
    { id: "still", label: "Studio still", description: "A product image on a plain background." },
    { id: "part", label: "Dimensioned part", description: "STEP + STL, checked." },
    { id: "product-video", label: "Product video", description: "A short clip of the product, made only when the brief asks." },
  ],
  words: {
    brand: "Lumen Product Studio",
    crmSubtitle: "Every brand that briefs the studio, by pipeline stage — the account manager reads each brief against the studio note.",
    onboarding:
      "Moving a client to active starts their briefs: the account manager routes each one to the designer, the engineer or the visualizer, and every file they make waits on Studio for you.",
    clientsSubtitle: "Every active client — open one to see its briefs, calendar and deliverables.",
    noActiveClients: "No active clients yet — advance one on the CRM.",
    agentsSubtitle: "The studio's four: account manager, designer, engineer and visualizer.",
    noCrew: "This studio runs every brief through its four designers.",
  },
  site: {
    tagline: "Physical products, designed and shown before they are made.",
    eyebrow: "Concept · Engineering · Visuals",
    title: "A product studio that shows you the object before anyone makes it.",
    subtitle:
      "We turn a brief into a concept you can turn around in 3D, a part dimensioned to the millimetre when it has to fit, and studio images to sell it — every file approved by you before it leaves.",
    cta: "Send a brief",
    services: [
      {
        name: "Concept",
        headline: "See the look before you commit",
        description: "A textured 3D concept of the product from your brief, to turn around and judge — a look, not a drawing.",
        deliverables: ["Concept mesh (GLB)", "Material and colour direction", "One round of changes per brief", "Approval before anything leaves"],
      },
      {
        name: "Engineering",
        headline: "Parts that fit, to the millimetre",
        description: "When a brief gives sizes, we model the part to them and check it before handing it over.",
        deliverables: ["STEP and STL files", "Checked bounding box and volume", "Preview render", "Nothing sent to a manufacturer without you"],
      },
      {
        name: "Visuals",
        headline: "Images that sell the product",
        description: "Studio stills on a plain background, and a short product video when the brief asks for one.",
        deliverables: ["Studio still", "Product video on request", "No text, logo or watermark added", "Approval workflow — nothing ships unseen"],
      },
    ],
    contactSubtitle: "Tell us what the product is and who it is for. We reply within one business day.",
    footerNote: "Concept, engineering and visuals for physical products.",
  },
};

export const VOCABULARY: Record<TemplateName, TemplateVocabulary> = { blank, "seo-geo": seoGeo, "product-design": productDesign };

/**
 * **The line you edit to switch template**, then `naive up`. `naive.config.ts` declares it to the
 * platform and every screen reads it from here, so the dashboard, the site, the MCP tool schema and
 * the crew provisioned at onboarding can never disagree about which template is running.
 */
/**
 * The template this repository runs. Editing this line and running `naive up` is the switch, and
 * for an operator that is the whole story.
 *
 * `NAIVE_TEMPLATE` overrides it, and exists for exactly one caller: the platform's artifact
 * publisher builds EVERY template of this repository in one pass and cannot edit a file it does not
 * own between builds. Without the override it asked for `blank` and got this line's answer back, so
 * only the default template could ever be published. Unset — every run that is not that publisher —
 * nothing changes.
 *
 * The fallback is `blank`, the platform's own default for this blueprint (`BLUEPRINTS.agency.default`),
 * so a clone and a studio install with no template named get the same agency.
 */
const chosen = (process.env["NAIVE_TEMPLATE"] ?? "blank");
export const TEMPLATE: TemplateName =
  chosen === "blank" || chosen === "seo-geo" || chosen === "product-design" ? chosen : "blank";

export const ACTIVE = VOCABULARY[TEMPLATE];

/** The label for a stored kind; a kind from another template shows its own id rather than nothing. */
export const kindLabel = (kind: string): string => ACTIVE.kinds.find((k) => k.id === kind)?.label ?? kind;
