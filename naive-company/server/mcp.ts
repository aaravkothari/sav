/**
 * The `/mcp` endpoint: MCP streamable-HTTP is JSON-RPC over POST, so the
 * subset outside agents actually need (initialize, tools/list, tools/call)
 * is implemented by hand — no SDK dependency. Every tool is a thin layer
 * over the same `store.ts` + `proxy.ts` the dashboard uses.
 *
 * Auth: bearer tokens minted from the Settings screen, kept in the file
 * store as SHA-256 hashes, plus the one the platform mints for the app's
 * own agents (`VETTA_MCP_TOKEN`, handed in by the entry point). The
 * platform API key is never an MCP credential.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { listAgents, proxyFetch, type AgentRow, type ProxyConfig } from "./proxy.ts";
import { SITE_SECTIONS } from "../site/site.config.ts";
import { ACTIVE } from "../templates/index.ts";
import type { DraftPostInput, Store } from "./store.ts";
import type { LeadSource } from "../seed/clients.ts";
import { FILE_ID, MAX_POST_FILES, POST_CHANNELS, type PostChannel } from "../seed/posts.ts";

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Constant-time equality for two secrets of any length — the digests are compared, never the
 * strings, so neither the length nor the first differing byte is readable from the timing.
 * Every bearer this app checks goes through here: `/mcp`'s tokens and `/api/*`'s `DASHBOARD_TOKEN`.
 */
export const sameSecret = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** Mints a new bearer token; only its hash is persisted. */
export function mintToken(store: Store, name: string): { id: string; name: string; token: string; createdAt: string } {
  const token = `mcp_${randomBytes(24).toString("hex")}`;
  const record = store.addMcpToken(name, hashToken(token));
  return { id: record.id, name: record.name, token, createdAt: record.createdAt };
}

/** The token out of an `Authorization: Bearer …` header, or null when there is not one. */
export const bearerOf = (authHeader: string | undefined): string | null =>
  /^Bearer\s+(\S+)$/i.exec(authHeader ?? "")?.[1] ?? null;

/**
 * A PLATFORM ENTRY TICKET: `<expiry-ms>.<base64url HMAC-SHA256>`, keyed by this app's own
 * `DASHBOARD_TOKEN` over `vetta.app-entry.v1:<expiry-ms>` (`canonical-spec §29.7`).
 *
 * The point of the shape is what it is NOT. The operator's browser is handed a ticket and never the
 * token: the ticket is a one-way function of it, so one read out of a log, a history entry or a
 * `Referer` is worth two minutes and cannot be turned back into the bearer this app compares. The
 * expiry rides in the clear because this function has to read it before it can reject a stale one,
 * and inside the MAC because otherwise it would be the one field a holder could edit.
 */
export function ticketMatches(token: string, ticket: string, now: number): boolean {
  const [expiry, mac] = ticket.split(".");
  const expiresAt = Number(expiry);
  if (mac === undefined || !Number.isSafeInteger(expiresAt) || now >= expiresAt) return false;
  return sameSecret(createHmac("sha256", token).update(`vetta.app-entry.v1:${expiresAt}`).digest("base64url"), mac);
}

/**
 * True when the Authorization header carries a minted, unrevoked token, or
 * the platform token when one was injected (unset or empty disables that path).
 */
export function authorized(store: Store, authHeader: string | undefined, platformToken?: string): boolean {
  const token = bearerOf(authHeader);
  if (token === null) return false;
  if (platformToken && sameSecret(platformToken, token)) return true;
  const hash = hashToken(token);
  return store.mcpTokens().some((t) => sameSecret(t.hash, hash));
}

interface JsonRpcRequest { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

const obj = (props: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties: props, required }) as const;
const str = (description: string) => ({ type: "string", description }) as const;

/** The sources an agent may name. `site` and `manual` belong to the two forms, never to an agent. */
const AGENT_SOURCES = ["outreach", "network", "referral"] as const satisfies readonly LeadSource[];

export const TOOLS = [
  { name: "list_clients", description: "All CRM clients with their pipeline stage.", inputSchema: obj({}, []) },
  { name: "get_client", description: "One client by id.", inputSchema: obj({ id: str("Client id (cli_…)") }, ["id"]) },
  { name: "create_lead", description: "Add a new lead to the CRM pipeline. Only the name is required: file what you know and leave the rest for the operator. A name alone, with no domain and no contact_email, is always the agency's own record: if that record exists it is returned, whatever name you give. To file a client or prospect, give its domain or contact_email.", inputSchema: obj({
    name: str("Company name"), domain: str("Company domain, when known"),
    contact_name: str("Contact person, when known"), contact_email: str("Contact email, when known"), contact_role: str("Contact role, when known"),
    note: str("Optional first note"),
    source: { type: "string", enum: AGENT_SOURCES, description: "Where this lead came from: outreach (your own prospecting, the default), network (someone the operator already knows) or referral (an existing client introduced them; give referred_by)" },
    referred_by: str("For a referral: the id (cli_…) of the client who introduced them"),
  }, ["name"]) },
  { name: "get_referral_link", description: "An active client's private referral link to the agency's contact form. Whoever fills the form in through it is filed as a referral from that client, so quote this link exactly; never write one yourself.", inputSchema: obj({ client: str("Client id (cli_…), an active client") }, ["client"]) },
  { name: "list_referral_ready", description: "The active clients ready to be asked for an introduction right now: with the agency at least 30 days, at least two pieces approved in the last 60, none turned down since, and not asked in the last 90. Each comes with its contact and referral link. Ask only these.", inputSchema: obj({}, []) },
  { name: "record_referral_ask", description: "Record that you drafted a referral ask for this client, which starts its 90-day cooldown. Refused, with the reason, for a client list_referral_ready would not name.", inputSchema: obj({ client: str("Client id (cli_…)") }, ["client"]) },
  { name: "advance_pipeline", description: "Move a client to the next pipeline stage.", inputSchema: obj({ id: str("Client id") }, ["id"]) },
  { name: "add_client_note", description: "File a working note on a client — a drafted outreach or follow-up, a call summary, what a proposal is waiting on — for the operator to read on the client's page. Optionally restate what the client is waiting on next.", inputSchema: obj({
    id: str("Client id"), note: str("The note in full — a drafted follow-up goes here verbatim"),
    next_action: str("Optional: what this client is waiting on now, replacing the previous next action"),
  }, ["id", "note"]) },
  { name: "list_posts", description: "Content queue for a client, optionally filtered by state.", inputSchema: obj({
    client: str("Client id"), state: str("Optional status filter: pending|ready|approved|posted|rejected"),
  }, ["client"]) },
  { name: "create_draft_post", description: "Add a pending draft to a client's content queue.", inputSchema: obj({
    client: str("Client id"), title: str("Title"), summary: str("One-line summary"),
    body: str("The draft itself, in full — this is what the operator reads before approving it."),
    kind: str(ACTIVE.kinds.map((k) => k.id).join("|")), channel: str(POST_CHANNELS.join("|")),
    scheduled_for: str("ISO day (YYYY-MM-DD); on channel studio the filing day is stamped instead"),
    files: {
      type: "array", maxItems: MAX_POST_FILES, items: { type: "string", pattern: FILE_ID.source },
      description: `Optional: the platform files this deliverable is (fil_… ids, at most ${MAX_POST_FILES}) — a mesh and its still, a part's STEP, STL and preview. Shown on the Studio screen for approval.`,
    },
  }, ["client", "title", "summary", "kind", "channel", "scheduled_for"]) },
  { name: "approve_post", description: "Approve a post for publishing.", inputSchema: obj({ id: str("Post id") }, ["id"]) },
  { name: "schedule_post", description: "Reslot a post on the calendar.", inputSchema: obj({
    id: str("Post id"), date: str("ISO day (YYYY-MM-DD)"),
  }, ["id", "date"]) },
  { name: "list_agents", description: "Platform agents, optionally only one client's team.", inputSchema: obj({ client: str("Optional client id") }, []) },
  { name: "start_agent_session", description: "Start a session with a platform agent.", inputSchema: obj({
    agent: str("Agent name"), prompt: str("Opening message"),
  }, ["agent", "prompt"]) },
  { name: "get_calendar", description: "Posts for a client within a date range.", inputSchema: obj({
    client: str("Client id"), from: str("ISO day, inclusive"), to: str("ISO day, inclusive"),
  }, ["client", "from", "to"]) },
  { name: "get_site", description: "The agency's public site as it is published: every section, as one record.", inputSchema: obj({}, []) },
  { name: "update_site", description: "Replace whole sections of the public site. Each key given replaces that section in full and must keep its shape (read get_site first); the change is live once the operator approves this call. Never invent a result, a number or a client name.", inputSchema: obj({
    site: { type: "object", description: `Sections to replace: any of ${SITE_SECTIONS.join(", ")}.` },
  }, ["site"]) },
] as const;

class ToolError extends Error {}
const need = (params: Record<string, unknown>, key: string): string => {
  const value = params[key];
  if (typeof value !== "string" || value === "") throw new ToolError(`${key} is required`);
  return value;
};
const text = (params: Record<string, unknown>, key: string): string =>
  typeof params[key] === "string" ? (params[key] as string) : "";

/**
 * `files` as an agent sent it: absent is none; anything else must be a list of at most
 * `MAX_POST_FILES` platform file ids. Refused whole, never trimmed — a deliverable filed without the
 * file the agent meant to attach is one the operator would approve blind.
 */
function fileIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolError("files must be a list of fil_ ids");
  if (value.length > MAX_POST_FILES) throw new ToolError(`files takes at most ${MAX_POST_FILES} ids`);
  const bad = value.filter((id) => typeof id !== "string" || !FILE_ID.test(id));
  if (bad.length > 0) throw new ToolError(`files must hold only platform file ids (fil_…); refused: ${bad.map((id) => JSON.stringify(id)).join(", ")}`);
  return [...new Set(value as string[])];
}

/** The whole roster, cursor followed: a crew on page four is an agent this tool can still start. */
async function platformAgents(config: ProxyConfig | null): Promise<AgentRow[]> {
  if (config === null) throw new ToolError("platform not configured on this server");
  const roster = await listAgents(config);
  if (roster === null) throw new ToolError("platform agents unavailable");
  return roster;
}

async function callTool(name: string, params: Record<string, unknown>, store: Store, config: ProxyConfig | null, origin: string): Promise<unknown> {
  switch (name) {
    case "get_referral_link": {
      const id = need(params, "client");
      const code = store.referralCode(id);
      if (code === null) throw new ToolError("only an active client has a referral link (list_clients shows each client's stage)");
      return { client: id, code, url: `${origin}/?ref=${code}#contact` };
    }
    case "list_referral_ready":
      return store.referralReady(new Date()).map((c) => ({
        id: c.id, name: c.name, contact: c.contact, referral_link: `${origin}/?ref=${store.referralCode(c.id)}#contact`,
      }));
    case "record_referral_ask": {
      const recorded = store.recordReferralAsk(need(params, "client"), new Date());
      if ("refused" in recorded) throw new ToolError(recorded.refused);
      return recorded.client;
    }
    case "list_clients":
      return store.read().clients;
    case "get_client": {
      const client = store.read().clients.find((c) => c.id === need(params, "id"));
      if (!client) throw new ToolError("no such client");
      return client;
    }
    case "create_lead": {
      const referredBy = text(params, "referred_by");
      const source = text(params, "source") || (referredBy ? "referral" : "outreach");
      if (!(AGENT_SOURCES as readonly string[]).includes(source)) throw new ToolError(`source must be one of ${AGENT_SOURCES.join(", ")}`);
      if (source === "referral" && !store.read().clients.some((c) => c.id === referredBy && c.stage !== "lead" && c.domain !== "")) {
        throw new ToolError("a referral needs referred_by: the id of the existing client (past the lead stage, not the agency itself) who introduced them (list_clients)");
      }
      if (referredBy && source !== "referral") throw new ToolError("referred_by is only for a referral");
      const name = need(params, "name");
      const filed = store.createLead({
        name, domain: text(params, "domain"),
        contact: { name: text(params, "contact_name"), email: text(params, "contact_email"), role: text(params, "contact_role") },
        note: typeof params.note === "string" ? params.note : undefined,
        source: source as LeadSource,
        ...(referredBy ? { referredBy } : {}),
      });
      // A name-only filing lands on the agency's own record whatever the name (store.ts). Say so when
      // the name differs, or a seat filing a client by name alone takes the agency's id for the client's.
      if (filed.domain === "" && filed.contact.email === "" && filed.name.trim().toLowerCase() !== name.trim().toLowerCase()) {
        return { ...filed, notice: `A name alone files the agency's own record, so this is ${filed.name} (${filed.id}), not a new "${name}". To file a client, call create_lead again with its domain or contact_email; never invent one.` };
      }
      return filed;
    }
    case "advance_pipeline": {
      const client = store.advanceClient(need(params, "id"));
      if (!client) throw new ToolError("no such client");
      return client;
    }
    case "add_client_note": {
      const client = store.addClientNote(need(params, "id"), need(params, "note"),
        typeof params.next_action === "string" && params.next_action !== "" ? params.next_action : undefined);
      if (!client) throw new ToolError("no such client");
      return client;
    }
    case "list_posts": {
      const client = need(params, "client");
      return store.read().posts.filter((p) => p.clientId === client && (params.state === undefined || p.status === params.state));
    }
    case "create_draft_post": {
      const channel = need(params, "channel");
      if (!(POST_CHANNELS as readonly string[]).includes(channel)) throw new ToolError(`channel must be one of ${POST_CHANNELS.join(", ")}`);
      const files = fileIds(params.files);
      const post = store.createDraftPost({
        clientId: need(params, "client"), title: need(params, "title"), summary: need(params, "summary"),
        body: typeof params.body === "string" && params.body !== "" ? params.body : undefined,
        kind: need(params, "kind") as DraftPostInput["kind"], channel: channel as PostChannel,
        // A studio deliverable is filed, never scheduled: its day is the day it was filed. A seat is
        // not told the date, and one guessed 2025-05-19 on a live run, so the server stamps it.
        scheduledFor: channel === "studio" ? new Date().toISOString().slice(0, 10) : need(params, "scheduled_for"), agent: "mcp",
        ...(files.length > 0 ? { files } : {}),
      });
      if (!post) throw new ToolError("no such client");
      return post;
    }
    case "approve_post": {
      const post = store.updatePost(need(params, "id"), { status: "approved" });
      if (!post) throw new ToolError("no such post");
      return post;
    }
    case "schedule_post": {
      const post = store.updatePost(need(params, "id"), { scheduledFor: need(params, "date") });
      if (!post) throw new ToolError("no such post");
      return post;
    }
    case "list_agents": {
      const agents = await platformAgents(config);
      const client = typeof params.client === "string"
        ? store.read().clients.find((c) => c.id === params.client) : undefined;
      return client === undefined ? agents : agents.filter((a) => a.name.endsWith(`--${client.slug}`));
    }
    case "start_agent_session": {
      const agents = await platformAgents(config);
      const agent = agents.find((a) => a.name === need(params, "agent"));
      if (!agent) throw new ToolError("no such agent");
      const created = await proxyFetch(config!, { method: "POST", path: "/v1/sessions" },
        JSON.stringify({ agent_id: agent.id, message: need(params, "prompt") }));
      if (!created.ok) throw new ToolError("session creation failed");
      return await created.json();
    }
    case "get_calendar": {
      const client = need(params, "client");
      const from = need(params, "from");
      const to = need(params, "to");
      return store.read().posts.filter((p) => p.clientId === client && p.scheduledFor >= from && p.scheduledFor <= to);
    }
    case "get_site":
      return store.site();
    case "update_site": {
      const patch = params.site;
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new ToolError("site is required");
      const updated = store.updateSite(patch as Record<string, unknown>);
      if (!updated) throw new ToolError(`site must name only ${SITE_SECTIONS.join(", ")}, each in the shape get_site returns`);
      return updated;
    }
    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}

const rpcResult = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/**
 * Handles one JSON-RPC message. Answers null for notifications (the caller
 * responds 202 with no body, per the streamable-HTTP transport).
 */
export async function handleMcp(raw: string, store: Store, config: ProxyConfig | null, origin = ""): Promise<object | null> {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (typeof msg.method !== "string") return rpcError(msg.id, -32600, "invalid request");
  if (msg.method.startsWith("notifications/")) return null;
  if (msg.method === "initialize") {
    return rpcResult(msg.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "agency", version: "0.0.0" },
    });
  }
  if (msg.method === "tools/list") return rpcResult(msg.id, { tools: TOOLS });
  if (msg.method === "tools/call") {
    const { name, arguments: args } = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    try {
      const result = await callTool(name ?? "", args ?? {}, store, config, origin);
      return rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (err) {
      if (err instanceof ToolError) {
        return rpcResult(msg.id, { content: [{ type: "text", text: err.message }], isError: true });
      }
      throw err;
    }
  }
  return rpcError(msg.id, -32601, "method not found");
}
