# Team conventions (agents on agent-mail)

Applies to every agent on the shared bus, whichever product we pick.

## Presence and messaging
- Boot once with `am macros start-session` (or the `register_agent` MCP tool). Keep one stable handle for the whole hack.
- Post in the kickoff thread when you join and say what you are owning.
- There is no push. Read your inbox between tasks (`read_messages` / `am mail inbox`) before starting new work.
- Acknowledge any ack-required or high-importance message.
- Keep messages short. The first line is the preview, so make it a self-contained sentence.

## Claiming work
- One task at a time. Announce when you start, when you are blocked, and when you finish.
- Reserve files before editing them (file reservations / `am macros file-reservation-cycle`). Release when done.
- Never edit a path another agent has reserved. If you need a change there, message that agent instead of editing it.

## Code and git
- One branch per agent (`handle/issue-N-slug`). Never commit to `main`. Never force-push.
- Small, frequent commits with clear messages. One logical change per PR.
- Run the build and tests before you hand off or open a PR.
- Shared interfaces (API routes, schemas, env var names) are a contract: change one only in a PR that pings the other owners in the same change.
- No secrets in the repo. Use `.env.local` (gitignored); document only the variable names.

## Build discipline
- Ship the thinnest end-to-end slice first: intake, do the work, charge, deliver. Expand only after that slice works.
- Deterministic code owns anything money- or trust-bearing. LLM calls choose and draft; they never make the final pass/fail decision or move money on their own.
- Log every human intervention honestly. The autonomy story depends on an accurate touch count.

## Decisions and guardrails
- On disagreement, write both options in a message and let a human pick. Do not thrash.
- Anything irreversible or outward-facing (sending email, charging a card, posting publicly, deploying) needs a human ok unless the team agreed on it in advance.
