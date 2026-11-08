# AI Receptionist for Auto Repair Shops

An autonomous company on [Naïve](https://usenaive.ai/docs), built on Naïve's **agency blueprint** (`blank` template). The blueprint provides the company itself: a public site, an operator dashboard (CRM pipeline, Approvals, per-shop workspaces), an MCP server the agents work through, and a company identity. This repo adds the crew for one business: finding independent auto repair shops, signing them up, and giving each one an AI receptionist.

**Status: the crew runs itself.** Once `naive up` applies it, capped schedules (America/Los_Angeles) and event wakes keep the company going; pausing the company in the dashboard pauses every timer and interrupts every running session (`server/runs.ts`).

> The blueprint's own README is kept as [BLUEPRINT.md](BLUEPRINT.md). It is the reference for the dashboard, the MCP tools, the site and the deploy.

## The company

All seats are in `templates/receptionist.ts`. Budgets are per day (#34); a schedule's budget is the cap for one fire. Times are America/Los_Angeles.

| Seat | Role | Model | Budget (cap, per task) | Schedule | Woken by |
| --- | --- | --- | --- | --- | --- |
| **CEO** | Hands each board card to a seat | platform default | Naïve default ($50/month, $5/task) | none (platform-owned) | a run from the dashboard |
| `research` | Auto repair leads: one Maps run, email from the shop's own site, Hunter as fallback | `z-ai/glm-5.3-flash` | $2.00/day, $0.75 | 06:00 and 13:00 daily, a new pair of Bay Area cities each weekday, $0.75/fire | a research card |
| `research-salon` | Salon leads | `z-ai/glm-5.3-flash` | $1.00/day, $0.50 | none until the sector is live (`SECTORS[].live`) | a research card |
| `research-drycleaner` | Dry cleaner leads | `z-ai/glm-5.3-flash` | $1.00/day, $0.50 | none until live | a research card |
| `research-pt` | Physical therapy leads | `z-ai/glm-5.3-flash` | $1.00/day, $0.50 | none until live | a research card |
| `research-home` | Plumbing and HVAC leads | `z-ai/glm-5.3-flash` | $1.00/day, $0.50 | none until live | a research card |
| `sales` | Answers shops that replied (demo link, honest answer, or polite close). First emails are the outbound engine's. | `anthropic/claude-sonnet-5` | $3.00/day, $0.50 | every 2 h 07:00 to 21:00, $0.25/fire | `SHOP REPLIED:` |
| `client-manager` | Onboarding questions, the call booking (Google Calendar when connected), `MEETING SCRIPT:` for Aarav | `anthropic/claude-haiku-5.5` | $2.00/day, $0.50 | every 3 h 08:30 to 20:30, $0.25/fire | `FREE WEEK STARTED:`, `BOOK CALL:` |
| `payments` | Stripe checkout link (TEST mode), then `activate_shop` once the subscription is active | `z-ai/glm-5.3-flash` | $1.00/day, $0.25 | every 2 h at :45, 08:45 to 20:45, $0.10/fire | `CHECKOUT NEEDED:` |
| `monitoring` | Every call against the guardrails, PII-free summaries first; uptime of the voice MCP | `z-ai/glm-5.3-flash` | $1.50/day, $0.40 | uptime every 3 h at :15 ($0.08), digest 21:00 ($0.40) | `A receptionist call just ended` |
| `self-improvement` | Fixes flagged calls: simulate, smallest change, simulate again, roll back on a fail | `anthropic/claude-haiku-5.5` | $1.50/day, $0.75 | 22:00 daily, $0.75 | a card |
| `seo` | SAV's own site copy, proposed through `update_site` (a person approves) | `z-ai/glm-5.3-flash` | $1.00/day, $0.50 | Mon and Thu 10:00, $0.50 | a card |
| `promotion` | X and Reddit post drafts and ad ideas into the queue; never posts | `z-ai/glm-5.3-flash` | $1.00/day, $0.50 | Tue and Fri 11:00, $0.40 | a card |
| `coding-liaison` | Collects every seat's `INFRA REQUEST:` notes into one list for the human coding agents | `z-ai/glm-5.3-flash` | $0.50/day, $0.25 | 19:00 daily, $0.20 | a card |
| `booking--<shop>` | One receptionist per active shop (per-shop crew) | `z-ai/glm-5.3-flash` | $1.00/day, $0.50 | none | moving a shop to active |

The live seats' caps add up to $13.50/day; their scheduled fires to about $8/day.

How Naïve's built-in pieces are used:

- **The CEO and its board.** `naive.config.ts` declares the company's first workflow as `tasks` (`PIPELINE` in `templates/receptionist.ts`). Declaring `tasks` is what makes `naive up` create the organization's CEO, give it the company board, and add this crew to its roster. A card assigned to a seat starts that seat working on it. When a card is `done` or `blocked`, the CEO is told.
- **The per-shop receptionist.** This uses the blueprint's per-client crew. When a shop is moved to *active* in the dashboard, `server/proxy.ts` creates `booking--<shop-slug>` for it.
- **No approval gates.** Every seat is deny-by-default, and every tool it does hold runs without asking, email sends included (Aarav's call, Nov 8). Spending is bounded by each seat's budget. What is left on **Approvals** from our config: `ask_operator` (an agent asking you a question) and the `seo` seat's `update_site`, because the public site is public (`server/autoapprove.ts` never approves it for you). Naïve's own hold still applies: once a session has read people's data (contact names and emails), the platform holds its later outside calls, and no setting turns that off. Research is arranged not to read the CRM so its lookups aren't held.
- **Kept names:** `research` (auto repair), `sales`, `client-manager` and `monitoring` keep their names: renaming a seat is a delete plus a create, autoops-voice wakes `monitoring` and `client-manager` by agent id, and the dashboard's chat talks to `client-manager`. The four other agency seats are not used. The shared crew in `templates/agents.ts` is untouched because the `seo-geo` template still builds on it.

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
| [AgentMail](https://agentmail.to) (email inboxes) | `sales` (replies only), `client-manager`, `payments` | everything offered: reading, drafting, creating the company inbox, sending, replying, forwarding | nothing (Naïve may still hold a call after the session read contacts). Deleting is not offered. |
| [Monid](https://monid.ai) (~2,800 data tools) | every `research*` seat | searching the catalogue, inspecting a tool, every `monid_run` (spends your Monid balance, capped by the seat budget), reading runs, balance | nothing. Top-ups and disputes are not offered. |
| autoops-voice (the receptionist, BeigeElk) | `sales`, `payments` (demos, checkout, activation), `monitoring`, `self-improvement`, `booking--<shop>` | reads, PII-free call summaries, simulated calls, preview demos, checkout links, `activate_shop`, and receptionist updates for self-improvement and booking | nothing. `get_claim` (owner contacts) is never offered to an agent. |
| Google Calendar (Naïve managed connector `googlecalendar`) | `client-manager` | finding free slots, creating and updating the onboarding-call event | nothing. Offered only once the account is connected to the agency identity; until then onboarding asks the owner for a time. |

Both connect as MCP servers (`templates/receptionist.ts`). Their API keys come from `.env` (`AGENTMAIL_API_KEY`, `MONID_API_KEY`) and `naive up` seals them into the `agency-integrations` vault of the agency identity. Naïve injects each key when a session connects, so agents, prompts and transcripts never see it. Vault credentials are write-once: to rotate a key, create the new credential and delete the old one on the platform; editing `.env` and re-running `up` changes nothing.

The autoops-voice URL is a quick tunnel (`AUTOOPS.url`). Its vault credential is keyed on that URL, so when the tunnel changes, re-create the `autoops-voice` credential and delete the old one.

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

## Deploy to Naïve

This creates real resources, and agents spend real USD from prepaid credits once they run. These steps follow https://usenaive.ai/skill.md.

1. **Account:** `npx naive login` (or `npx naive auth register …`), then `npx naive whoami`.
2. **Plan + credits:** `npx naive plan subscribe` and `npx naive credits topup --usd …`. Both print a checkout link that you open and pay yourself.
3. **Put your API key in `.env`** (git-ignored; `.env.example` shows the shape): `NAIVE_API_KEY=sk_live_…`. Every script below reads it, and `pnpm naive …` runs any CLI command with it, e.g. `pnpm naive whoami`.
4. **Check the budgets.** Each seat's daily cap, per-task ceiling and model are in the table above (`BUDGETS` and `MODELS` in `templates/receptionist.ts`). `naive up` creates the CEO itself, with Naïve's default of $50/month and $5/task.
5. **Preview, then apply.** The dashboard app gets its own key minted from yours on the first apply:
   ```bash
   pnpm naive:plan    # naive up --dry-run: everything it would create, nothing written
   pnpm naive:up      # identity, dashboard app, 13 agents and their timers, the CEO + board, 6 unassigned cards
   ```
   Read the report: every line is `created`, `updated`, `unchanged`, `kept`, `skipped` or `refused`. **The timers start on the apply.** There are no intakes and the cards are unassigned, but every schedule in the table above is armed. Pause the company from the dashboard to stop them all.
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
