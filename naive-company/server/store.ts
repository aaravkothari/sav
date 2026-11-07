/**
 * The dashboard's local file store: CRM clients and the content queue persist
 * as one JSON file under `data/`. Deliberately the least storage that works —
 * the upgrade path is the platform app database, noted in the README.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REFERRAL_READY, STAGE_ORDER, type Client, type LeadSource, type PipelineStage } from "../seed/clients.ts";
import type { Post, PostStatus } from "../seed/posts.ts";
import { sameShape, site, SITE_SECTIONS, withinBounds, type SiteProfile } from "../site/site.config.ts";
import { ACTIVE_TEMPLATE } from "../templates/active.ts";

/** A minted MCP credential: only the SHA-256 hash of the token is kept. */
export interface McpToken {
  id: string;
  name: string;
  hash: string;
  createdAt: string;
}

export interface StoreState {
  clients: Client[];
  posts: Post[];
  mcpTokens?: McpToken[];
  /** The public site. Absent on a document written before the site was data; read as the seed. */
  site_profile?: SiteProfile;
  /** The public lead form's fixed window. Absent until the first lead of the first window lands. */
  lead_window?: { startedAt: number; count: number };
}

/**
 * The rate the public contact form may file leads at, and why it is in the document rather than in
 * a variable. `OPEN_LEADS_CAP` bounds how many leads may be *open* — a spend and clutter bound —
 * but it bounds nothing about how fast they arrive, so a script filed the cap's worth in one burst
 * and every genuine lead for the next day was answered `429`. A rate is the missing bound. It
 * lives in the document because the deployed entry is a function: a per-process counter resets on
 * every cold start, which is to say it does not count.
 *
 * Ten an hour is far above what an agency's own site sees and far below what a script does, and it
 * puts the better part of a day between an empty inbox and a full one — long enough that the sales
 * agent's own morning pass (`advance_pipeline`) keeps ahead of it.
 */
export const LEAD_WINDOW_MS = 60 * 60 * 1000;
export const LEADS_PER_WINDOW = 10;

/** 12 URL-safe characters (72 random bits): unguessable, and short enough to read in a link. */
const newReferralCode = (): string => randomBytes(9).toString("base64url");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why a client may not be asked for a referral at `now`, or null when it may (`REFERRAL_READY`).
 * Recent work is judged by its calendar slot, the one date every post carries as an ISO day.
 */
export function referralRefusal(client: Client, posts: readonly Post[], now: Date): string | null {
  const { activeDays, recentDays, minApproved, cooldownDays } = REFERRAL_READY;
  const ago = (iso: string) => (now.getTime() - new Date(iso).getTime()) / DAY_MS;
  if (client.stage !== "active") return "only an active client is asked for a referral";
  if (client.onboardedAt === undefined || ago(client.onboardedAt) < activeDays) return `a client is asked only after ${activeDays} days with the agency`;
  if (client.referralAskedAt !== undefined && ago(client.referralAskedAt) < cooldownDays) return `this client was asked less than ${cooldownDays} days ago`;
  const recent = posts.filter((p) => p.clientId === client.id && ago(p.scheduledFor) >= 0 && ago(p.scheduledFor) <= recentDays);
  // A draft is usually turned down before its slot comes round, so a rejection counts whatever its slot.
  if (posts.some((p) => p.clientId === client.id && p.status === "rejected" && ago(p.scheduledFor) <= recentDays)) {
    return `this client turned down work in the last ${recentDays} days`;
  }
  if (recent.filter((p) => p.status === "approved" || p.status === "posted").length < minApproved) {
    return `a client is asked after approving at least ${minApproved} pieces in the last ${recentDays} days`;
  }
  return null;
}

/** Whole sections of the site, each replacing the current one; a key outside `SITE_SECTIONS` is refused. */
export type SitePatch = Partial<SiteProfile>;

export interface LeadInput {
  name: string;
  domain: string;
  contact: { name: string; email: string; role: string };
  services?: string[];
  note?: string;
  source?: LeadSource;
  referredBy?: string;
}

export interface DraftPostInput {
  clientId: string;
  title: string;
  summary: string;
  /** The draft itself. Absent when the agent filed only a line about it. */
  body?: string;
  kind: Post["kind"];
  channel: Post["channel"];
  scheduledFor: string;
  agent?: string;
  /** The platform files the deliverable is (`fil_…`); stored only when there is at least one. */
  files?: string[];
}

export interface PostPatch {
  status?: PostStatus;
  rejectedReason?: string;
  /** ISO day (YYYY-MM-DD) — reslots the piece on the calendar. */
  scheduledFor?: string;
}

export interface Store {
  read(): StoreState;
  createLead(input: LeadInput): Client;
  createDraftPost(input: DraftPostInput): Post | null;
  mcpTokens(): McpToken[];
  addMcpToken(name: string, hash: string): McpToken;
  removeMcpToken(id: string): boolean;
  advanceClient(id: string): Client | null;
  /** Appends a working note to the client and, when given, replaces what it is waiting on. */
  addClientNote(id: string, note: string, nextAction?: string): Client | null;
  /** Graduates the client to active and stamps the onboarding time; idempotent. */
  onboardClient(id: string): Client | null;
  /**
   * The client's referral code, stamped now when it has none (a client onboarded before links
   * existed). Null for a client that does not exist or is not active: only a client the agency works
   * for is asked to refer.
   */
  referralCode(id: string): string | null;
  /** The active clients ready to be asked for an introduction at `now` (`REFERRAL_READY`). */
  referralReady(now: Date): Client[];
  /** Stamps the ask on a ready client; says why when the client is not ready (the rule, or the cooldown). */
  recordReferralAsk(id: string, now: Date): { client: Client } | { refused: string };
  updatePost(id: string, patch: PostPatch): Post | null;
  /**
   * Counts one public lead against the current window and says whether it may be filed. False is
   * "not now", never "not ever": the window rolls.
   */
  admitLead(now: number): boolean;
  /** The public site as `GET /api/site` serves it. */
  site(): SiteProfile;
  /** Replaces the named sections; null when a key is not a section or a section is not the right shape. */
  updateSite(patch: Record<string, unknown>): SiteProfile | null;
}

/**
 * The active template's demo agency, for the local file store only (`openStore`). It never reaches
 * a deployment and never reaches the client bundle: seed rows are the template's sample, not the
 * operator's data, and a deployed dashboard that showed them would be presenting fiction as the
 * customer's CRM.
 */
export const seedState = (): StoreState => ({
  clients: structuredClone(ACTIVE_TEMPLATE.seed.clients as Client[]),
  posts: structuredClone(ACTIVE_TEMPLATE.seed.posts as Post[]),
  site_profile: structuredClone(site),
});

/**
 * What a fresh **deployed** document is created with: no rows, because nothing has happened yet,
 * and the active template's generic site — which claims nothing about anyone and is what the
 * site-builder rewrites from the setup answers on day one.
 */
export const emptyState = (): StoreState => ({ clients: [], posts: [], site_profile: structuredClone(site) });

/** The stage after `stage` on the happy path; churned only ever by hand. */
const next = (stage: PipelineStage): PipelineStage | null => {
  const candidate = STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
  return candidate === undefined || candidate === "churned" ? null : candidate;
};

/** Opens (and on first run seeds) the JSON store at `file`. */
export function openStore(file: string): Store {
  let state: StoreState;
  try {
    state = JSON.parse(readFileSync(file, "utf8")) as StoreState;
  } catch {
    state = seedState();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  }
  return openStoreOver(state, (next) => writeFileSync(file, JSON.stringify(next, null, 2)));
}

/**
 * The store's behaviour over a state that is already in hand, with persistence injected.
 *
 * The file store above is one caller; the deployed app's is the other — a serverless request has
 * no durable disk, so it loads the document from the app database, runs exactly this logic, and
 * writes the document back (`api/app` in the deploy tree). Keeping one implementation is why
 * `routes.ts` and every screen behave identically in both.
 */
export function openStoreOver(state: StoreState, persist: (state: StoreState) => void): Store {
  const save = () => persist(state);
  const nameOnly = (row: { domain: string; contact: { email: string } }) => row.domain === "" && row.contact.email === "";

  // Older installs allowed each intake to choose a different label for the agency itself. The CRM
  // has clients; it has exactly one internal workspace. Consolidate those legacy rows under the
  // first durable id, retaining their notes/services and repointing every queued deliverable.
  const internal = state.clients.filter(nameOnly);
  if (internal.length > 1) {
    const keeper = internal[0]!;
    const duplicates = new Set(internal.slice(1).map((row) => row.id));
    keeper.notes = [...new Set(internal.flatMap((row) => row.notes))];
    keeper.services = [...new Set(internal.flatMap((row) => row.services))];
    keeper.nextAction ??= internal.find((row) => row.nextAction !== undefined)?.nextAction;
    for (const post of state.posts) if (duplicates.has(post.clientId)) post.clientId = keeper.id;
    state.clients = state.clients.filter((row) => !duplicates.has(row.id));
    save();
  }

  return {
    read: () => state,
    createLead(input) {
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "client";
      // A name alone files the agency's own record; a second filing lands on the first. Only a row
      // filed the same way is the first: a prospect with a domain or a contact is never it.
      // Name is not identity here: independent agents may call the same workspace "agency",
      // project name, or public brand. A name-only row is always the one internal workspace.
      const twin = nameOnly(input) ? state.clients.find(nameOnly) : undefined;
      if (twin) {
        if (input.note !== undefined) {
          twin.notes.push(input.note);
          save();
        }
        return twin;
      }
      const client: Client = {
        id: `cli_${randomBytes(4).toString("hex")}`,
        slug,
        name: input.name,
        domain: input.domain,
        stage: "lead",
        services: input.services ?? [],
        contact: input.contact,
        notes: input.note === undefined ? [] : [input.note],
        // The agency's own name-only record is not a lead, so it has no source.
        ...(input.source && !nameOnly(input) ? { source: input.source } : {}),
        ...(input.referredBy && !nameOnly(input) ? { referredBy: input.referredBy } : {}),
      };
      state.clients.push(client);
      save();
      return client;
    },
    createDraftPost(input) {
      if (!state.clients.some((c) => c.id === input.clientId)) return null;
      const post: Post = {
        id: `post_${randomBytes(4).toString("hex")}`,
        clientId: input.clientId,
        title: input.title,
        summary: input.summary,
        ...(input.body === undefined ? {} : { body: input.body }),
        kind: input.kind,
        channel: input.channel,
        status: "pending",
        agent: input.agent ?? "mcp",
        scheduledFor: input.scheduledFor,
        ...(input.files === undefined || input.files.length === 0 ? {} : { files: [...input.files] }),
        hue: Math.floor(Math.random() * 360),
      };
      state.posts.push(post);
      save();
      return post;
    },
    mcpTokens: () => state.mcpTokens ?? [],
    addMcpToken(name, hash) {
      const token: McpToken = { id: `tok_${randomBytes(4).toString("hex")}`, name, hash, createdAt: new Date().toISOString() };
      (state.mcpTokens ??= []).push(token);
      save();
      return token;
    },
    removeMcpToken(id) {
      const before = state.mcpTokens?.length ?? 0;
      state.mcpTokens = (state.mcpTokens ?? []).filter((t) => t.id !== id);
      save();
      return state.mcpTokens.length < before;
    },
    advanceClient(id) {
      const client = state.clients.find((c) => c.id === id);
      if (!client) return null;
      const to = next(client.stage);
      if (to === null) return client;
      client.stage = to;
      // Active by the pipeline is onboarded too: the referral rule's 30 days count from this stamp.
      if (to === "active") client.onboardedAt ??= new Date().toISOString();
      save();
      return client;
    },
    addClientNote(id, note, nextAction) {
      const client = state.clients.find((c) => c.id === id);
      if (!client) return null;
      client.notes.push(note);
      if (nextAction !== undefined) client.nextAction = nextAction;
      save();
      return client;
    },
    onboardClient(id) {
      const client = state.clients.find((c) => c.id === id);
      if (!client || client.stage === "churned") return client ?? null;
      client.stage = "active";
      client.onboardedAt ??= new Date().toISOString();
      client.referralCode ??= newReferralCode();
      save();
      return client;
    },
    referralCode(id) {
      const client = state.clients.find((c) => c.id === id);
      if (!client || client.stage !== "active") return null;
      if (client.referralCode === undefined) {
        client.referralCode = newReferralCode();
        save();
      }
      return client.referralCode;
    },
    referralReady(now) {
      return state.clients.filter((c) => referralRefusal(c, state.posts, now) === null);
    },
    recordReferralAsk(id, now) {
      const client = state.clients.find((c) => c.id === id);
      if (!client) return { refused: "no such client" };
      const refused = referralRefusal(client, state.posts, now);
      if (refused !== null) return { refused };
      client.referralAskedAt = now.toISOString();
      save();
      return { client };
    },
    updatePost(id, patch) {
      const post = state.posts.find((p) => p.id === id);
      if (!post) return null;
      if (patch.status !== undefined) post.status = patch.status;
      if (patch.scheduledFor !== undefined) post.scheduledFor = patch.scheduledFor;
      if (patch.status === "posted") {
        post.postedAt = "just now";
        post.clicks ??= 0;
        post.impressions ??= 0;
      }
      if (patch.status === "rejected") post.rejectedReason = patch.rejectedReason ?? "Rejected by you";
      save();
      return post;
    },
    admitLead(now) {
      const window = state.lead_window;
      if (window === undefined || now - window.startedAt >= LEAD_WINDOW_MS) {
        state.lead_window = { startedAt: now, count: 1 };
        save();
        return true;
      }
      if (window.count >= LEADS_PER_WINDOW) return false;
      window.count += 1;
      save();
      return true;
    },
    site: () => state.site_profile ?? site,
    updateSite(patch) {
      const keys = Object.keys(patch);
      if (keys.length === 0) return null;
      const current = state.site_profile ?? structuredClone(site);
      for (const key of keys) {
        // Shape first, then size: `sameShape` has no opinion about how long a string may be, and
        // the section it is judging is about to become the live public page.
        if (!(SITE_SECTIONS as readonly string[]).includes(key)) return null;
        if (!sameShape(site[key as keyof SiteProfile], patch[key]) || !withinBounds(patch[key])) return null;
      }
      state.site_profile = { ...current, ...(patch as SitePatch) };
      save();
      return state.site_profile;
    },
  };
}
