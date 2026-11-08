/**
 * Hybrid worker v1: build free preview receptionists for the researched leads, in bulk, with no LLM.
 *
 *   pnpm worker                       # dry run (the default): read-only calls, prints the plan
 *   pnpm worker --priority A          # only priority-A leads
 *   pnpm worker --limit 10            # at most 10 leads (default 43), priority A first
 *   pnpm worker --execute             # really call provision_demo
 *
 * Reads `leads/bay-area-auto.json` at the repo root (`--leads <path>` to override). Each lead carries
 * a ready `shop_input`. For each one it calls autoops-voice `provision_demo` (forces demo: true, never
 * attaches a phone number, spends nothing) with a deterministic shop_id, 4 at a time.
 *
 * Idempotent: it calls `list_shops` once, reads each existing shop's phone and address from
 * `get_receptionist` (list_shops returns neither), and skips a lead whose shop_id, phone, or
 * name plus city is already there. It never sets notify_phone, and never calls
 * provision_receptionist, update_receptionist, simulate_call or create_trial_checkout.
 *
 * Results land in `data/worker-results.json` (git-ignored), rewritten after every lead.
 *
 * Env: AUTOOPS_MCP_TOKEN or AUTOOPS_VOICE_TOKEN (bearer), AUTOOPS_MCP_URL (defaults to AUTOOPS.url).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AUTOOPS, PROTECTED_SHOPS } from "../templates/receptionist.ts";

export type Priority = "A" | "B" | "C";

export interface ShopInput {
  name: string;
  kind?: "repair" | "towing" | "service";
  sector?: string;
  demo?: boolean;
  phone?: string | null;
  address?: string | null;
  website?: string | null;
  hours?: Record<string, string>;
  services?: string[];
  policies?: string[];
  notify_phone?: string | null;
}

export interface Lead {
  name: string;
  domain?: string | null;
  note?: string | null;
  priority: Priority;
  shop_input: ShopInput;
}

/** What we know about a shop the voice server already has. */
export interface ExistingShop {
  shop_id: string;
  name: string;
  phone: string | null;
  city: string | null;
}

export type ResultStatus = "created" | "skipped" | "error";

export interface WorkerResult {
  shop_id: string;
  name: string;
  demo_url: string | null;
  portal_url: string | null;
  status: ResultStatus;
  error: string | null;
  at: string;
}

/** Last 10 digits of a phone number, or null when it has fewer. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** Second-level suffixes where the registrable domain takes three labels. */
const MULTI_PART_SUFFIXES = new Set(["co.uk", "org.uk", "com.au", "net.au", "co.nz", "com.mx", "co.jp", "com.br"]);

/** `http://www.Foo.com/bar?x` -> `foo.com`. Null for anything that is not a URL with a dotted host. */
export function registrableDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  return labels.length >= 3 && MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Registrable domains that more than one lead uses (a chain's location pages, a directory).
 * Computed over the whole leads file, not the selected subset, so shop ids do not depend on flags.
 */
export function sharedDomains(leads: Lead[]): Set<string> {
  const seen = new Map<string, number>();
  for (const lead of leads) {
    const domain = registrableDomain(lead.shop_input.website);
    if (domain) seen.set(domain, (seen.get(domain) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([domain]) => domain));
}

/**
 * Deterministic shop id: the slug of the registrable website domain (`jimdavisautomotive-com`),
 * or `p-<last10digits>` without one. A domain several leads share gets `-<last10digits>` appended.
 */
export function deriveShopId(shop: ShopInput, shared: Set<string> = new Set()): string {
  const domain = registrableDomain(shop.website);
  const phone = normalizePhone(shop.phone);
  if (domain) {
    const base = slugify(domain);
    if (!shared.has(domain)) return base;
    if (phone) return `${base}-${phone}`;
    return `${base}-${slugify(shop.name)}`;
  }
  if (phone) return `p-${phone}`;
  return `n-${slugify(shop.name)}`;
}

const CORPORATE_SUFFIX = /\s+(inc|incorporated|llc|ltd|co|corp|corporation|company)$/;

/** Lowercase, `&` as `and`, no punctuation, no tagline after ` - ` / ` | `, no trailing `Inc` / `LLC`. */
export function normalizeName(name: string): string {
  let n = name.toLowerCase().split(/\s+[-|:]\s+|\s+formerly\s+|\(/)[0] ?? "";
  n = n.replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  while (CORPORATE_SUFFIX.test(n)) n = n.replace(CORPORATE_SUFFIX, "").trim();
  return n;
}

/** Same name, or one is a whole-word prefix of the other and at least two words long. */
export function namesMatch(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.split(" ").length >= 2 && long.startsWith(`${short} `);
}

/** `1700 El Camino Real, San Carlos, CA 94070` -> `san carlos`. Null when it cannot tell. */
export function cityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const stateAt = parts.findIndex((p) => /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/i.test(p));
  const city = stateAt > 0 ? parts[stateAt - 1] : parts.length >= 3 ? parts[parts.length - 2] : undefined;
  return city ? city.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || null : null;
}

/**
 * Why a lead is already built, or null when it is new. Matches on shop id, then phone (last 10
 * digits), then name plus city. A name match where either side has no known city counts as a
 * duplicate: skipping a shop costs less than building it twice.
 */
export function findDuplicate(lead: Lead, shopId: string, existing: ExistingShop[]): { shop_id: string; reason: string } | null {
  const phone = normalizePhone(lead.shop_input.phone);
  const city = cityFromAddress(lead.shop_input.address);
  for (const shop of existing) if (shop.shop_id === shopId) return { shop_id: shop.shop_id, reason: "shop_id" };
  if (phone) for (const shop of existing) if (shop.phone && shop.phone === phone) return { shop_id: shop.shop_id, reason: "phone" };
  for (const shop of existing) {
    if (!namesMatch(lead.shop_input.name, shop.name)) continue;
    if (!city || !shop.city) return { shop_id: shop.shop_id, reason: "name (city unknown)" };
    if (city === shop.city) return { shop_id: shop.shop_id, reason: "name+city" };
  }
  return null;
}

/** Pull `- Phone:` and `- Address:` out of a receptionist's system prompt (get_receptionist has no fields for them). */
export function shopFactsFromPrompt(prompt: string | null | undefined): { phone: string | null; city: string | null } {
  const line = (label: string) => {
    const m = (prompt ?? "").match(new RegExp(`^- ${label}: (.*)$`, "m"));
    const v = m?.[1]?.trim();
    return v && v !== "not provided" ? v : null;
  };
  return { phone: normalizePhone(line("Phone")), city: cityFromAddress(line("Address")) };
}

/** Run at most `n` tasks at once. */
export function limiter(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= n) return;
    const start = queue.shift();
    if (start) {
      active++;
      start();
    }
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolvePromise, reject) => {
      queue.push(() => {
        task().then(resolvePromise, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
}

export class PermanentError extends Error {}

/** Retry `fn` up to `retries` more times, waiting `baseMs`, then 2x, 4x... A PermanentError is not retried. */
export async function withRetry<T>(fn: () => Promise<T>, retries = 2, baseMs = 1000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PermanentError || attempt >= retries) throw e;
      await sleep(baseMs * 2 ** attempt);
    }
  }
}

/** The `shop` argument for provision_demo: the lead's input, demo forced on, no notify_phone, no nulls. */
export function demoShop(input: ShopInput): ShopInput {
  const shop: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) if (value !== null && value !== undefined && key !== "notify_phone") shop[key] = value;
  if (shop.hours && typeof shop.hours === "object") {
    shop.hours = Object.fromEntries(Object.entries(shop.hours as Record<string, unknown>).filter(([, v]) => typeof v === "string"));
  }
  return { ...(shop as unknown as ShopInput), demo: true };
}

const PRIORITY_ORDER: Record<string, number> = { A: 0, B: 1, C: 2 };

export function selectLeads(leads: Lead[], opts: { limit: number; priority?: string }): Lead[] {
  return leads
    .map((lead, i) => ({ lead, i }))
    .filter(({ lead }) => !opts.priority || lead.priority === opts.priority)
    .sort((a, b) => (PRIORITY_ORDER[a.lead.priority] ?? 9) - (PRIORITY_ORDER[b.lead.priority] ?? 9) || a.i - b.i)
    .slice(0, opts.limit)
    .map(({ lead }) => lead);
}

export interface Options {
  execute: boolean;
  limit: number;
  priority?: string;
  leads?: string;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { execute: false, limit: 43 };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const take = () => inline ?? value(i++, flag);
    if (flag === "--execute") opts.execute = true;
    else if (flag === "--dry-run") opts.execute = false;
    else if (flag === "--limit") {
      const n = Number(take());
      if (!Number.isInteger(n) || n < 1) throw new Error("--limit takes a positive integer");
      opts.limit = n;
    } else if (flag === "--priority") opts.priority = take().toUpperCase();
    else if (flag === "--leads") opts.leads = take();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (argv.includes("--execute") && argv.includes("--dry-run")) throw new Error("pick one of --dry-run and --execute");
  return opts;
}

/** Minimal JSON-RPC MCP client for autoops-voice (stateless, POST only, JSON or SSE replies). */
export function voiceClient(url: string, token: string, timeoutMs = 60_000) {
  let id = 0;
  return async function call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    if (!res.ok) {
      const err = `${name}: HTTP ${res.status}`;
      throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new PermanentError(err) : new Error(err);
    }
    const msg = parseRpcBody(body) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
    if (msg.error) throw new Error(`${name}: ${msg.error.message ?? "JSON-RPC error"}`);
    const text = msg.result?.content?.[0]?.text ?? "null";
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (msg.result?.isError) throw new Error(`${name}: ${(data as { error?: string })?.error ?? text}`);
    return data as T;
  };
}

/** A JSON body, or the last `data:` event of an SSE body. */
export function parseRpcBody(body: string): unknown {
  const events = body.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  return JSON.parse(events.length ? (events[events.length - 1] ?? "") : body);
}

/** CRM filing (create_lead plus notes) is not wired yet: it needs dashboard access this worker does not have. */
export async function fileToCrm(result: WorkerResult): Promise<void> {
  console.log(`  crm: skipped for ${result.shop_id} (fileToCrm is a stub in v1)`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const leadsPath = opts.leads ? resolve(opts.leads) : resolve(here, "../../leads/bay-area-auto.json");
  const resultsPath = resolve(here, "../data/worker-results.json");
  const url = process.env["AUTOOPS_MCP_URL"] || AUTOOPS.url;
  const token = process.env["AUTOOPS_MCP_TOKEN"] || process.env["AUTOOPS_VOICE_TOKEN"];
  if (!token) {
    console.error("Set AUTOOPS_MCP_TOKEN or AUTOOPS_VOICE_TOKEN (and AUTOOPS_MCP_URL if the tunnel moved).");
    process.exit(1);
  }
  const call = voiceClient(url, token);
  const limit = limiter(4);

  const allLeads = JSON.parse(await readFile(leadsPath, "utf8")) as Lead[];
  const shared = sharedDomains(allLeads);
  const leads = selectLeads(allLeads, opts);
  const ids = new Map(leads.map((lead) => [lead, deriveShopId(lead.shop_input, shared)]));
  console.log(`${opts.execute ? "EXECUTE" : "DRY RUN"}: ${leads.length} lead(s) from ${leadsPath}${opts.priority ? `, priority ${opts.priority}` : ""}`);

  const { shops: listed } = await withRetry(() => call<{ shops: Array<{ shop_id: string; name: string; vapi_assistant_id?: string | null }> }>("list_shops", {}));
  const leadIds = new Set(ids.values());
  // A failed provision leaves a shop row with no assistant; re-provisioning the same shop_id updates that row.
  const shops = listed.filter((shop) => !(leadIds.has(shop.shop_id) && !shop.vapi_assistant_id));
  const existing: ExistingShop[] = await Promise.all(shops.map((shop) =>
    leadIds.has(shop.shop_id)
      ? Promise.resolve({ shop_id: shop.shop_id, name: shop.name, phone: null, city: null })
      : limit(() => withRetry(() => call<{ system_prompt?: string }>("get_receptionist", { shop_id: shop.shop_id })))
        .then((r) => ({ shop_id: shop.shop_id, name: shop.name, ...shopFactsFromPrompt(r.system_prompt) }))
        .catch(() => ({ shop_id: shop.shop_id, name: shop.name, phone: null, city: null }))));
  console.log(`voice server has ${existing.length} shop(s)`);

  const prior: Record<string, WorkerResult> = {};
  try {
    for (const r of JSON.parse(await readFile(resultsPath, "utf8")) as WorkerResult[]) prior[r.shop_id] = r;
  } catch {
    // no results yet
  }
  const results = { ...prior };
  let writing = Promise.resolve();
  const record = (r: WorkerResult) => {
    results[r.shop_id] = r;
    if (!opts.execute) return writing;
    writing = writing.then(async () => {
      await mkdir(dirname(resultsPath), { recursive: true });
      await writeFile(`${resultsPath}.tmp`, `${JSON.stringify(Object.values(results), null, 2)}\n`);
      await rename(`${resultsPath}.tmp`, resultsPath);
    });
    return writing;
  };

  const counts = { created: 0, skipped: 0, error: 0, would_create: 0 };
  const claimed: ExistingShop[] = [];
  const plan: Array<{ lead: Lead; shopId: string }> = [];
  for (const lead of leads) {
    const shopId = ids.get(lead) ?? deriveShopId(lead.shop_input, shared);
    const dup = findDuplicate(lead, shopId, existing) ?? findDuplicate(lead, shopId, claimed);
    const protectedShop = (PROTECTED_SHOPS as readonly string[]).includes(shopId);
    if (dup || protectedShop) {
      counts.skipped++;
      const why = dup ? `matches ${dup.shop_id} by ${dup.reason}` : "protected stage demo";
      console.log(`skip    ${lead.priority} ${shopId}  ${lead.shop_input.name}  (${why})`);
      if (prior[shopId]?.status !== "created") await record({ shop_id: shopId, name: lead.shop_input.name, demo_url: prior[shopId]?.demo_url ?? null, portal_url: prior[shopId]?.portal_url ?? null, status: "skipped", error: null, at: new Date().toISOString() });
      continue;
    }
    claimed.push({ shop_id: shopId, name: lead.shop_input.name, phone: normalizePhone(lead.shop_input.phone), city: cityFromAddress(lead.shop_input.address) });
    plan.push({ lead, shopId });
  }

  if (!opts.execute) {
    for (const { lead, shopId } of plan) console.log(`create  ${lead.priority} ${shopId}  ${lead.shop_input.name}  (would call provision_demo)`);
    counts.would_create = plan.length;
    console.log(`dry run: would create ${counts.would_create}, skip ${counts.skipped} of ${leads.length}. Re-run with --execute to provision.`);
    return;
  }

  await Promise.all(plan.map(({ lead, shopId }) => limit(async () => {
    const name = lead.shop_input.name;
    try {
      const r = await withRetry(() => call<{ shop_id: string; demo_url?: string; portal_url?: string }>("provision_demo", { shop: demoShop(lead.shop_input), shop_id: shopId }));
      counts.created++;
      const result: WorkerResult = { shop_id: r.shop_id ?? shopId, name, demo_url: r.demo_url ?? null, portal_url: r.portal_url ?? null, status: "created", error: null, at: new Date().toISOString() };
      console.log(`created ${lead.priority} ${result.shop_id}  ${name}  ${result.demo_url ?? ""}`);
      await record(result);
      await fileToCrm(result);
    } catch (e) {
      counts.error++;
      const error = (e as Error).message ?? String(e);
      console.log(`error   ${lead.priority} ${shopId}  ${name}  ${error}`);
      await record({ shop_id: shopId, name, demo_url: null, portal_url: null, status: "error", error, at: new Date().toISOString() });
    }
  })));
  await writing;
  console.log(`done: created ${counts.created}, skipped ${counts.skipped}, errors ${counts.error} of ${leads.length}. Results in ${resultsPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error((e as Error).message ?? e);
    process.exit(1);
  });
}
