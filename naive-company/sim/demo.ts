/**
 * Trigger a workflow locally and watch the crew talk. Free: everything is mocked.
 *
 *   pnpm demo                                   # asks you to approve the email send
 *   pnpm demo --approve                         # approve without asking
 *   pnpm demo --deny "Find shops in Denver"     # deny, with a custom goal
 */
import { createInterface } from "node:readline/promises";
import { mockCeo, mockHandlers } from "./mock-agents.ts";
import { LocalCompany, type CompanyEvent } from "./runtime.ts";

const args = process.argv.slice(2);
const flag = args.find((a) => a === "--approve" || a === "--deny");
const goal = args.filter((a) => !a.startsWith("--")).join(" ") || "Sign up our first auto repair shop in Austin, TX";

const ARROW: Record<CompanyEvent["type"], string> = {
  "goal.received": "🎯",
  "card.created": "📝",
  "card.assigned": "➡️ ",
  "card.claimed": "🔧",
  "card.done": "✅",
  "card.blocked": "⛔",
  "approval.requested": "✋",
  "approval.resolved": "🧑",
  "ceo.digest": "📊",
  "ceo.report": "🏁",
};

function print(e: CompanyEvent) {
  const who = e.to ? `${e.from} → ${e.to}` : e.from;
  const card = e.card_id ? ` [${e.card_id}]` : "";
  console.log(`${String(e.seq).padStart(3)} ${ARROW[e.type]} ${e.type.padEnd(19)} ${who.padEnd(28)}${card} ${e.text}`);
}

const company = new LocalCompany(mockCeo, mockHandlers);
company.onEvent(print);

console.log(`\n=== Workflow: "${goal}" ===\n`);
let progress = company.start(goal);

// Answer every parked `ask` call, the way an operator would in the Studio or with `naive session confirm`.
for (let pending = company.pendingApprovals(); pending.length; pending = company.pendingApprovals()) {
  for (const a of pending) {
    console.log(`\n  ✋ ${a.agent} wants to call ${a.tool}:`);
    console.log(JSON.stringify(a.args, null, 2).replace(/^/gm, "     "));
    let decision: "allow" | "deny";
    if (flag) decision = flag === "--approve" ? "allow" : "deny";
    else if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`  Approve ${a.id}? [y/N] `);
      rl.close();
      decision = /^y/i.test(answer.trim()) ? "allow" : "deny";
    } else decision = "deny"; // never approve silently
    console.log();
    progress = company.confirm(a.id, decision);
  }
}

console.log("\n=== Board ===");
for (const c of company.cards) console.log(`  ${c.id} ${c.status.padEnd(7)} ${c.assignee.padEnd(17)} ${c.title}`);
console.log(`\nProgress: ${progress.done}/${progress.total} done (${progress.percent}%)\n`);
