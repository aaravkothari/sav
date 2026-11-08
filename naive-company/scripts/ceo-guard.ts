/**
 * Keep the CEO from reading people's data, so it never flags the crew.
 *
 *   pnpm ceo:guard          # apply
 *   pnpm ceo:guard --check  # show what it would change
 *
 * Naïve flags a chat that reads contacts, mail, messages or a connected app, and every chat it
 * hands work to (docs: capabilities/tools, "Once a chat has read people's data"). A flagged chat's
 * MCP tools, `board_write` and `data_run` then ask each time, whatever the policy. On Nov 8 the CEO
 * read the CRM (`dashboard.list_clients`) while starting a run, commented on research's card, and
 * every research call after that waited on Approvals.
 *
 * The CEO is the platform's orchestrator: `naive up` creates it but `naive.config.ts` declares no
 * toolset for it, and it holds nearly every tool at `allow`. This denies it every read of people's
 * data and every dashboard (CRM) tool. It only needs the board and the roster. Idempotent; run it
 * again after anything that recreates the CEO.
 */
import { collect, configFromEnv, proxyFetch } from "../server/proxy.ts";
import { TOOLS } from "../server/mcp.ts";

/** Reads that return people's data, by the platform's names, plus our CRM tools (`dashboard.*`). */
export const CEO_DENY = [
  "crm.read", "crm.write", "email.read", "email.inboxes", "email.send", "phone.read", "phone.numbers",
  "social.accounts", "connections.search", "connections.status", "connections.connect",
  ...TOOLS.map((tool) => `dashboard.${tool.name}`),
];

const config = configFromEnv(process.env);
if (!config) {
  console.error("Set NAIVE_API_KEY in .env.");
  process.exit(1);
}
const check = process.argv.includes("--check");
const agents = await collect<{ id: string; name: string; metadata?: Record<string, unknown> | null }>(config, "/v1/agents");
if (agents === null) {
  console.error("Could not list the agents (the platform may be rate-limiting): try again in a minute.");
  process.exit(1);
}
const ceo = agents.find((a) => a.metadata?.["role"] === "orchestrator");
if (!ceo) {
  console.error("No CEO in this organization yet: run `pnpm naive:up` first.");
  process.exit(1);
}
const res = await proxyFetch(config, { method: "GET", path: `/v1/agents/${ceo.id}` }, null);
const agent = (await res.json()) as { tools?: { default_config: unknown; configs: Record<string, { enabled?: boolean; permission: string }> } };
const configs = { ...(agent.tools?.configs ?? {}) };
const changed = CEO_DENY.filter((name) => configs[name]?.permission !== "deny");
for (const name of changed) configs[name] = { enabled: false, permission: "deny" };
console.log(`CEO ${ceo.id}: ${changed.length} tool(s) to deny${changed.length ? `: ${changed.join(", ")}` : ""}`);
if (check || changed.length === 0) process.exit(0);
const patched = await proxyFetch(config, { method: "PATCH", path: `/v1/agents/${ceo.id}` },
  JSON.stringify({ tools: { default_config: agent.tools?.default_config ?? { permission: "allow" }, configs } }));
const body = (await patched.json()) as { current_version?: number; error?: unknown };
if (!patched.ok) {
  console.error(`refused (${patched.status}):`, JSON.stringify(body.error));
  process.exit(1);
}
console.log(`denied; the CEO is now version ${body.current_version}. Sessions started before this keep their old tools.`);
