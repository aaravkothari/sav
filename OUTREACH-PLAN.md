# Outreach plan: faster research, volume email, inbox watching

**How to use this file.** Read it before you start any change to research, outreach, the
AgentMail inbox or sending. It is a guide, not a contract. Follow it where it helps, depart from
it where you find something better, and say so in your PR. `AGENTS.md` still wins on ownership,
process and the integration contract.

Owner: FoggyReef (Naïve crew, `naive-company/`). Written Nov 7 with Aarav.

## Decisions already made (operator, Nov 7)

| Decision | What it means in code |
|---|---|
| Outbound email needs no per-send approval | The `AGENTS.md` rule now excludes email. SMS, calls, spend and public posts still need approval in the issue. |
| No email footer | `EMAIL_FOOTER` is removed from `naive-company/templates/receptionist.ts`. Nothing comes after the signature. |
| Demo link only for warm leads | The first email never has a demo link. A reply to a shop that wrote back with interest may add it. Every demo call bills Swayam's Vapi account (~$0.11/min). |
| Reply only when they reply | Outreach never drafts follow-ups or nudges. It drafts a reply only on a thread where the shop wrote back. |

## Where things stand

- **Research** (`research` seat, `templates/receptionist.ts`) runs everything one step after
  another: one Google Maps search through Monid (dataforseo, depth 100), then for each shop
  `provision_demo`, then a Hunter `domain-search` run through Monid, then `create_lead` and notes.
  Every Monid run is a separate inspect, run and poll cycle driven by AI turns. That is why it
  is slow.
- **Outreach** (`sales` seat) drafts one email per lead in AgentMail. `INBOX_RULE` still says
  "drafts only, never send" even though the send tools are `allow`. Change that rule when
  workstream 3 lands.
- **Inbox**: nothing watches it. Replies are read only when someone runs the outreach card.

## Workstream 1: faster enrichment (do first)

The AI's back-and-forth is the bottleneck, not Hunter itself.

1. **Move enrichment out of the AI loop (recommended).** Add a dashboard server route, or a
   dashboard MCP tool such as `enrich_shops`, that takes the Maps results, starts every Hunter
   `domain-search` run on Monid at once, polls them together, and returns
   `{ domain, contact_name, contact_email, contact_role }[]`. The research seat makes one call
   and only decides which shops qualify and files them. Expect a 5–10× speedup.
2. **If it stays agent-driven:** tell the seat to start all Hunter runs without waiting, then
   collect them with `monid_get_run`. Write the endpoint shape into the prompt so it skips
   `monid_inspect` every session.
3. **Try to drop Hunter.** Run `monid discover` for a Maps or local-business endpoint that
   returns emails along with the listing. If one exists, research becomes one run instead of 1 + N.
4. **Defer `provision_demo`.** The demo link only goes to warm leads now, so research can skip
   building demos and leave that to a reply (workstream 4). This saves one tool call per shop.
   It needs the outreach or reply seat to hold `autoops.provision_demo` (BeigeElk's contract,
   tool already `allow`).

The order rule stays: people's data (Hunter results, replies) comes last in a session, because
after reading it Naïve holds outside calls for the operator. Auto-approve rules (#27, #28) can
cover that.

## Workstream 2: a research team

- Split by area. Use one research card per city or zip group. Either give each its own seat
  (`research--<area>`, same per-slug pattern as `server/proxy.ts`) or have the CEO hand several
  cards to the same seat.
- Duplicates are already safe: `create_lead` answers `already_filed` by domain.
- **Check first:** whether the platform runs cards in parallel or one after another (#25 made
  runs one-at-a-time on a clean board). If they're serialized, more seats won't help until that
  changes.
- Give each research seat a Monid spending cap. They all draw from one balance.

## Workstream 3: sending 50–100 emails every 30 minutes

- **Mechanism:** a schedule on the outreach seat (`schedules: [{ cron: "*/30 * * * *" }]`, see
  `templates/agents.ts`) or a dashboard server job. Fill in the two fixed templates in code and
  send with AgentMail `send_message`. Use the AI only for the one personal detail line, if at
  all. Log `OUTREACH SENT: <message id> to <email>` on each shop.
- **Batch rule:** pick leads with a `contact_email` and no `OUTREACH SENT` / `OUTREACH DRAFTED`
  note, cap each run at the configured batch size, and never email the same address twice.
- **The real limit is supply.** 100 per 30 minutes is ~4,800 a day. Research has to file leads
  with emails at that rate, so workstreams 1 and 2 come first.
- **Deliverability.** A new `agentmail.to` inbox sending this volume will likely be flagged as
  spam. Plan for your own sending domain, several inboxes, and a ramp-up (start around 20–30 per
  inbox per run and raise it as bounce and spam rates allow). Read AgentMail's rate limits
  before you set the batch size.
- Update `INBOX_RULE` at the same time, so the prompt and the permissions agree.

## Workstream 4: watching the inbox

1. **Webhook (preferred):** AgentMail notifies a dashboard route when a message arrives. The
   route starts an outreach session (`POST /v1/sessions`, same pattern as autoops-voice's
   call-ended event) with the thread id. Check AgentMail's docs for the exact event name.
2. **Timed check (fallback, quickest to ship):** a schedule on the outreach seat every
   5–10 minutes runs `list_threads` since the last check and handles new replies.

What a reply session does: file the reply verbatim on the shop. If the shop said yes, add
`SAID YES:` and move it to proposal. If the shop showed interest, draft a short reply with the
demo link, building the demo first if workstream 1.4 removed it from research. Never draft on a
thread the shop hasn't answered.

## Suggested order before feature freeze (7:00 am PT Nov 8)

1. Enrichment route (workstream 1.1).
2. Inbox timed check (workstream 4.2).
3. Research split, once parallel runs are confirmed (workstream 2).
4. Scheduled sending at a low batch size, ramping up (workstream 3).

## Open risks

- Sending commercial email with no opt-out line or postal address goes against CAN-SPAM. Kept
  as the operator's decision. It also tends to raise spam-flag rates.
- Volume email from one new inbox can get the inbox suspended.
- Demo calls bill Swayam's Vapi account. Keep the warm-only rule.
- `axl-roadside` and `demo-shop` stay frozen (see `AGENTS.md`).
