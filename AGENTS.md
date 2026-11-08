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

- autoops-voice exposes an MCP server: `provision_receptionist`, `get_receptionist`, `update_receptionist`, `simulate_call`, `get_call`, `list_calls`. Input shape is `ShopInput` (`name` required; `kind` repair or towing; `demo` true for preview mode).
- The dashboard MCP takes leads via `create_lead`. Research notes start with `RESEARCH:`, operator calls with `OPERATOR CALLED:`, receptionist links with `RECEPTIONIST:`.
- Pipeline: research, then a demo receptionist (`demo: true`), then an outreach draft that includes its demo link, then human approval to send.

## Rules

- Never commit secrets. Use git-ignored `.env` files and document variable names only.
- Never push to `main`, force-push, or rewrite shared history.
- Never spend money, send outbound email or SMS, call a business, or post publicly without a human approving it in the issue.
- Unclaimed receptionists stay in preview mode and their numbers are never published.
- Every agent respects the spend caps set in config.
- If two agents disagree, write both options in the issue and let a human decide.
