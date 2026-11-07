/**
 * Pure proxy logic for the dashboard server: which `/api/*` paths map to which
 * platform routes, and how the upstream request is built. The org API key is
 * attached here — as an `Authorization` header on the *upstream* request only —
 * and never appears in anything sent back to the browser.
 */
import type { AgentDecl } from "@usenaive-sdk/blueprints";
import { ACTIVE_TEMPLATE } from "../templates/active.ts";
import { PROJECT } from "../templates/index.ts";

export interface Upstream {
  method: string;
  path: string;
  /** True for the session event relay — the response is piped, not buffered. */
  sse?: boolean;
}

/**
 * The only session filters that reach the platform. `GET /v1/sessions` refuses a parameter it does
 * not declare rather than dropping it (spec §9), so this is an allow-list and not a passthrough: a
 * caller cannot smuggle a filter through the dashboard that the platform would then reject.
 */
const SESSION_FILTERS = ["agent_id", "status", "stop_reason"] as const;

/**
 * Maps a browser-facing `/api/*` request onto the platform route it fronts.
 * Social/connection routes hang off a client's identity, so they need its
 * `idn_` id; without one they are unroutable and return null (503 upstream).
 */
export function upstreamFor(
  method: string,
  pathname: string,
  identityId: string | null,
  query?: URLSearchParams,
): Upstream | null {
  if (method === "POST" && pathname === "/api/chat") return { method: "POST", path: "/v1/sessions" };
  const stream = /^\/api\/chat\/(ses_[\w-]+)\/stream$/.exec(pathname);
  if (method === "GET" && stream) {
    return { method: "GET", path: `/v1/sessions/${stream[1]}/stream`, sse: true };
  }
  // The sessions a parked approval and an agent's history are both read out of. Nothing in the
  // dashboard could see either before: a tool held at `ask` stops the session and the operator was
  // never told, and an agent's cost and its last stop reason are session fields.
  if (method === "GET" && pathname === "/api/sessions") {
    const params = new URLSearchParams({ limit: "100" });
    for (const name of SESSION_FILTERS) {
      const value = query?.get(name);
      if (value) params.set(name, value);
    }
    return { method: "GET", path: `/v1/sessions?${params}` };
  }
  // Resolving a parked call: `{ tool_call_id, decision, reason }` (`canonical-spec §7`).
  const confirm = /^\/api\/sessions\/(ses_[\w-]+)\/tool_confirmations$/.exec(pathname);
  if (method === "POST" && confirm) {
    return { method: "POST", path: `/v1/sessions/${confirm[1]}/tool_confirmations` };
  }
  // Answering a parked question: `{ tool_call_id, answers }` (`canonical-spec §7.2`) — a sibling
  // route, because a held call takes a verb and a question takes a payload.
  const answer = /^\/api\/sessions\/(ses_[\w-]+)\/answers$/.exec(pathname);
  if (method === "POST" && answer) {
    return { method: "POST", path: `/v1/sessions/${answer[1]}/answers` };
  }
  // What an agent has spent this budget period, against the cap the agent itself carries.
  const spend = /^\/api\/agents\/(agt_[\w-]+)\/spend$/.exec(pathname);
  if (method === "GET" && spend) return { method: "GET", path: `/v1/agents/${spend[1]}/spend` };
  // `/api/agents` and `/api/deployments` are not here: both are cursor-paginated upstream, so the
  // route assembles them with `collect` below rather than relaying one page at a time.
  // Segments are strictly [\w-]+ so `..` can never traverse out of the social subtree.
  const social = /^\/api\/social((?:\/[\w-]+)+)$/.exec(pathname);
  if (social) {
    if (identityId === null) return null;
    return { method, path: `/v1/identities/${identityId}/social${social[1]}` };
  }
  return null;
}

export interface ProxyConfig {
  baseUrl: string;
  apiKey: string;
  identityId: string | null;
  /** The install this app belongs to (`NAIVE_PROJECT`, §29.7) — the row `/api/context` reads; the declaration's own name when the platform did not say. */
  project: string;
}

/** Reads the server's platform config from the environment; null when the key is absent. */
export function configFromEnv(env: Record<string, string | undefined>): ProxyConfig | null {
  const apiKey = env.NAIVE_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.NAIVE_API_URL ?? "https://api.usenaive.ai").replace(/\/$/, ""),
    identityId: env.NAIVE_IDENTITY_ID ?? null,
    project: env.NAIVE_PROJECT ?? PROJECT,
  };
}

/**
 * Performs the upstream call. The key lives only in the request's
 * `Authorization` header; the returned Response is the platform's own body,
 * which never contains it.
 */
export async function proxyFetch(
  config: ProxyConfig,
  upstream: Upstream,
  body: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(`${config.baseUrl}${upstream.path}`, {
    method: upstream.method,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      ...(body === null ? {} : { "content-type": "application/json" }),
    },
    ...(body === null ? {} : { body }),
  });
}

/**
 * Put a public-site inquiry in the agency persona's own inbox as well as its CRM. The anonymous
 * route remains bounded by the lead rate limiter, duplicate leads are not sent twice, and a mail
 * outage never discards the CRM row that is the source of truth.
 */
export async function notifyLead(
  config: ProxyConfig,
  lead: { id: string; name: string; domain: string; contact: { name: string; email: string }; services: string[]; notes: string[] },
  agencyAddress: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (config.identityId === null || agencyAddress.trim() === "") return false;
  const inboxes = await proxyFetch(
    config,
    { method: "GET", path: `/v1/identities/${config.identityId}/emails?limit=100` },
    null,
    fetchImpl,
  );
  if (!inboxes.ok) return false;
  const rows = ((await inboxes.json()) as { data?: { id?: string; address?: string }[] }).data ?? [];
  const sender = rows.find((row) => row.address?.toLowerCase() === agencyAddress.toLowerCase());
  // Providers suppress a message sent from an address back to that exact address. A separate
  // `leads@` inbox on the same identity still lands in the agency's native message feed and can
  // wake the sales owner, without routing the visitor's information to a personal mailbox.
  const recipient = rows.find((row) => row.address?.toLowerCase().startsWith("leads@")) ??
    rows.find((row) => row.address !== undefined && row.address.toLowerCase() !== agencyAddress.toLowerCase());
  if (sender?.id === undefined || recipient?.address === undefined) return false;
  const sent = await proxyFetch(
    config,
    { method: "POST", path: `/v1/identities/${config.identityId}/emails/${sender.id}/send` },
    JSON.stringify({
      to: [recipient.address],
      subject: `New Founder Frame inquiry: ${lead.name}`,
      text: [
        "A new inquiry was filed in the Founder Frame CRM.",
        "",
        `Lead: ${lead.name}`,
        `Website: ${lead.domain}`,
        `Contact: ${lead.contact.name} <${lead.contact.email}>`,
        `Services: ${lead.services.join(", ") || "Not specified"}`,
        `CRM ID: ${lead.id}`,
        ...(lead.notes[0] ? ["", lead.notes[0]] : []),
      ].join("\n"),
    }),
    fetchImpl,
  );
  return sent.ok;
}

/** A platform agent, as much of one as this dashboard ever reads. */
export interface AgentRow {
  id: string;
  name: string;
  current_version?: number;
}

/**
 * The organization's **whole** agent roster, following the cursor to the end (spec §9).
 *
 * `GET /v1/agents` pages — 20 by default, 100 at most — and an agency that has been running has one
 * three-agent crew per client on top of its own two, so page one is not the roster. Reading only it
 * is why `sales` and `client-manager` were absent from their own dashboard, why the agency chat
 * could not resolve `client-manager`, and why onboarding re-created a crew it could not see.
 *
 * Null when any page fails, never a partial roster: a half-read roster silently means "that agent
 * does not exist", which is the bug this replaces.
 */
export const listAgents = (config: ProxyConfig, fetchImpl: typeof fetch = fetch): Promise<AgentRow[] | null> =>
  collect<AgentRow>(config, "/v1/agents", fetchImpl);

/**
 * Every row of one cursor-paginated platform list (`canonical-spec §3`), or null when any page
 * failed. The timers are read this way too: a crew whose timer sat on the page that was not read
 * would show as "no timer" on its own dashboard.
 */
export async function collect<T>(config: ProxyConfig, path: string, fetchImpl: typeof fetch = fetch): Promise<T[] | null> {
  const all: T[] = [];
  let after: string | null = null;
  // The cursor is the platform's; the bound is ours, so an upstream that always says `has_more`
  // cannot spin a request forever. A hundred pages of a hundred is far past any real organization.
  for (let page = 0; page < 100; page += 1) {
    const query = after === null ? "?limit=100" : `?limit=100&after=${encodeURIComponent(after)}`;
    const res = await proxyFetch(config, { method: "GET", path: `${path}${query}` }, null, fetchImpl);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: T[]; has_more?: boolean; next_cursor?: string | null };
    all.push(...(body.data ?? []));
    if (body.has_more !== true || !body.next_cursor) return all;
    after = body.next_cursor;
  }
  return all;
}

/** One line of an install report (`canonical-spec §31.4`): an agent the apply touched, or the intake it opened. */
export interface ReportLine {
  name: string;
  action: string;
  id?: string;
  reason?: string;
}

/** An intake line with its session as read by id, or null when that read did not answer. */
export interface IntakeLine extends ReportLine {
  session: { status: string; stop_reason: string | null; waiting: boolean } | null;
}

export interface ContextReply {
  context: unknown;
  /** The `agt_` ids this install left standing: every platform figure on the home is cut to them. */
  team: { name: string; id: string }[];
  intake: IntakeLine[];
}

/**
 * An intake session read by its own id. The apply opened it on install day, and a session list is
 * the hundred most recent, so once the timers have run a while the list no longer holds it.
 */
async function intakeLine(config: ProxyConfig, line: ReportLine, fetchImpl: typeof fetch): Promise<IntakeLine> {
  if (line.action !== "created" || line.id === undefined) return { ...line, session: null };
  const res = await proxyFetch(config, { method: "GET", path: `/v1/sessions/${line.id}` }, null, fetchImpl);
  if (!res.ok) return { ...line, session: null };
  const session = (await res.json()) as { status: string; stop_reason: string | null; pending_actions?: unknown[] };
  return { ...line, session: { status: session.status, stop_reason: session.stop_reason, waiting: (session.pending_actions?.length ?? 0) > 0 } };
}

/**
 * THIS PROJECT'S CONTEXT (`canonical-spec §31.8`): the setup answers, apps and crew of its latest
 * applied install, found through the installs list narrowed to `PROJECT`, plus that install's
 * team and intake lines so the home screen can say which day-one sessions opened and how they
 * stand. `context: null` when the project has no applied install yet; null altogether when the
 * platform did not answer.
 */
export async function latestContext(config: ProxyConfig, fetchImpl: typeof fetch = fetch): Promise<ContextReply | null> {
  const list = await proxyFetch(config, { method: "GET", path: `/v1/blueprints/installs?project=${encodeURIComponent(config.project)}&limit=100` }, null, fetchImpl);
  if (!list.ok) return null;
  type Row = { id: string; status: string; applied_at: string; report?: { agents?: ReportLine[]; intake?: ReportLine[] } | null };
  const rows = ((await list.json()) as { data?: Row[] }).data ?? [];
  const latest = rows.filter((row) => row.status === "applied").sort((a, b) => b.applied_at.localeCompare(a.applied_at))[0];
  if (latest === undefined) return { context: null, team: [], intake: [] };
  const res = await proxyFetch(config, { method: "GET", path: `/v1/blueprints/installs/${latest.id}/context` }, null, fetchImpl);
  if (!res.ok) return null;
  return {
    context: await res.json(),
    team: (latest.report?.agents ?? [])
      .filter((row) => row.action !== "refused" && row.action !== "deleted" && row.id !== undefined)
      .map((row) => ({ name: row.name, id: row.id as string })),
    intake: await Promise.all((latest.report?.intake ?? []).map((row) => intakeLine(config, row, fetchImpl))),
  };
}

/** Redacted platform state used by the operator's release-readiness dashboard. */
export interface ProductAuditPlatform {
  project: string;
  observed_at: string;
  agents: ({ id: string; name: string; model?: string; budget?: unknown })[];
  deployments: ({ id?: string; agent_id?: string; status?: string; schedule?: string; cron?: string })[];
  sessions: ({
    id: string;
    agent_id: string;
    status: string;
    stop_reason: string | null;
    pending_actions?: unknown[];
    consumed_micro_usd?: number;
    created_at?: string;
  })[];
  context: ContextReply;
  identity: {
    id: string;
    name: string;
    emails: unknown[];
    domains: unknown[];
    connections: { id: string; connector: string; status: string; status_reason?: string | null }[];
  } | null;
  organization_domains: unknown[];
}

/** Read-only launch evidence. Credentials, connect links, messages and tool arguments stay out. */
export async function productAuditPlatform(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProductAuditPlatform | null> {
  type Agent = ProductAuditPlatform["agents"][number];
  type Deployment = ProductAuditPlatform["deployments"][number];
  type Session = ProductAuditPlatform["sessions"][number];
  const [agents, deployments, sessions, context, organizationDomains] = await Promise.all([
    collect<Agent>(config, "/v1/agents", fetchImpl),
    collect<Deployment>(config, "/v1/deployments", fetchImpl),
    collect<Session>(config, "/v1/sessions", fetchImpl),
    latestContext(config, fetchImpl),
    collect<unknown>(config, "/v1/domains", fetchImpl),
  ]);
  if (agents === null || deployments === null || sessions === null || context === null || organizationDomains === null) return null;

  let identity: ProductAuditPlatform["identity"] = null;
  if (config.identityId !== null) {
    const response = await proxyFetch(config, { method: "GET", path: `/v1/identities/${config.identityId}` }, null, fetchImpl);
    if (response.ok) {
      const row = (await response.json()) as {
        id?: string; name?: string; emails?: unknown[]; domains?: unknown[]; connections?: string[];
      };
      const connections = await Promise.all((row.connections ?? []).map(async (id) => {
        const found = await proxyFetch(config, { method: "GET", path: `/v1/connections/${id}` }, null, fetchImpl);
        if (!found.ok) return { id, connector: "unknown", status: "unavailable" };
        const value = (await found.json()) as { id?: string; connector?: string; status?: string; status_reason?: string | null };
        return {
          id: value.id ?? id,
          connector: value.connector ?? "unknown",
          status: value.status ?? "unknown",
          ...(value.status_reason === undefined ? {} : { status_reason: value.status_reason }),
        };
      }));
      identity = {
        id: row.id ?? config.identityId,
        name: row.name ?? "identity",
        emails: row.emails ?? [],
        domains: row.domains ?? [],
        connections,
      };
    }
  }

  return {
    project: config.project,
    observed_at: new Date().toISOString(),
    agents,
    deployments,
    sessions,
    context,
    identity,
    organization_domains: organizationDomains,
  };
}

export interface ProvisionReport {
  name: string;
  /**
   * `updated`: the declaration drifted from the live agent and was patched onto it. `kept`: a crew
   * agent of some other template of this blueprint, left exactly as it is.
   */
  action: "created" | "updated" | "unchanged" | "kept" | "failed";
}

/**
 * Grants one crew agent the persona its declaration names, and answers whether it landed.
 *
 * `POST /v1/agents` has no `identity` field — it strips what it does not declare — so an agent
 * created with `identity:` in its body holds no persona and is told nothing. The grant is its own
 * call (§22), it resolves the persona by name, and it is idempotent by design, so it is safe to
 * re-assert on a crew agent that already exists. Without it the member's connection tools resolve
 * to an empty list: the whole point of a crew that reads the client's own accounts.
 */
async function grantIdentity(
  config: ProxyConfig,
  agentId: string,
  identity: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const res = await proxyFetch(config, { method: "POST", path: `/v1/agents/${agentId}/identities` },
    JSON.stringify({ identity }), fetchImpl);
  return res.ok;
}

/** The agent a create or patch answered with, or null when the platform answered something else. */
async function agentOf(res: Response): Promise<{ id: string; current_version?: number } | null> {
  try {
    const body = (await res.json()) as { id?: unknown; current_version?: unknown };
    if (typeof body.id !== "string") return null;
    return { id: body.id, ...(typeof body.current_version === "number" ? { current_version: body.current_version } : {}) };
  } catch {
    return null;
  }
}

/**
 * Upserts the active template's per-client crew (`seo-writer--<slug>`, …) by name — the same
 * semantics the blueprints reconciler uses: a missing agent is created, an existing one has the
 * declaration patched onto it (`PATCH /v1/agents/:id` mints a version only when something
 * differs, so a crew that already matches is `unchanged`). The crew, its prompts, its model, its
 * budget, its allow-list and its persona are all template data (`templates/*.ts`); none of it is
 * decided here.
 *
 * **Widen, never narrow.** A crew agent this client already has that the *active* template does not
 * declare — the operator switched template, or switched to `blank`, which declares no crew — is
 * reported as `kept` and never touched. Deleting an agent is an explicit act, exactly as it is in
 * the reconciler, where only a `removed:` tombstone deletes anything.
 *
 * That rule is about **seats, not fields**. Within a seat the declaration is re-asserted whole and
 * never merged, so a member an operator widened by hand on the platform — an extra tool, a raised
 * budget, a longer prompt — is returned to what the template says the next time its client is
 * reconciled. That is deliberate and it is what makes a crew reproducible from `templates/*.ts`
 * alone; it is also what the agency's own seven get from the reconciler. A change meant to survive
 * belongs in the template, not on the live agent.
 *
 * **The persona is re-asserted every time**, on a member that was just created and on one that was
 * already there, exactly as the reconciler does for the agency's own agents: the grant is
 * idempotent, and a crew provisioned before this blueprint declared a persona would otherwise stay
 * unable to reach a single connected account for as long as it existed. `unchanged` therefore
 * describes the agent's own configuration and not the grant.
 *
 * A member whose persona did not land is reported `failed` even when the agent itself was created:
 * an agent with a search toolset and no identity is offered none of those tools, and reporting that
 * as a success is how the blueprint hid this in the first place.
 *
 * A `handoffs` list is slugged like the name: the template's `["seo-writer"]` becomes this client's
 * `seo-writer--<slug>` and no other client's. `true`, `false` and `"team"` pass through.
 *
 * Answers null when the roster itself cannot be read.
 */
export async function provisionClientAgents(
  config: ProxyConfig,
  slug: string,
  fetchImpl: typeof fetch = fetch,
  /** The active template's, injected like `fetchImpl` so both sides of a switch are testable. */
  crew: AgentDecl[] = ACTIVE_TEMPLATE.crew,
): Promise<ProvisionReport[] | null> {
  // The whole roster, not page one: a crew beyond the first page reads as missing and is created
  // again under the same name on every onboard.
  const roster = await listAgents(config, fetchImpl);
  if (roster === null) return null;
  const existing = new Map(roster.map((a) => [a.name, a]));
  const reports: ProvisionReport[] = [];
  const declared = new Set<string>();
  for (const member of crew) {
    const name = `${member.name}--${slug}`;
    declared.add(name);
    const present = existing.get(name);
    // `identity` is not a field of `POST /v1/agents`, and the route strips what it does not
    // declare: sending it would read as a grant and be none. It is the call below.
    const { identity: _persona, name: _seat, ...decl } = member;
    const handoffs = Array.isArray(decl.handoffs) ? decl.handoffs.map((target) => `${target}--${slug}`) : decl.handoffs;
    const res = present
      ? await proxyFetch(config, { method: "PATCH", path: `/v1/agents/${present.id}` }, JSON.stringify({ ...decl, handoffs }), fetchImpl)
      : await proxyFetch(config, { method: "POST", path: "/v1/agents" }, JSON.stringify({ ...decl, name, handoffs }), fetchImpl);
    // A refused CREATE leaves no agent behind, so there is nothing to grant a persona to and
    // nothing further to say about this seat. A refused PATCH is not the same event: the seat is
    // still standing and still reachable, and the grant is a call of its own (§22). Giving up here
    // would cost an existing crew the declaration AND the persona — so one unsupported or 5xx
    // PATCH would quietly take back every connected account the crew already had, which is the
    // opposite of what re-asserting the grant every onboard is for.
    if (!res.ok && present === undefined) {
      reports.push({ name, action: "failed" });
      continue;
    }
    const written = res.ok ? await agentOf(res) : null;
    const id = present ? present.id : written?.id ?? null;
    const granted =
      member.identity === undefined ||
      (id !== null && (await grantIdentity(config, id, member.identity, fetchImpl)));
    const action = !present ? "created" : written?.current_version !== present.current_version ? "updated" : "unchanged";
    reports.push({ name, action: res.ok && granted ? action : "failed" });
  }
  for (const agent of roster) {
    if (agent.name.endsWith(`--${slug}`) && !declared.has(agent.name)) reports.push({ name: agent.name, action: "kept" });
  }
  return reports;
}
