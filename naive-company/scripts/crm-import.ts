/**
 * File the worker's demo receptionists into the dashboard CRM, so the crew can see them.
 *
 *   pnpm crm-import             # dry run (the default): prints what it would file
 *   pnpm crm-import --execute   # really call create_lead and add_client_note
 *
 * Reads `data/worker-results.json` (from `pnpm worker`) and `leads/bay-area-auto.json`. For each
 * created demo it calls the dashboard's `create_lead` with the shop's domain (source: outreach),
 * then `add_client_note` with the voice shop_id, the demo link and the shop's public phone. The
 * portal link is never filed: it carries the owner's token.
 *
 * Idempotent: `create_lead` answers `already_filed` for a domain already in the CRM, and that shop
 * gets no second note. A lead with no domain is left out and listed: filed by name alone it would
 * land on the agency's own record.
 *
 * `--from discovered` files the output of `pnpm discover` instead: every `data/discovered-*.json`
 * (or `--file <path>`, repeatable), one `create_lead` per lead with the contact, the phone and the
 * `RESEARCH:` note. A lead with no contact email is left out: a lead without an email is not a lead.
 *
 * Env: DASHBOARD_MCP_URL (the app's `/mcp`), DASHBOARD_MCP_TOKEN (`VETTA_MCP_TOKEN`, or one minted
 * with `POST /api/mcp/tokens`).
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DiscoveredLead } from "./discover.ts";
import { cityFromAddress, type Lead, limiter, voiceClient, type WorkerResult, withRetry } from "./worker.ts";

export interface Filing {
  shop_id: string;
  lead: { name: string; domain: string; source: "outreach"; note: string };
  note: string;
  next_action: string;
}

/** What to file for one created demo, or null when the lead has no domain to file it under. */
export function filingFor(result: WorkerResult, lead: Lead | undefined): Filing | null {
  const domain = lead?.domain?.trim().toLowerCase();
  if (!lead || !domain || result.status !== "created") return null;
  const city = cityFromAddress(lead.shop_input.address);
  const facts = [
    `Demo receptionist built (voice shop_id ${result.shop_id}).`,
    result.demo_url ? `Demo page: ${result.demo_url}` : null,
    lead.shop_input.phone ? `Shop phone (public): ${lead.shop_input.phone}` : null,
    city ? `City: ${city}` : null,
    "No contact email on file yet.",
    "Per OUTREACH-PLAN.md the first email carries no demo link; share it only once the shop replies with interest.",
  ].filter(Boolean);
  return {
    shop_id: result.shop_id,
    lead: { name: lead.shop_input.name, domain, source: "outreach", note: lead.note ?? "" },
    note: facts.join("\n"),
    next_action: "Find an owner or front-desk email, then draft the first outreach (no demo link).",
  };
}

export interface DiscoveredFiling {
  name: string;
  domain: string;
  contact_name?: string;
  contact_email: string;
  contact_role?: string;
  phone?: string;
  source: "outreach";
  note: string;
}

/** The create_lead arguments for one discovered lead, or null without a domain, an email, or a RESEARCH note. */
export function filingForDiscovered(lead: Partial<DiscoveredLead>): DiscoveredFiling | null {
  const domain = lead.domain?.trim().toLowerCase();
  const email = lead.contact_email?.trim().toLowerCase();
  if (!lead.name || !domain || !email || !lead.note?.startsWith("RESEARCH:")) return null;
  return {
    name: lead.name, domain, contact_email: email, source: "outreach", note: lead.note,
    ...(lead.contact_first_name ? { contact_name: lead.contact_first_name } : {}),
    ...(lead.contact_role ? { contact_role: lead.contact_role } : {}),
    ...(lead.phone ? { phone: lead.phone } : {}),
  };
}

/** Filings from several discovered files, one per domain. */
export function mergeDiscovered(files: unknown[]): { filings: DiscoveredFiling[]; skipped: number } {
  const byDomain = new Map<string, DiscoveredFiling>();
  let skipped = 0;
  for (const file of files) {
    for (const lead of Array.isArray(file) ? (file as Array<Partial<DiscoveredLead>>) : []) {
      const filing = filingForDiscovered(lead);
      if (!filing) skipped++;
      else if (!byDomain.has(filing.domain)) byDomain.set(filing.domain, filing);
    }
  }
  return { filings: [...byDomain.values()], skipped };
}

async function importDiscovered(execute: boolean, dataDir: string, files: string[]) {
  const paths = files.length ? files.map((f) => resolve(f)) : (await readdir(dataDir)).filter((n) => /^discovered-.*\.json$/.test(n)).sort().map((n) => join(dataDir, n));
  const parsed = await Promise.all(paths.map(async (p) => JSON.parse(await readFile(p, "utf8")) as unknown));
  const { filings, skipped } = mergeDiscovered(parsed);
  console.log(`${execute ? "EXECUTE" : "DRY RUN"}: ${filings.length} to file from ${paths.length} file(s), ${skipped} left out (no domain, email or RESEARCH note)`);
  if (!execute) {
    for (const f of filings) console.log(`file    ${f.domain}  ${f.name}  ${f.contact_email}`);
    return;
  }
  const url = process.env["DASHBOARD_MCP_URL"];
  const token = process.env["DASHBOARD_MCP_TOKEN"];
  if (!url || !token) {
    console.error("Set DASHBOARD_MCP_URL (the app's /mcp) and DASHBOARD_MCP_TOKEN.");
    process.exit(1);
  }
  const call = voiceClient(url, token);
  const limit = limiter(4);
  const counts = { filed: 0, already: 0, error: 0 };
  await Promise.all(filings.map((f) => limit(async () => {
    try {
      const lead = await withRetry(() => call<{ id: string; already_filed?: boolean }>("create_lead", { ...f }));
      if (lead.already_filed) counts.already++;
      else counts.filed++;
      console.log(`${lead.already_filed ? "already" : "filed  "} ${lead.id}  ${f.name}`);
    } catch (e) {
      counts.error++;
      console.log(`error   ${f.name}  ${(e as Error).message ?? e}`);
    }
  })));
  console.log(`done: filed ${counts.filed}, already in CRM ${counts.already}, errors ${counts.error}, left out ${skipped}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const here = dirname(fileURLToPath(import.meta.url));
  const fromAt = argv.indexOf("--from");
  if (fromAt >= 0) {
    if (argv[fromAt + 1] !== "discovered") throw new Error("--from takes: discovered");
    const files = argv.flatMap((arg, i) => (arg === "--file" && argv[i + 1] ? [argv[i + 1] as string] : []));
    await importDiscovered(execute, resolve(here, "../data"), files);
    return;
  }
  const results = JSON.parse(await readFile(resolve(here, "../data/worker-results.json"), "utf8")) as WorkerResult[];
  const leads = JSON.parse(await readFile(resolve(here, "../../leads/bay-area-auto.json"), "utf8")) as Lead[];
  const byName = new Map(leads.map((lead) => [lead.shop_input.name, lead]));

  const filings: Filing[] = [];
  const noDomain: string[] = [];
  for (const result of results.filter((r) => r.status === "created")) {
    const filing = filingFor(result, byName.get(result.name));
    if (filing) filings.push(filing);
    else noDomain.push(`${result.shop_id} (${result.name})`);
  }
  console.log(`${execute ? "EXECUTE" : "DRY RUN"}: ${filings.length} to file, ${noDomain.length} left out with no domain`);
  for (const id of noDomain) console.log(`  no domain: ${id}`);
  if (!execute) {
    for (const f of filings) console.log(`file    ${f.lead.domain}  ${f.lead.name}`);
    return;
  }

  const url = process.env["DASHBOARD_MCP_URL"];
  const token = process.env["DASHBOARD_MCP_TOKEN"];
  if (!url || !token) {
    console.error("Set DASHBOARD_MCP_URL (the app's /mcp) and DASHBOARD_MCP_TOKEN.");
    process.exit(1);
  }
  const call = voiceClient(url, token);
  const limit = limiter(4);
  const counts = { filed: 0, already: 0, error: 0 };
  await Promise.all(filings.map((f) => limit(async () => {
    try {
      const lead = await withRetry(() => call<{ id: string; already_filed?: boolean }>("create_lead", f.lead));
      if (lead.already_filed) {
        counts.already++;
        console.log(`already ${lead.id}  ${f.lead.name}`);
        return;
      }
      await withRetry(() => call("add_client_note", { id: lead.id, note: f.note, next_action: f.next_action }));
      counts.filed++;
      console.log(`filed   ${lead.id}  ${f.lead.name}`);
    } catch (e) {
      counts.error++;
      console.log(`error   ${f.lead.name}  ${(e as Error).message ?? e}`);
    }
  })));
  console.log(`done: filed ${counts.filed}, already in CRM ${counts.already}, errors ${counts.error}, no domain ${noDomain.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error((e as Error).message ?? e);
    process.exit(1);
  });
}
