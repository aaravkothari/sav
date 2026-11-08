/**
 * Start one run of the company's workflow on the real Naïve platform, for a goal.
 *
 *   pnpm live:run --confirm-spend "Sign up our first shop in San Francisco"
 *
 * 1. Puts this run's cards on the CEO's board: one per `PIPELINE` step, keyed to this run, in order
 *    (`blocked_by`), and UNASSIGNED, so nothing starts yet.
 * 2. Asks the CEO to hand each card to its owner. Assigning is what wakes an agent; a card whose
 *    blocker is not done waits, and starts by itself when it is.
 * 3. Prints the board. Follow the rest on the dashboard's Runs screen (`/app/runs`), which can also start a run.
 *
 * THIS SPENDS REAL MONEY: Naïve model calls from your credits and, once approved, Monid runs from
 * your Monid balance. It never approves anything itself: every `ask` tool call waits for you on the
 * dashboard's Approvals screen or in the agent's Studio chat.
 */
import { createClient } from "@usenaive-sdk/managed-agents";
import { configFromEnv } from "../server/proxy.ts";
import { startRun } from "../server/runs.ts";

const args = process.argv.slice(2);
if (!args.includes("--confirm-spend")) {
  console.error("Refusing to run: this starts real, billed sessions. Re-run with --confirm-spend.");
  process.exit(1);
}
const apiKey = process.env["NAIVE_API_KEY"];
if (!apiKey) {
  console.error("Set NAIVE_API_KEY in .env.");
  process.exit(1);
}
const goal = args.filter((a) => !a.startsWith("--")).join(" ") || "Sign up our first auto repair shop in the San Francisco Bay Area";

const naive = createClient({ baseUrl: "https://api.vetta.sh", apiKey });

const agents = await naive.agents.list({ limit: 100 });
const ceo = agents.data.find((agent) => agent.metadata?.["role"] === "orchestrator");
if (!ceo) {
  console.error("No CEO in this organization yet. Run `pnpm naive:plan`, then `pnpm naive:up`, first.");
  process.exit(1);
}

// 1-2. The run's cards and the CEO's delegation: the same code the dashboard's Runs screen calls.
const config = configFromEnv(process.env);
if (!config) {
  console.error("Set NAIVE_API_KEY in .env.");
  process.exit(1);
}
const started = await startRun(config, ceo.id, goal, new Date());
const run = started.run;
const session = { id: started.session_id };
console.log(`${run}: ${started.cards} cards on the CEO's board for "${goal}"`);
console.log(`CEO session ${session.id} started\n`);
for await (const event of naive.stream(session.id)) console.log(`${String(event.seq).padStart(4)} ${event.type}`);

// 3. Where things stand.
const cards = await naive.board.cards.ofAgent(ceo.id, { limit: 100 });
console.log(`\nThis run's cards:`);
for (const card of cards.data.filter((c) => c.title.endsWith(`(${run})`))) {
  console.log(`  ${card.id} ${card.status.padEnd(7)} ${(card.assignee ?? "-").padEnd(16)} ${card.title}`);
}
console.log(`\nApprovals: your dashboard's Approvals screen, or each agent's chat in the Studio.`);
console.log(`Board: pnpm naive board show ${ceo.id}`);
