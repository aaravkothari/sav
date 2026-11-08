/**
 * `blank` — the template this company runs: the agency machine, crewed for an AI-receptionist
 * service for independent auto repair shops (`templates/receptionist.ts`). A shop is a client.
 *
 * Everything here is data: the crew, the setup questions whose answers the crew reads first, and
 * a demo seed that is plainly a demo. The demo rows never reach the browser bundle
 * (`src/no-seed.test.ts`). The screens' half of the template — kinds, words, site copy — is
 * `templates/index.ts`.
 */
import type { AgentDecl, DefineInput, Template } from "@usenaive-sdk/blueprints";
import type { Client } from "../seed/clients.ts";
import type { Post } from "../seed/posts.ts";
import { receptionistCrew, receptionistRoster } from "./receptionist.ts";
import { VOCABULARY, type TemplateKind } from "./index.ts";

export {
  AGENCY_IDENTITY, AGENCY_TIMEZONE, ASK_OPERATOR, budget, CONTEXT, crm, DAY_ONE, gate, HANDOFF, mailbox, MAILBOX_READ, MAILBOX_SEND,
  model, OPERATOR, OWN_RECORD, PREAMBLE, REQUEST_TOOLS, roster, timer, tools,
} from "./agents.ts";

/**
 * The blueprint's `Template` plus what a project-level declaration cannot hold: the ≤4 setup
 * questions this template asks (`defineProject({ questions })`, §7.1),
 * and the crew provisioned per client at onboarding, whose names carry the client's slug and so
 * cannot be declared statically. `server/proxy.ts` posts `crew` as it stands, with the slug appended
 * to each `name`; `naive.config.ts` publishes its `{name, role, description}` as `crew_per_client`.
 */
export interface AgencyTemplate extends Template {
  /** What an owner calls this template (≤80) — the studio prints "runs the <title> template". */
  title: NonNullable<DefineInput["title"]>;
  /**
   * The first week in the owner's words, for the studio's launch card. Only `day_one`: every
   * timer here is weekday-only or weekly, so an `every_day` line would claim weekends that do not
   * run. Days 2–7 read each timer's own `summary` instead (`templates/agents.ts`).
   */
  roadmap: NonNullable<DefineInput["roadmap"]>;
  questions: NonNullable<DefineInput["questions"]>;
  crew: AgentDecl[];
  /** The kinds this template's queue holds; the screens list them in this order. */
  kinds: TemplateKind[];
  /** The demo rows the store seeds on first run, keyed by collection (`clients`, `posts`). */
  seed: Record<string, unknown>;
  /** Every word a screen prints that changes with the template. */
  words: Record<string, string>;
}

/**
 * The people the operator already knows, for the first shop: most first customers come through
 * the founder's own network. Optional, because a list nobody has is one an agent would otherwise
 * be tempted to invent.
 */
export const networkQuestion: AgencyTemplate["questions"][number] = {
  key: "network",
  type: "text",
  optional: true,
  label: "Which shop owners do you already know?",
  help: "A name, their shop and how you know them. Outreach drafts a short personal note to each for you to review and send. Leave it blank to skip.",
  placeholder: "Dana Kim, Kim's Auto Repair, my mechanic for ten years; Sam Ortiz, Ortiz Brake & Tire, college friend.",
};

/**
 * The questions the studio asks before anything is provisioned. Their answers are the project
 * context every agent reads first. The keys are the blueprint's; the words are ours.
 */
export const questions: AgencyTemplate["questions"] = [
  {
    key: "offer",
    type: "text",
    label: "What does your receptionist do for a shop, and what does it promise?",
    help: "One or two sentences. Outreach and onboarding read this before every session; it is also the site's headline.",
    placeholder: "Answers every call 24/7, books appointments into the shop's calendar, and texts the owner a summary.",
  },
  {
    key: "ideal_client",
    type: "text",
    label: "Which shops are you after: type, size, area?",
    help: "Research builds its first list of shops from this.",
    placeholder: "Independent general repair shops, 2–10 bays, in the Austin metro.",
  },
  {
    key: "pricing",
    type: "text",
    label: "How do you price, and what is the typical range?",
    help: "Shapes the pricing section of the site and what outreach may quote.",
    placeholder: "$299/month per location, first 14 days free, no contract.",
  },
  networkQuestion,
];

/**
 * The blueprint's original agency questions, unchanged. `seo-geo` builds its own four on these;
 * this company's `blank` asks the receptionist questions above instead.
 */
export const agencyQuestions: AgencyTemplate["questions"] = [
  {
    key: "offer",
    type: "text",
    label: "What does your agency sell, and to whom?",
    help: "One or two sentences. The site-builder writes the hero from this; sales and the writers read it before every session.",
    placeholder: "Paid social and landing pages for DTC skincare brands doing $1–10M.",
  },
  {
    key: "ideal_client",
    type: "text",
    label: "Who is your ideal client — industry, size, geography?",
    help: "Sales builds its first prospect list from this on day one.",
    placeholder: "US and UK skincare brands, 5–50 staff, running paid social already.",
  },
  {
    key: "pricing",
    type: "text",
    label: "How do you price — retainer / project / hourly — and your typical range?",
    help: "Shapes the pricing section of the site and the proposal skeleton.",
    placeholder: "Monthly retainer, $4k–$12k, three-month minimum.",
  },
];

/** Demo rows the local store seeds on first run. Plainly fake; replace them with real shops. */
const clients: Client[] = [
  {
    id: "cli_dm01", slug: "demo-motors", name: "Demo Motors", domain: "demo-motors.example", stage: "active",
    services: ["Receptionist"],
    contact: { name: "Sample Owner", email: "owner@demo-motors.example", role: "Owner" },
    notes: ["Demo row — replace it with a shop of your own.", "Misses ~18 calls a week during lunch."],
    nextAction: "Review the first week's calls",
  },
  {
    id: "cli_dm02", slug: "demo-brake-tire", name: "Demo Brake & Tire", domain: "demo-brake-tire.example", stage: "proposal",
    services: [],
    contact: { name: "Sample Owner", email: "owner@demo-brake-tire.example", role: "Owner" },
    notes: ["Demo row — said yes to a trial, waiting on hours and services."],
    nextAction: "Collect hours and services",
  },
  {
    id: "cli_dm03", slug: "demo-garage", name: "Demo Garage", domain: "demo-garage.example", stage: "lead",
    services: [],
    contact: { name: "Sample Owner", email: "owner@demo-garage.example", role: "Service manager" },
    notes: ["Demo row — qualified by research, opener drafted."],
    nextAction: "Approve the opener",
  },
  {
    id: "cli_dm04", slug: "demo-lube-express", name: "Demo Lube Express", domain: "demo-lube-express.example", stage: "churned",
    services: ["Receptionist"],
    contact: { name: "Sample Owner", email: "owner@demo-lube-express.example", role: "Owner" },
    notes: ["Demo row — paused after two months."],
  },
];

const posts: Post[] = [
  { id: "post_dm101", clientId: "cli_dm01", title: "Greeting and call script", summary: "Demo row — what the receptionist says when it picks up.", kind: "script", channel: "blog", status: "pending", agent: "client-manager", scheduledFor: "2025-03-04", hue: 210 },
  { id: "post_dm102", clientId: "cli_dm01", title: "First-week call report", summary: "Demo row — calls answered, bookings made, anything missed.", kind: "report", channel: "blog", status: "posted", agent: "monitoring", scheduledFor: "2025-03-01", postedAt: "2d ago", hue: 30 },
  { id: "post_dm103", clientId: "cli_dm01", title: "After-hours greeting", summary: "Demo row — what callers hear when the shop is closed.", kind: "script", channel: "blog", status: "ready", agent: "client-manager", scheduledFor: "2025-03-06", hue: 160 },
  { id: "post_dm104", clientId: "cli_dm01", title: "Missed-call review", summary: "Demo row — the calls it could not book, and why.", kind: "audit", channel: "blog", status: "approved", agent: "monitoring", scheduledFor: "2025-03-12", hue: 280 },
  { id: "post_dm105", clientId: "cli_dm01", title: "Holiday hours script", summary: "Demo row — rejected so you can see what that looks like.", kind: "script", channel: "blog", status: "rejected", agent: "client-manager", scheduledFor: "2025-03-10", rejectedReason: "Demo row — rejected so you can see what that looks like.", hue: 0 },
];

export const blank: AgencyTemplate = {
  name: "blank",
  title: "AI Receptionist for Auto Shops",
  description: VOCABULARY.blank.description,
  roadmap: { day_one: "Crew, board and schedules set up", every_day: "New leads · Shop replies · Call checks" },
  kinds: VOCABULARY.blank.kinds,
  words: { ...VOCABULARY.blank.words },
  seed: { clients, posts },
  questions,
  /** One receptionist per shop, created as `booking--<slug>` when the shop goes active. */
  crew: receptionistCrew,
  agents: receptionistRoster,
};
