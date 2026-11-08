/**
 * File researched leads that HAVE an email into the dashboard CRM, ready for the outbound engine.
 *
 *   pnpm lead-import data/import-leads.json             # dry run (the default)
 *   pnpm lead-import data/import-leads.json --execute   # really call create_lead / add_client_note
 *
 * Each row: { name, domain?, email, contact_name?, contact_role?, phone?, note, shop_id?, sector? }.
 * `note` is the RESEARCH note; its `Opener detail:` line is what the engine puts after "noticed".
 * A row without an email is skipped: a lead without an email is not a lead (Aarav, Nov 8).
 * A row with a `shop_id` (a demo already built on autoops-voice) also gets a `RECEPTIONIST:` note
 * holding the shop_id and the demo PATH (`/demo/<id>`), so it survives a voice host move.
 *
 * Idempotent: create_lead answers `already_filed` for a domain, email or phone already in the CRM,
 * and that row gets no second note.
 *
 * Env: DASHBOARD_URL + DASHBOARD_TOKEN (the operator bearer; /mcp accepts it since #52).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { limiter, voiceClient, withRetry } from "./worker.ts";

export interface ImportRow {
  name: string;
  domain?: string | null;
  email?: string | null;
  contact_name?: string | null;
  contact_role?: string | null;
  phone?: string | null;
  note: string;
  shop_id?: string | null;
  sector?: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/** The create_lead arguments for one row, or null when the row is not a lead (no usable email). */
export function leadArgs(row: ImportRow): Record<string, string> | null {
  const email = row.email?.trim().toLowerCase();
  if (!email || !EMAIL.test(email) || !row.name?.trim()) return null;
  const note = row.note.trim().startsWith("RESEARCH:") ? row.note.trim() : `RESEARCH: ${row.note.trim()}`;
  const args: Record<string, string> = { name: row.name.trim(), contact_email: email, source: "outreach", note: row.sector ? `${note}\nSector: ${row.sector}` : note };
  if (row.domain) args["domain"] = row.domain.trim().toLowerCase().replace(/^www\./, "");
  if (row.contact_name) args["contact_name"] = row.contact_name.trim();
  if (row.contact_role) args["contact_role"] = row.contact_role.trim();
  if (row.phone) args["phone"] = row.phone.trim();
  return args;
}

/** The RECEPTIONIST: note for a row whose demo is already built. */
export function receptionistNote(shopId: string): string {
  return `RECEPTIONIST: shop_id ${shopId}\ndemo_url /demo/${shopId}\npreview`;
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const file = args.find((a) => !a.startsWith("--")) ?? "data/import-leads.json";
  const rows = JSON.parse(await readFile(resolve(file), "utf8")) as ImportRow[];
  const leads = rows.map((row) => ({ row, args: leadArgs(row) }));
  const skipped = leads.filter((l) => l.args === null);
  const ready = leads.filter((l) => l.args !== null);
  console.log(`${execute ? "EXECUTE" : "DRY RUN"}: ${ready.length} to file, ${skipped.length} skipped (no email)`);
  if (!execute) {
    for (const { row, args: a } of ready) console.log(`file    ${a!["contact_email"]}  ${row.name}${row.shop_id ? "  (+demo)" : ""}`);
    return;
  }
  const base = process.env["DASHBOARD_URL"];
  const token = process.env["DASHBOARD_TOKEN"];
  if (!base || !token) {
    console.error("Set DASHBOARD_URL and DASHBOARD_TOKEN.");
    process.exit(1);
  }
  const call = voiceClient(`${base.replace(/\/$/, "")}/mcp`, token);
  const limit = limiter(4);
  const counts = { filed: 0, already: 0, error: 0 };
  await Promise.all(ready.map(({ row, args: a }) => limit(async () => {
    try {
      const lead = await withRetry(() => call<{ id: string; already_filed?: boolean }>("create_lead", a!));
      if (lead.already_filed) {
        counts.already++;
        console.log(`already ${row.name}`);
        return;
      }
      if (row.shop_id) await withRetry(() => call("add_client_note", { id: lead.id, note: receptionistNote(row.shop_id!) }));
      counts.filed++;
      console.log(`filed   ${row.name}`);
    } catch (e) {
      counts.error++;
      console.log(`error   ${row.name}  ${(e as Error).message ?? e}`);
    }
  })));
  console.log(`done: filed ${counts.filed}, already in CRM ${counts.already}, errors ${counts.error}, skipped ${skipped.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error((e as Error).message ?? e);
    process.exit(1);
  });
}
