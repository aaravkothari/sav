# AI Receptionist for Auto Repair Shops

An autonomous company on [Naïve](https://usenaive.ai/docs), built on Naïve's **agency blueprint** (`blank` template). The blueprint provides the company itself: a public site, an operator dashboard (CRM pipeline, Approvals, per-shop workspaces), an MCP server the agents work through, and a company identity. This repo adds the crew for one business: finding independent auto repair shops, signing them up, and giving each one an AI receptionist.

**Status: foundation only.** Every agent is a placeholder that closes its card with a `MOCK:` note. Nothing scrapes, emails, calls, or uses a paid API.

> The blueprint's own README is kept as [BLUEPRINT.md](BLUEPRINT.md). It is the reference for the dashboard, the MCP tools, the site and the deploy.

## The company

| Seat | Role | Status | Defined in |
| --- | --- | --- | --- |
| **CEO** | Coordinator. Owns the board and hands each card to a specialist. | Created by `naive up` | the platform's standing orchestrator |
| `research` | Find and qualify repair shops | placeholder | `templates/receptionist.ts` |
| `sales` | Outreach. Sending needs approval. | placeholder | 〃 |
| `client-manager` | Onboarding: hours, services, greeting, booking rules | placeholder | 〃 |
| `booking--<shop>` | One receptionist per shop: answers calls, books appointments | placeholder | 〃 (per-shop crew) |
| `monitoring` | Watches calls, bookings and failures | placeholder | 〃 |
| `self-improvement` | Proposes changes to prompts and process; never applies them | placeholder | 〃 |

How Naïve's built-in pieces are used:

- **The CEO and its board.** `naive.config.ts` declares the company's first workflow as `tasks` (`PIPELINE` in `templates/receptionist.ts`). Declaring `tasks` is what makes `naive up` create the organization's CEO, give it the company board, and add this crew to its roster. A card assigned to a seat starts that seat working on it. When a card is `done` or `blocked`, the CEO is told.
- **The per-shop receptionist.** This uses the blueprint's per-client crew. When a shop is moved to *active* in the dashboard, `server/proxy.ts` creates `booking--<shop-slug>` for it.
- **No approval gates.** Every seat is deny-by-default, and every tool it does hold runs without asking, email sends included (Aarav's call, Nov 8). Spending is bounded by each seat's budget. The only card left on **Approvals** from our config is `ask_operator`, an agent asking you a question. Naïve's own hold still applies: once a session has read people's data (contact names and emails), the platform holds its later outside calls, and no setting turns that off. Research is arranged not to read the CRM so its lookups aren't held.
- **Kept from the blueprint:** `sales` and `client-manager` keep their names because the dashboard's chat talks to `client-manager`. The four other agency seats are not used. The shared crew in `templates/agents.ts` is untouched because the `seo-geo` template still builds on it.

### Where things live

```
naive.config.ts            the company as code (blueprint + template + identity + app + tasks)
templates/receptionist.ts  OUR CREW: seats, prompts, tool permissions, budgets, the pipeline
templates/blank.ts         the template: wires the crew in; setup questions; demo shops
templates/index.ts         the template's words: site copy, dashboard wording, kinds of work
sim/                       free local simulation of the CEO's board, plus the end-to-end test
scripts/live-run.ts        trigger the workflow on the real platform (billed, opt-in)
src/ server/ site/         the blueprint's dashboard, API/MCP server and public site (unchanged)
```

## Integrations

| Service | Used by | What runs freely | What waits for your approval |
| --- | --- | --- | --- |
| [AgentMail](https://agentmail.to) (email inboxes) | `sales`, `client-manager` | everything offered: reading, drafting, creating the company inbox, sending, replying, forwarding | nothing (Naïve may still hold a call after the session read contacts). Deleting is not offered. |
| [Monid](https://monid.ai) (~2,800 data tools) | `research` | searching the catalogue, inspecting a tool, every `monid_run` (spends your Monid balance, capped by the seat budget), reading runs, balance | nothing. Top-ups and disputes are not offered. |

Both connect as MCP servers (`templates/receptionist.ts`). Their API keys come from `.env` (`AGENTMAIL_API_KEY`, `MONID_API_KEY`) and `naive up` seals them into the `agency-integrations` vault of the agency identity. Naïve injects each key when a session connects, so agents, prompts and transcripts never see it. Vault credentials are write-once: to rotate a key, create the new credential and delete the old one on the platform; editing `.env` and re-running `up` changes nothing.

The seats are still placeholders and are told not to call external services. The tools are ready for when each seat is built for real.

For development here in Claude Code, the Monid CLI and skill are installed too (`.claude/skills/monid/`), with the key registered via `monid keys add`.

## Run it locally (free)

Requires Node 22.6 or newer, and pnpm.

```bash
pnpm install
pnpm test          # the blueprint's test suite plus ours (sim/company.test.ts)
pnpm demo          # trigger the workflow and watch the agents talk; it asks you to approve the email send
pnpm demo --approve "Sign up a shop in Denver"   # non-interactive, custom goal
pnpm demo --deny                                 # see a denial respected
```

**The end-to-end test** (`sim/company.test.ts`) plays the same crew, permissions and `PIPELINE` that `naive up` applies, on a local copy of the board. It checks:

1. **Delegation:** the CEO turns one goal into 6 cards and hands each to its owner, in order.
2. **Results come back:** each seat closes its card with a note and a result, and later seats use them. For example, the test call is booked for the shop onboarding set up.
3. **Progress:** board counts after each step (`1/6 → 6/6`), a digest to the CEO for each card that finishes or gets blocked, and a final CEO report.
4. **Approvals:** outreach waits on `email.send` and nothing after it runs until you decide. A denial is respected.
5. **The config:** our crew on the `agency/blank` template; tasks are unassigned and there are no intakes or timers; every outward tool is `ask`.

**The dashboard**, with no key and no cost:

```bash
pnpm build && pnpm serve     # site at http://localhost:8789/, dashboard at /app
```

The CRM and the work queue are the app's own store. Locally it starts with the plainly-fake demo shops (`data/` is git-ignored; delete it to reseed). Screens that need the platform say *not configured* until `NAIVE_API_KEY` is in `.env`.

## The outbound engine (`pnpm engine`)

`scripts/engine.ts` runs three jobs with no LLM: the cold-email sender (every 30 min, Aarav's template in `templates/outreach-template.ts`, ramp 25 → 50 → 100 a tick, 2,500 a day), the inbox watcher (every 2 min: files `REPLY RECEIVED:` / `BOUNCED:` / `AUTO-REPLY:` notes, wakes `client-manager` with `SHOP REPLIED:`), and the approval sweep (every 15 s, `POST /api/approvals/auto`, whose hard limits live in `server/autoapprove.ts`). Dry run by default; `--once` runs one tick of each; `--execute` sends. State and the sent ledger live in `data/` (git-ignored). The header comment of the script has the details and env vars.

## Deploy to Naïve

This creates real resources, and agents spend real USD from prepaid credits once they run. These steps follow https://usenaive.ai/skill.md.

1. **Account:** `npx naive login` (or `npx naive auth register …`), then `npx naive whoami`.
2. **Plan + credits:** `npx naive plan subscribe` and `npx naive credits topup --usd …`. Both print a checkout link that you open and pay yourself.
3. **Put your API key in `.env`** (git-ignored; `.env.example` shows the shape): `NAIVE_API_KEY=sk_live_…`. Every script below reads it, and `pnpm naive …` runs any CLI command with it, e.g. `pnpm naive whoami`.
4. **Check the budgets.** Every seat runs on a placeholder of **$5.00** a month, at most **$0.50** per task (`placeholderBudget` in `templates/receptionist.ts`), on the cheap `z-ai/glm-5.3-flash` model. `naive up` creates the CEO itself, with Naïve's default of $50/month and $5/task.
5. **Preview, then apply.** The dashboard app gets its own key minted from yours on the first apply:
   ```bash
   pnpm naive:plan    # naive up --dry-run: everything it would create, nothing written
   pnpm naive:up      # identity, dashboard app, 5 agents, the CEO + board, 6 unassigned cards
   ```
   Read the report: every line is `created`, `updated`, `unchanged`, `kept`, `skipped` or `refused`. **Nothing runs until you start it.** There are no intakes or timers, and the cards are unassigned.
6. **Trigger the workflow (billed):**
   ```bash
   pnpm live:run --confirm-spend      # the CEO assigns each card to its owner; seats close them with MOCK notes
   ```
   Watch it with `pnpm naive session list`, `pnpm naive board --help`, and the dashboard's **Approvals** screen. `live:run` never approves anything. The `test-call` card waits for a shop's `booking--<shop>` agent, which exists only after you move a shop to active in the dashboard.

Setup questions (what the receptionist promises, which shops to target, pricing, and an optional list of shop owners you know) are asked by the Studio on a hosted install. Their answers become the context every agent reads first.

## Building the real features

Build one seat at a time:

1. Rewrite its prompt and tools in `templates/receptionist.ts`. Remove the `PLACEHOLDER` paragraph, give it the dashboard tools it needs (see BLUEPRINT.md, *Agents and the CRM*), and keep send, pay and delete tools at `ask`.
2. Replace its handler in `sim/mock-agents.ts` and update the tests.
3. `pnpm naive:plan`, then `pnpm naive:up`. Agents are matched by name; renaming one needs the old name under `removed`.

Rules carried over from the blueprint: *Invent nothing.* No agent writes a shop, a contact, a number or a testimonial that the context does not give it. Nothing is sent or published without your approval.

Notes from the Naïve docs:
- Phone calls and inbound texts need an **identity** that owns a number. Sending a text from inside an agent's turn is not available yet (texts go out through the API/CLI only), so design `booking` around that.
- `GET https://api.vetta.sh/v1/openapi.json` is the authoritative route list if anything here drifts.
