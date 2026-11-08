/**
 * The outbound engine: one long-running loop with three jobs, no LLM.
 *
 *   pnpm engine                     # dry run (the default): reads everything, prints what it would do, sends nothing
 *   pnpm engine --once              # one tick of each job, then exit (dry run unless --execute)
 *   pnpm engine --execute           # really send, file notes, wake client-manager, sweep approvals
 *
 * 1. Outbound sender, every 30 min. Leads in the CRM at stage `lead` with a contact email, a
 *    `RESEARCH:` note with a usable opener detail, and no `OUTREACH SENT` / `OUTREACH DRAFTED` /
 *    `REPLY RECEIVED` / `BOUNCED` note get Aarav's cold email (`templates/outreach-template.ts`)
 *    from the AgentMail inbox "Aarav from SAV". Volume ramps by wall clock (America/Los_Angeles):
 *    25 a tick for the first 2 h after the engine first started, 50 until the next 04:00 PT, then
 *    100; one level lower when bounces plus failed sends in the last tick exceed 10%. At most
 *    2,500 a Pacific day. Never the same address twice: a local ledger (`data/engine-sent.jsonl`),
 *    the inbox's own sent mail, and the CRM note all count, and each send carries an idempotency key.
 *    After each send: note `OUTREACH SENT: <message id> to <email>` plus the full email.
 * 2. Inbox watcher, every 2 min. New inbound mail is matched to the CRM by sender email, then
 *    domain, filed verbatim (`REPLY RECEIVED: <thread id>`), and wakes `client-manager` once per
 *    message (`SHOP REPLIED: …`). Bounces (`BOUNCED:`) and auto-replies (`AUTO-REPLY:`) are noted
 *    and wake nobody; bounces feed the ramp.
 * 3. Approval sweep, every 15 s: `POST /api/approvals/auto` on the dashboard, only when the
 *    dashboard says it enforces hard limits (`GET` answers `hard_limits`), so an older deploy
 *    that approves everything is never swept from here.
 *
 * State: `data/engine-state.json` (start time, message ids handled, last tick) and the ledger, both
 * git-ignored. A dry run writes neither. One line per action to stdout and `data/engine.log`.
 *
 * Env: AGENTMAIL_API_KEY, NAIVE_API_KEY (waking client-manager), DASHBOARD_URL, DASHBOARD_TOKEN
 * (operator bearer; also used for `/mcp` unless DASHBOARD_MCP_TOKEN is set), optional
 * DASHBOARD_MCP_URL (default `$DASHBOARD_URL/mcp`), NAIVE_API_URL (default https://api.vetta.sh).
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { INBOX_NAME } from "../templates/receptionist.ts";
import { personalizedDetail, renderColdEmail } from "../templates/outreach-template.ts";
import { parseRpcBody, registrableDomain } from "./worker.ts";

// ---------------------------------------------------------------------------------------------
// Pure parts (tested in engine.test.ts)

export const CLIENT_MANAGER_AGENT = "agt_wnnf7kyvhcj6v9nbsbnw9pt4dp";
export const DAILY_SEND_CAP = 2500;
export const RAMP = [25, 50, 100] as const;
export const SEND_EVERY_MS = 30 * 60_000;
export const INBOX_EVERY_MS = 2 * 60_000;
export const APPROVE_EVERY_MS = 15_000;
const TZ = "America/Los_Angeles";

export interface CrmClient {
  id: string;
  name: string;
  domain: string;
  stage: string;
  contact: { name: string; email: string; role: string };
  notes: string[];
}

export interface LastTick {
  at: string;
  sent: number;
  failed: number;
  /** Bounces the inbox watcher found since this tick. */
  bounced: number;
}

export interface EngineState {
  started_at: string;
  /** Inbound (and bounced) message ids already handled. */
  seen: string[];
  last_tick: LastTick | null;
  last_inbox_check: string | null;
}

export interface LedgerRow {
  email: string;
  client_id: string;
  message_id: string;
  thread_id: string | null;
  at: string;
  /** False until the CRM note is filed; the next tick retries it. */
  noted: boolean;
}

/** The hour and the calendar day of `now` in Pacific time. */
export function pacific(now: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** The first 04:00 Pacific strictly after `start`. */
export function next4amPacific(start: Date): Date {
  // Walk forward hour by hour (at most 25 steps): DST-proof without a date library.
  const t = new Date(Math.floor(start.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  for (let i = 0; i < 26; i++) {
    const at = new Date(t.getTime() + i * 3_600_000);
    if (pacific(at).hour === 4) return at;
  }
  return new Date(start.getTime() + 86_400_000);
}

/** The wall-clock ramp level: 0 (25) for 2 h after the first start, 1 (50) until the next 04:00 PT, then 2 (100). */
export function baseLevel(startedAt: Date, now: Date): number {
  if (now.getTime() - startedAt.getTime() < 2 * 3_600_000) return 0;
  return now.getTime() < next4amPacific(startedAt).getTime() ? 1 : 2;
}

/** Bounces plus failed sends over attempts in the last tick. */
export function badRate(tick: LastTick | null): number {
  if (!tick) return 0;
  const attempts = tick.sent + tick.failed;
  return attempts === 0 ? 0 : (tick.failed + tick.bounced) / attempts;
}

/** How many to send this tick: the ramp, a level lower after a bad tick, never past the day's cap. */
export function batchSize(startedAt: Date, now: Date, lastTick: LastTick | null, sentToday: number): { size: number; level: number; stepped_down: boolean } {
  const base = baseLevel(startedAt, now);
  const stepped = badRate(lastTick) > 0.1;
  const level = Math.max(0, base - (stepped ? 1 : 0));
  return { size: Math.max(0, Math.min(RAMP[level]!, DAILY_SEND_CAP - sentToday)), level, stepped_down: stepped && base > 0 };
}

export const normEmail = (email: string | null | undefined): string => (email ?? "").trim().toLowerCase();
const EMAIL = /^[^\s@<>(),;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
export const isEmail = (email: string): boolean => EMAIL.test(email);

/** `"Pat <pat@shop.com>"` or `pat@shop.com` -> `pat@shop.com`. */
export function parseAddress(from: string | null | undefined): string {
  const raw = from ?? "";
  const m = /<([^>]+)>/.exec(raw);
  return normEmail(m ? m[1] : raw);
}

const noteStarts = (client: CrmClient, ...prefixes: string[]) =>
  client.notes.some((n) => prefixes.some((p) => n.trimStart().startsWith(p)));

/** Prefixes that mean a shop is already in conversation, or must not be mailed cold. */
export const DONE_PREFIXES = ["OUTREACH SENT", "OUTREACH DRAFTED", "REPLY RECEIVED", "REPLY SENT", "BOUNCED:", "AUTO-REPLY:"];

export interface Candidate {
  client: CrmClient;
  email: string;
  subject: string;
  text: string;
}

export interface Skip {
  client: CrmClient;
  reason: string;
}

/** Who gets the cold email, in CRM order, and why everyone else does not. */
export function selectCandidates(clients: readonly CrmClient[], alreadyMailed: ReadonlySet<string>): { candidates: Candidate[]; skipped: Skip[] } {
  const candidates: Candidate[] = [];
  const skipped: Skip[] = [];
  const taken = new Set(alreadyMailed);
  for (const client of clients) {
    const email = normEmail(client.contact?.email);
    const research = client.notes.find((n) => n.trimStart().startsWith("RESEARCH:"));
    if (email === "") { skipped.push({ client, reason: "no contact email" }); continue; }
    if (!isEmail(email)) { skipped.push({ client, reason: "contact email is not an address" }); continue; }
    if (client.stage !== "lead") { skipped.push({ client, reason: `stage is ${client.stage}, not lead` }); continue; }
    if (!research) { skipped.push({ client, reason: "no RESEARCH note" }); continue; }
    if (noteStarts(client, ...DONE_PREFIXES)) { skipped.push({ client, reason: "already contacted (CRM note)" }); continue; }
    if (taken.has(email)) { skipped.push({ client, reason: "address already emailed" }); continue; }
    const detail = personalizedDetail(research);
    if (detail === null) { skipped.push({ client, reason: "no usable detail in RESEARCH note" }); continue; }
    const email_ = renderColdEmail({ shop_name: client.name, contact_name: client.contact.name, personalized_detail: detail });
    if (email_ === null) { skipped.push({ client, reason: "could not render" }); continue; }
    taken.add(email);
    candidates.push({ client, email, ...email_ });
  }
  return { candidates, skipped };
}

/** The CRM note filed after a send: the header line, then the full email. */
export function sentNote(messageId: string, email: string, subject: string, text: string): string {
  return `OUTREACH SENT: ${messageId} to ${email}\n\nSubject: ${subject}\n\n${text}`;
}

export interface InboundMessage {
  message_id: string;
  thread_id: string;
  from: string;
  subject: string;
  text: string;
  labels: string[];
}

export type InboundKind = "bounce" | "auto-reply" | "reply" | "own";

const BOUNCE_FROM = /mailer-daemon|postmaster@|mail delivery (subsystem|system)|^bounces?[@+]/i;
const BOUNCE_SUBJECT = /undeliver|delivery status notification|failure notice|returned mail|delivery (has )?failed|mail delivery failed|could not be delivered|address not found|message not delivered|delivery failure/i;
const AUTO_SUBJECT = /^(auto(matic)?[\s-]?(reply|response)|autoreply|out of (the )?office|ooo\b|away from|on vacation|i am (currently )?out|thank you for (your )?(email|message|contacting))/i;
const AUTO_BODY = /\b(out of (the )?office|automatic reply|auto-?reply|i am (currently )?(out|away)|i'm (currently )?(out|away) (of|from|until)|on vacation until|limited access to (my )?email)\b/i;

/** What an inbound message is: a bounce, an auto-reply, a real reply, or our own mail. */
export function classifyInbound(msg: InboundMessage, ownAddress: string): InboundKind {
  const from = parseAddress(msg.from);
  if (from === normEmail(ownAddress)) return "own";
  if (msg.labels.includes("bounced") || BOUNCE_FROM.test(msg.from) || BOUNCE_SUBJECT.test(msg.subject)) return "bounce";
  if (AUTO_SUBJECT.test(msg.subject.trim()) || AUTO_BODY.test(msg.text.slice(0, 400))) return "auto-reply";
  return "reply";
}

/** Free mail domains never identify a shop. */
const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "live.com", "msn.com", "comcast.net", "sbcglobal.net", "att.net", "verizon.net", "protonmail.com", "proton.me", "ymail.com", "mail.com", "gmx.com"]);

/** The CRM shop a sender belongs to: by contact email, then by domain (never a free-mail domain). */
export function matchClient(sender: string, clients: readonly CrmClient[]): CrmClient | null {
  const email = normEmail(sender);
  const byEmail = clients.find((c) => normEmail(c.contact?.email) === email);
  if (byEmail) return byEmail;
  const domain = registrableDomain(email.split("@")[1] ?? "");
  if (!domain || FREE_MAIL.has(domain)) return null;
  return clients.find((c) => registrableDomain(c.domain) === domain || registrableDomain(normEmail(c.contact?.email).split("@")[1] ?? "") === domain) ?? null;
}

/** For a bounce: which address we sent to bounced, read from its text. */
export function bouncedAddress(msg: InboundMessage, mailed: readonly string[]): string | null {
  const hay = `${msg.subject}\n${msg.text}`.toLowerCase();
  return mailed.find((e) => hay.includes(e)) ?? null;
}

export function replyNote(msg: InboundMessage): string {
  return `REPLY RECEIVED: ${msg.thread_id}\nFrom: ${msg.from}\nSubject: ${msg.subject}\nMessage: ${msg.message_id}\n\n${msg.text}`;
}

/** The message that wakes client-manager: first line `SHOP REPLIED: <shop>`, then one field per line. */
export function wakeMessage(client: CrmClient, msg: InboundMessage): string {
  return [
    `SHOP REPLIED: ${client.name}`,
    `client_id: ${client.id}`,
    `thread_id: ${msg.thread_id}`,
    `shop email: ${parseAddress(msg.from)}`,
    `reply: ${msg.text}`,
  ].join("\n");
}

export interface Options {
  execute: boolean;
  once: boolean;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { execute: false, once: false };
  for (const arg of argv) {
    if (arg === "--execute") opts.execute = true;
    else if (arg === "--dry-run") opts.execute = false;
    else if (arg === "--once") opts.once = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (argv.includes("--execute") && argv.includes("--dry-run")) throw new Error("pick one of --dry-run and --execute");
  return opts;
}

// ---------------------------------------------------------------------------------------------
// The outside world

export interface Env {
  agentmailKey: string;
  naiveKey: string | null;
  naiveUrl: string;
  dashboardUrl: string;
  dashboardToken: string;
  mcpUrl: string;
  mcpToken: string;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Set ${k} in .env`);
    return v;
  };
  const dashboardUrl = need("DASHBOARD_URL").replace(/\/+$/, "");
  const dashboardToken = need("DASHBOARD_TOKEN");
  return {
    agentmailKey: need("AGENTMAIL_API_KEY"),
    naiveKey: env["NAIVE_API_KEY"] || null,
    naiveUrl: (env["NAIVE_API_URL"] || "https://api.vetta.sh").replace(/\/+$/, ""),
    dashboardUrl,
    dashboardToken,
    mcpUrl: env["DASHBOARD_MCP_URL"] || `${dashboardUrl}/mcp`,
    mcpToken: env["DASHBOARD_MCP_TOKEN"] || dashboardToken,
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function http<T>(url: string, init: RequestInit & { token: string }, fetchImpl: typeof fetch = fetch): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetchImpl(url, {
    ...rest,
    headers: { Authorization: `Bearer ${token}`, ...(rest.body ? { "Content-Type": "application/json" } : {}), ...(rest.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${init.method ?? "GET"} ${new URL(url).pathname}: HTTP ${res.status} ${body.slice(0, 200)}`);
  return (body ? JSON.parse(body) : null) as T;
}

const AM = "https://api.agentmail.to/v0";

export function agentmail(key: string, fetchImpl: typeof fetch = fetch) {
  const get = <T>(path: string) => http<T>(`${AM}${path}`, { token: key }, fetchImpl);
  return {
    async inboxes() {
      const r = await get<{ inboxes: Array<{ inbox_id: string; email: string; display_name?: string | null; signature?: unknown }> }>("/inboxes?limit=100");
      return r.inboxes;
    },
    createInbox: (username: string, display_name: string) =>
      http<{ inbox_id: string; email: string }>(`${AM}/inboxes`, { method: "POST", token: key, body: JSON.stringify({ username, display_name }) }, fetchImpl),
    /** Every message carrying `label`, newest first, following page tokens (bounded). */
    async messages(inboxId: string, label: string, after?: string | null) {
      const all: Array<{ message_id: string; thread_id: string; from: string; to: string[] | string; subject?: string; labels: string[]; timestamp: string; preview?: string }> = [];
      let token: string | undefined;
      for (let page = 0; page < 100; page++) {
        const q = new URLSearchParams({ limit: "100", labels: label });
        if (after) q.set("after", after);
        if (token) q.set("page_token", token);
        const r = await get<{ messages: typeof all; next_page_token?: string | null }>(`/inboxes/${encodeURIComponent(inboxId)}/messages?${q}`);
        all.push(...r.messages);
        if (!r.next_page_token) break;
        token = r.next_page_token;
      }
      return all;
    },
    message: (inboxId: string, messageId: string) =>
      get<{ message_id: string; thread_id: string; from: string; subject?: string; text?: string; extracted_text?: string; labels: string[] }>(`/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`),
    send: (inboxId: string, to: string, subject: string, text: string, idempotencyKey: string) =>
      http<{ message_id: string; thread_id?: string }>(`${AM}/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
        method: "POST", token: key, body: JSON.stringify({ to, subject, text, labels: ["outreach", "cold-1"] }), headers: { "Idempotency-Key": idempotencyKey },
      }, fetchImpl),
  };
}

/** The dashboard: reads over `/api/clients` (operator bearer), writes over `/mcp` (create_lead, add_client_note). */
export function dashboard(env: Env, fetchImpl: typeof fetch = fetch) {
  let rpcId = 0;
  const mcp = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const res = await fetchImpl(env.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${env.mcpToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.text();
    if (!res.ok) throw new HttpError(res.status, `/mcp ${name}: HTTP ${res.status}`);
    const msg = parseRpcBody(body) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
    const text = msg.result?.content?.[0]?.text ?? "null";
    if (msg.error || msg.result?.isError) throw new Error(`/mcp ${name}: ${msg.error?.message ?? text}`);
    return JSON.parse(text) as T;
  };
  return {
    clients: () => http<CrmClient[]>(`${env.dashboardUrl}/api/clients`, { token: env.dashboardToken }, fetchImpl),
    addNote: (id: string, note: string, next_action?: string) => mcp("add_client_note", { id, note, ...(next_action ? { next_action } : {}) }),
    /** Whether `/mcp` takes our bearer (the deployed dashboard needs the DASHBOARD_TOKEN change). */
    async mcpReachable(): Promise<boolean> {
      const res = await fetchImpl(env.mcpUrl, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${env.mcpToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }), signal: AbortSignal.timeout(30_000),
      });
      return res.ok;
    },
    approvalsInfo: () => http<{ log: unknown[]; hard_limits?: string[] }>(`${env.dashboardUrl}/api/approvals/auto`, { token: env.dashboardToken }, fetchImpl),
    sweep: () => http<{ approved: Array<{ tool: string; rule: string; agent_id: string }>; denied?: Array<{ tool: string; rule: string; agent_id: string }>; left: number; ignored?: number; rate_limited?: boolean }>(
      `${env.dashboardUrl}/api/approvals/auto`, { method: "POST", token: env.dashboardToken }, fetchImpl),
  };
}

// ---------------------------------------------------------------------------------------------
// The engine

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, "../data");
const STATE = resolve(DATA, "engine-state.json");
const LEDGER = resolve(DATA, "engine-sent.jsonl");
const LOG = resolve(DATA, "engine.log");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function log(line: string) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try {
    await mkdir(DATA, { recursive: true });
    await appendFile(LOG, `${stamped}\n`);
  } catch {
    // stdout still has it
  }
}

async function loadState(now: Date): Promise<EngineState> {
  try {
    return JSON.parse(await readFile(STATE, "utf8")) as EngineState;
  } catch {
    return { started_at: now.toISOString(), seen: [], last_tick: null, last_inbox_check: null };
  }
}

async function saveState(state: EngineState) {
  await mkdir(DATA, { recursive: true });
  await writeFile(`${STATE}.tmp`, `${JSON.stringify({ ...state, seen: state.seen.slice(-20_000) }, null, 2)}\n`);
  await rename(`${STATE}.tmp`, STATE);
}

async function loadLedger(): Promise<LedgerRow[]> {
  try {
    return (await readFile(LEDGER, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerRow);
  } catch {
    return [];
  }
}

/** The ledger with later rows for an address replacing earlier ones (a `noted: true` row follows a `noted: false` one). */
export function latestByEmail(rows: readonly LedgerRow[]): Map<string, LedgerRow> {
  const map = new Map<string, LedgerRow>();
  for (const row of rows) map.set(row.email, row);
  return map;
}

class Engine {
  readonly opts: Options;
  readonly env: Env;
  readonly mail: ReturnType<typeof agentmail>;
  readonly crm: ReturnType<typeof dashboard>;
  state!: EngineState;
  inbox: { inbox_id: string; email: string } | null = null;
  busy = { send: false, inbox: false, approve: false };
  sweepAllowed: boolean | null = null;

  constructor(opts: Options, env: Env) {
    this.opts = opts;
    this.env = env;
    this.mail = agentmail(env.agentmailKey);
    this.crm = dashboard(env);
  }

  get dry() {
    return !this.opts.execute;
  }

  async init() {
    this.state = await loadState(new Date());
    if (!this.dry) await saveState(this.state); // the first start is persisted, so the ramp counts from it
    const inboxes = await this.mail.inboxes();
    const found = inboxes.find((i) => i.display_name === INBOX_NAME);
    if (found) {
      this.inbox = found;
      if (found.signature) await log(`warn    inbox ${found.email} has a signature set; AgentMail appends it after "Aarav". Remove it.`);
      await log(`inbox   ${found.email} ("${INBOX_NAME}")`);
    } else if (this.dry) {
      await log(`inbox   none named "${INBOX_NAME}"; would create aarav.sav`);
    } else {
      this.inbox = await this.mail.createInbox("aarav.sav", INBOX_NAME);
      await log(`inbox   created ${this.inbox.email}`);
    }
    await log(`${this.dry ? "DRY RUN" : "EXECUTE"}: engine started (first start ${this.state.started_at})`);
  }

  async save() {
    if (!this.dry) await saveState(this.state);
  }

  /** Job 1: the outbound sender. */
  async sendTick() {
    if (this.busy.send) return;
    this.busy.send = true;
    try {
      const now = new Date();
      const ledger = await loadLedger();
      const latest = latestByEmail(ledger);
      const clients = await this.crm.clients();

      // Retry any note a crash or an outage left unfiled.
      for (const row of latest.values()) {
        if (row.noted || this.dry) continue;
        const client = clients.find((c) => c.id === row.client_id);
        if (!client || noteStarts(client, `OUTREACH SENT: ${row.message_id}`)) {
          await appendFile(LEDGER, `${JSON.stringify({ ...row, noted: true })}\n`);
          continue;
        }
        await this.fileSentNote(row, client, "(email body: see the AgentMail inbox)", "");
      }

      // Every address this inbox ever mailed counts as mailed, ledger or not.
      const mailed = new Set(latest.keys());
      if (this.inbox) {
        for (const m of await this.mail.messages(this.inbox.inbox_id, "sent")) {
          for (const to of Array.isArray(m.to) ? m.to : [m.to]) mailed.add(parseAddress(to));
        }
      }
      const today = pacific(now).day;
      const sentToday = ledger.filter((r) => pacific(new Date(r.at)).day === today && latest.get(r.email) === r).length;
      const { size, level, stepped_down } = batchSize(new Date(this.state.started_at), now, this.state.last_tick, sentToday);
      const { candidates, skipped } = selectCandidates(clients, mailed);
      const reasons = new Map<string, number>();
      for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
      await log(`send    tick: ${clients.length} in CRM, ${candidates.length} eligible, batch ${size} (level ${level}${stepped_down ? ", stepped down after a bad tick" : ""}, ${sentToday}/${DAILY_SEND_CAP} today); skipped: ${[...reasons].map(([r, n]) => `${n} ${r}`).join(", ") || "none"}`);

      const batch = candidates.slice(0, size);
      let sent = 0;
      let failed = 0;
      for (const [i, c] of batch.entries()) {
        if (this.dry) {
          await log(`would send ${c.client.id} "${c.client.name}" to ${c.email}: "${c.subject}"`);
          console.log(`---- email ${i + 1}/${batch.length} ----\nTo: ${c.email}\nSubject: ${c.subject}\n\n${c.text}\n---- end ----`);
          continue;
        }
        if (!this.inbox) break;
        try {
          const r = await this.mail.send(this.inbox.inbox_id, c.email, c.subject, c.text, `sav-cold-1-${c.email}`);
          const row: LedgerRow = { email: c.email, client_id: c.client.id, message_id: r.message_id, thread_id: r.thread_id ?? null, at: new Date().toISOString(), noted: false };
          await mkdir(DATA, { recursive: true });
          await appendFile(LEDGER, `${JSON.stringify(row)}\n`);
          sent++;
          await log(`sent    ${c.client.id} "${c.client.name}" to ${c.email} (${r.message_id})`);
          await this.fileSentNote(row, c.client, c.subject, c.text);
        } catch (e) {
          failed++;
          await log(`fail    ${c.client.id} "${c.client.name}" to ${c.email}: ${(e as Error).message}`);
        }
        if (i < batch.length - 1) await sleep(3000 + Math.floor(Math.random() * 3000));
      }
      if (!this.dry) {
        this.state.last_tick = { at: now.toISOString(), sent, failed, bounced: 0 };
        await this.save();
      }
      if (!this.dry && batch.length > 0) await log(`send    done: sent ${sent}, failed ${failed}`);
    } catch (e) {
      await log(`error   send tick: ${(e as Error).message}`);
    } finally {
      this.busy.send = false;
    }
  }

  async fileSentNote(row: LedgerRow, client: CrmClient, subject: string, text: string) {
    try {
      await this.crm.addNote(client.id, sentNote(row.message_id, row.email, subject, text), "Wait for a reply");
      await appendFile(LEDGER, `${JSON.stringify({ ...row, noted: true })}\n`);
      await log(`noted   ${client.id} OUTREACH SENT ${row.message_id}`);
    } catch (e) {
      await log(`error   note for ${client.id} (${row.message_id}), will retry next tick: ${(e as Error).message}`);
    }
  }

  /** Job 2: the inbox watcher. */
  async inboxTick() {
    if (this.busy.inbox || !this.inbox) return;
    this.busy.inbox = true;
    try {
      const checkedAt = new Date();
      const seen = new Set(this.state.seen);
      // An hour of overlap: a message that landed while the last check ran is not missed; `seen` dedupes.
      const after = this.state.last_inbox_check ? new Date(new Date(this.state.last_inbox_check).getTime() - 3_600_000).toISOString() : null;
      const received = await this.mail.messages(this.inbox.inbox_id, "received", after);
      const bouncedSent = await this.mail.messages(this.inbox.inbox_id, "bounced", after);
      const fresh = [...received, ...bouncedSent.filter((m) => !received.some((r) => r.message_id === m.message_id))].filter((m) => !seen.has(m.message_id));
      if (fresh.length === 0) {
        if (this.opts.once) await log("inbox   no new messages");
      } else {
        const clients = await this.crm.clients();
        const mailed = [...latestByEmail(await loadLedger()).keys()];
        for (const item of fresh.reverse()) {
          await this.handleInbound(item, clients, mailed);
          this.state.seen.push(item.message_id);
        }
      }
      if (!this.dry) {
        this.state.last_inbox_check = checkedAt.toISOString();
        await this.save();
      }
    } catch (e) {
      await log(`error   inbox tick: ${(e as Error).message}`);
    } finally {
      this.busy.inbox = false;
    }
  }

  async handleInbound(item: { message_id: string; thread_id: string; labels: string[]; from: string; to: string[] | string }, clients: CrmClient[], mailed: string[]) {
    const inbox = this.inbox!;
    const full = await this.mail.message(inbox.inbox_id, item.message_id);
    const msg: InboundMessage = {
      message_id: full.message_id, thread_id: full.thread_id, from: full.from ?? item.from, subject: full.subject ?? "",
      text: (full.extracted_text ?? full.text ?? "").trim(), labels: full.labels ?? item.labels,
    };
    // Our own sent message carrying the `bounced` label: the recipient is in `to`.
    const ownBounce = parseAddress(msg.from) === normEmail(inbox.email) && msg.labels.includes("bounced");
    const kind = ownBounce ? "bounce" : classifyInbound(msg, inbox.email);
    if (kind === "own") return;
    const act = async (what: string, fn: () => Promise<unknown>) => {
      if (this.dry) return log(`would ${what}`);
      await fn();
      return log(what);
    };
    if (kind === "bounce") {
      const to = ownBounce ? parseAddress((Array.isArray(item.to) ? item.to : [item.to])[0]) : bouncedAddress(msg, mailed);
      const client = to ? clients.find((c) => normEmail(c.contact?.email) === to) : null;
      if (this.state.last_tick && !this.dry) this.state.last_tick.bounced += 1;
      if (!client) return log(`bounce  ${msg.message_id} (${to ?? "address unknown"}): no CRM shop to note it on`);
      return act(`note    ${client.id} BOUNCED ${to}`, () => this.crm.addNote(client.id, `BOUNCED: ${msg.message_id} to ${to}\nSubject: ${msg.subject}\n\n${msg.text.slice(0, 2000)}`, "Find another contact email; this one bounced"));
    }
    const client = matchClient(parseAddress(msg.from), clients);
    if (!client) return log(`inbox   ${kind} from ${parseAddress(msg.from)} (${msg.thread_id}) matches no CRM shop; left in the inbox`);
    if (kind === "auto-reply") {
      return act(`note    ${client.id} AUTO-REPLY ${msg.thread_id}`, () => this.crm.addNote(client.id, `AUTO-REPLY: ${msg.thread_id}\nFrom: ${msg.from}\nSubject: ${msg.subject}\n\n${msg.text}`));
    }
    await act(`note    ${client.id} REPLY RECEIVED ${msg.thread_id} from ${parseAddress(msg.from)}`, () => this.crm.addNote(client.id, replyNote(msg), "Shop replied: client-manager is answering"));
    await act(`wake    client-manager for ${client.id} "${client.name}" (${msg.message_id})`, () => this.wake(wakeMessage(client, msg)));
  }

  async wake(message: string) {
    if (!this.env.naiveKey) throw new Error("NAIVE_API_KEY is not set; cannot wake client-manager");
    await http(`${this.env.naiveUrl}/v1/sessions`, { method: "POST", token: this.env.naiveKey, body: JSON.stringify({ agent_id: CLIENT_MANAGER_AGENT, message }) });
  }

  /** Job 3: the approval sweep. */
  async approveTick() {
    if (this.busy.approve) return;
    this.busy.approve = true;
    try {
      if (this.sweepAllowed !== true) {
        const info = await this.crm.approvalsInfo();
        const allowed = Array.isArray(info.hard_limits) && info.hard_limits.length > 0;
        if (allowed !== this.sweepAllowed) {
          await log(allowed ? `approve dashboard enforces hard limits: ${info.hard_limits!.join("; ")}` : "approve dashboard does not report hard limits (older deploy?); not sweeping until it does");
        }
        this.sweepAllowed = allowed;
        if (!allowed) return;
      }
      if (this.dry) {
        if (this.opts.once) await log("approve would POST /api/approvals/auto (dry run: not swept)");
        return;
      }
      const r = await this.crm.sweep();
      for (const a of r.approved) await log(`approve ${a.agent_id} ${a.tool} (${a.rule})`);
      for (const d of r.denied ?? []) await log(`deny    ${d.agent_id} ${d.tool} (${d.rule})`);
      if (r.rate_limited) await log("approve platform rate-limited the sweep");
    } catch (e) {
      await log(`error   approval sweep: ${(e as Error).message}`);
    } finally {
      this.busy.approve = false;
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const engine = new Engine(opts, readEnv());
  await engine.init();
  if (!(await engine.crm.mcpReachable().catch(() => false))) {
    await log(`warn    ${engine.env.mcpUrl} refuses our bearer: notes cannot be filed until the dashboard accepts DASHBOARD_TOKEN on /mcp`);
    if (opts.execute) throw new Error("refusing to send: a send whose CRM note cannot be filed would be invisible to the crew");
  }
  if (opts.once) {
    await engine.approveTick();
    await engine.inboxTick();
    await engine.sendTick();
    return;
  }
  await engine.approveTick();
  await engine.inboxTick();
  await engine.sendTick();
  setInterval(() => void engine.approveTick(), APPROVE_EVERY_MS);
  setInterval(() => void engine.inboxTick(), INBOX_EVERY_MS);
  setInterval(() => void engine.sendTick(), SEND_EVERY_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error((e as Error).message ?? e);
    process.exit(1);
  });
}
