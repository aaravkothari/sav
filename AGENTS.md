# Agent protocol

Three coding agents build this repo together, each on a different laptop. They
talk over MCP Agent Mail (project `naive-yc-hackathon`); see
`AGENT-CONVENTIONS.md` for the messaging rules.

| Agent | Tool | Human |
|---|---|---|
| PinkFalcon | Claude Code | Vedant |
| FoggyReef | Claude Code | Aarav |
| BeigeElk | Claude Code | Swayam |

All three agents have equal authority. Anyone can claim work, open issues, review and merge, and recruit more coding agents when a task needs it (register them on Agent Mail, add their handle to the table and an `agent:<handle>` label). Area owners still decide inside their area.

GitHub is the shared record. Issues are the task queue, PRs are the handoff,
Agent Mail is the fast lane. Nothing important lives only in one agent's context.

## Deadline

Build done by **7:00 am PT Sun Nov 8**. Hard stop 11:00 am. Feature freeze at 7:00 am.

## Before every task

1. `git checkout main && git pull --rebase`
2. Check your Agent Mail inbox and acknowledge anything that asks for it.
3. `gh issue list --label agent:<handle> --state open`
4. `gh issue list --label status:blocked --state open` and answer anything you can.
5. `gh pr list --search "review-requested:@me"` and review those first.

## Claiming work

1. Pick the lowest-numbered open issue with your label, or an unlabeled one in your area.
2. `gh issue edit <N> --add-label status:claimed` and comment `claimed by <handle>` with a one-line plan.
3. Announce the claim on Agent Mail and reserve the files you will edit.

## Building

- Branch: `<handle>/issue-<N>-<slug>`. Never commit to `main`.
- Stay inside your area (see Ownership). If you need a change in another area, open an issue labeled for that agent instead of editing it.
- Keep PRs small. One issue per PR. Run the build and tests before opening one.

## Handing off

1. `gh pr create --fill --body "Closes #<N>"` and request review from one other owner.
2. If blocked, add `status:blocked` and comment exactly what you need and from whom.
3. Anything a human must do or approve gets `needs-human`.
4. Contract changes (MCP tool shapes, ShopInput, lead/note formats, env var names) go in the PR description and are announced on Agent Mail to the other two agents.

## Merging

- Squash merge after one approval and green checks.
- After merging, comment on any issue that was waiting on it.

## Ownership

| Area | Owner |
|---|---|
| `naive-company/` (Naive crew, CEO board, dashboard) | FoggyReef |
| `autoops-voice/` (Vapi receptionist, MCP server, demo page, portal) | BeigeElk |
| Coordination, issue board, discovery data, lead list | PinkFalcon |
| Root docs (`AGENTS.md`, `AGENT-CONVENTIONS.md`, `README.md`) | shared, PR only |

FoggyReef has the final say on anything built on Naive.

## Integration contract

**autoops-voice MCP** (owner BeigeElk; repo [swayambshah/autoops-voice](https://github.com/swayambshah/autoops-voice)). Streamable HTTP, stateless, `Authorization: Bearer <MCP_BEARER_TOKEN>` (humans pass the token; vault it as a `static_bearer`). URL is posted on Agent Mail topic `voice-mcp` and changes only if the tunnel restarts.

| Tool | Permission | Spend | Purpose |
|---|---|---|---|
| `provision_demo({ shop, shop_id? })` | allow | none | Prebuilt step. Forces `demo: true`, never attaches a number. Returns `demo_url`, `portal_url`. Idempotent per `shop_id`. |
| `provision_receptionist({ shop, shop_id?, attach_phone_number? })` | **ask** | Vapi number if `attach_phone_number` | Real provisioning; keeps the same assistant and number on re-call, bumps `version`. |
| `get_receptionist({ shop_id })` | allow | none | Current prompt, first message, version, assistant id, phone, facts, URLs. |
| `update_receptionist({ shop_id, system_prompt?, first_message?, policies?, services?, hours? })` | **ask** | none | New prompt version, pushed to Vapi. Prefer facts over `system_prompt`. |
| `simulate_call({ shop_id, customer_script[] })` | allow | Anthropic tokens (Swayam) | Text-mode regression against the live prompt. Returns transcript, requests, `flags` (`quoted_price`, `confirmed_appointment`, `too_long`). |
| `get_call({ call_id })` / `list_calls({ shop_id?, since?, limit? })` | allow | none | Transcripts, summaries, recordings, outcome, appointment requests (`pending | confirmed | declined`). |
| `list_shops({ status? })` | allow | none | Every shop with `kind`, `demo`, `subscription_status`, latest free-week claim. **Signups = `status: "trialing"`.** |

`ShopInput`: `name` required; `kind` `repair` (default) or `towing` (dispatch flow: safety first, location, no ETA promise); `demo` true = preview (first words disclose it is a preview; never implies real dispatch or booking); `hours` keyed `mon..sun`; `services[]`; `policies[]` (one rule per string; `booking_rules` and `handoff` from `RECEPTIONIST CONFIG` map here); `phone`, `address`, `website`, `notify_phone` optional. `greeting` → `first_message` via `update_receptionist`. `calendar` is not supported; appointments are requests the shop confirms in its portal.

**Events from autoops-voice into the Naïve crew** (via `POST /v1/sessions`, Aarav's org):
- Call ended → `monitoring` (`agt_mceqa9m7j7dy1d7xxevqzw5d9p`): message carries `call_id`, `shop_id`, outcome, and instructions to use `get_call` / `update_receptionist` / `simulate_call`.
- Owner clicked **Start my free week** on a demo page → `client-manager` (`agt_wnnf7kyvhcj6v9nbsbnw9pt4dp`): message starts `FREE WEEK STARTED: <shop name>` followed by `shop_id`, `website`, `shop phone`, `owner name`, `owner phone`, `owner email`, `started`, `demo_url`, `portal_url`, one per line. The shop flips to `subscription_status: trialing`.

**Dashboard MCP** takes leads via `create_lead`. Research notes start with `RESEARCH:`, operator calls with `OPERATOR CALLED:`, receptionist links with `RECEPTIONIST:` (carry `shop_id`, `demo_url`, `portal_url`, `phone_number`), owner yes with `SAID YES:`.

**Pipeline:** research → `provision_demo` → outreach draft that leads with the demo link → human approval to send → owner calls the demo → owner clicks Start my free week → `client-manager` onboarding → human approves → `provision_receptionist` (number) when the shop forwards its line.

**Cost guardrails:** every demo call, browser or phone, bills Swayam's Vapi account (~$0.11/min). Attach numbers only for human-marked warm leads. Unclaimed receptionists stay in preview mode and their numbers are never published. `axl-roadside` and `demo-shop` are frozen for the AXL callback and the stage demo; don't call `update_receptionist` or the free-week form on them.

## Rules

- Never commit secrets. Use git-ignored `.env` files and document variable names only.
- Never push to `main`, force-push, or rewrite shared history.
- Never spend money, send outbound email or SMS, call a business, or post publicly without a human approving it in the issue.
- Unclaimed receptionists stay in preview mode and their numbers are never published.
- Every agent respects the spend caps set in config.
- If two agents disagree, write both options in the issue and let a human decide.
