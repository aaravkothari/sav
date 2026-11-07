/**
 * The CRM's row shapes — shared by the store (`server/store.ts`), the screens (`src/data.ts`) and
 * every template's demo seed (`templates/*.ts`).
 *
 * The rows themselves are **template data** and live with their template: a blueprint's clients
 * are the operator's, and the demo ones are a sample of what the chosen template files. Plain
 * types only; nothing here touches the DOM or node.
 */

export type PipelineStage = "lead" | "proposal" | "active" | "churned";

/** The order `advance` walks; churned is a terminal side-exit, not a step. */
export const STAGE_ORDER: readonly PipelineStage[] = ["lead", "proposal", "active", "churned"];

/**
 * Where a client first came from. `site` is the public contact form, `manual` the operator's own
 * add-a-lead form, `outreach` an agent's prospecting, `network` someone the operator already knows,
 * and `referral` an introduction from an existing client (`referredBy`). A row filed before sources
 * existed has none, and reads as unknown.
 */
export type LeadSource = "site" | "manual" | "outreach" | "network" | "referral";

export const LEAD_SOURCES: readonly LeadSource[] = ["site", "manual", "outreach", "network", "referral"];

export interface Client {
  id: string;
  /** URL-safe handle; a template's per-client crew is suffixed with it (`seo-writer--acme`). */
  slug: string;
  name: string;
  domain: string;
  stage: PipelineStage;
  services: string[];
  contact: { name: string; email: string; role: string };
  notes: string[];
  nextAction?: string;
  /** Set when the client graduates and its agents are provisioned. */
  onboardedAt?: string;
  source?: LeadSource;
  /** The client (`cli_…`) that introduced this one, when `source` is `referral`. */
  referredBy?: string;
  /**
   * The private code in this client's referral link (`/?ref=…`). Random, never the slug, so a link
   * cannot be made from a name. Stamped when the client goes active.
   */
  referralCode?: string;
  /** When this client was last asked for an introduction (ISO time); the cooldown counts from it. */
  referralAskedAt?: string;
}

/**
 * When a client is ready to be asked for a referral (plan P3): long enough with the agency, recent
 * work they approved, nothing they turned down since, and not asked lately. Asking an unhappy or a
 * brand-new client costs more trust than any introduction brings.
 */
export const REFERRAL_READY = { activeDays: 30, recentDays: 60, minApproved: 2, cooldownDays: 90 } as const;
