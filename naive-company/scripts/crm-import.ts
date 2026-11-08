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
 * Env: DASHBOARD_MCP_URL (the app's `/mcp`), DASHBOARD_MCP_TOKEN (`VETTA_MCP_TOKEN`, or one minted
 * with `POST /api/mcp/tokens`).
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

async function main() {
  const execute = process.argv.includes("--execute");
  const here = dirname(fileURLToPath(import.meta.url));
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
