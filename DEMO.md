# SAV stage demo: run-of-show

Issue: aaravkothari/sav#8. Judging Sunday Nov 8. Build freeze 7:00 am PT. Rehearsal 5:00 am PT.

One line: SAV builds an auto shop's AI receptionist from its public footprint before we ever
contact the shop, then an agent company on Naive sells it and runs it.

## Cast

| Who | Seat on stage | Screen |
|---|---|---|
| Vedant | Talks. Holds the speaker phone for the judge. | None |
| Aarav | Drives the Naive side | Laptop A: dashboard `/app`, Naive Studio board |
| Swayam | Drives autoops-voice | Laptop B: MCP client, demo page, owner portal |

Projector shows Laptop A by default. Swayam's screen goes up only for the call slip.

## Run-of-show (3:00)

| Time | Beat | Who | Action | Line or screen |
|---|---|---|---|---|
| 0:00 | Hook | Vedant | Talk | "Yesterday we called 10 Bay Area shops. 9 put us on hold." |
| 0:15 | Hook | Vedant | Talk | "A missed call is a lost repair job. Shops will not set up software to fix it." |
| 0:25 | Ask judge | Vedant | Hand judge a card | "Name any independent Bay Area repair shop." |
| 0:30 | Trigger | Aarav | Step L1 | Board shows the research card assigned |
| 0:35 | Narrate | Vedant | Talk over | "So we build it first. Then we email: call this number." |
| 0:45 | Approve | Aarav | Step L2 | Approvals screen: the Monid run, approve it on screen |
| 1:00 | Provision | Swayam | Step L3 | Demo page for the judge's shop |
| 1:10 | Call | Vedant | Step L4 | Judge dials on speaker, asks for a brake job quote and a slot |
| 1:45 | Slip | Swayam | Step L5 | Portal shows the call slip |
| 1:55 | Slip | Aarav | Step L6 | Shop's CRM record shows RESEARCH and RECEPTIONIST notes |
| 2:05 | Runs itself | Aarav | Step R1 | CEO board: 6 cards, owners, done and blocked |
| 2:15 | Runs itself | Aarav | Step R2 | Approvals: outreach draft with the demo link, waiting on a human |
| 2:25 | Traction | Vedant | Talk | 10 cold calls, 1 warm lead, AXL Roadside has a preview receptionist |
| 2:45 | Ask | Vedant | Talk | The ask (see below) |
| 3:00 | End | All | Stop | |

The research and provisioning run in the background from 0:30. The narration from 0:35 to 1:00
is padding that covers the wait. If the shop is not ready at 1:05, switch (see Fallbacks).

## Steps

| Step | Who | Exact action |
|---|---|---|
| L1 | Aarav | `cd naive-company && pnpm live:run --confirm-spend "Research and prebuild <SHOP>, <CITY>"` (see Q1) |
| L2 | Aarav | `/app/approvals`, approve the `monid.monid_run` for the judge's shop |
| L3 | Swayam | `provision_receptionist` with ShopInput from the RESEARCH note, `kind: "repair"`, `demo: true`, `attach_phone_number: true` (see Q3, Q4) |
| L4 | Vedant | Read the number aloud from the demo page. Judge dials on speaker. |
| L5 | Swayam | Refresh the owner portal (`portal_url`), wait for the slip, under 60 s |
| L6 | Aarav | `/app/crm`, open the shop, show its notes |
| R1 | Aarav | Naive Studio, CEO board, or `pnpm naive board show <ceo id>` |
| R2 | Aarav | `/app/approvals`, open the sales draft, do not send |

Suggested call script for the judge: "Hi, how much is a brake pad job on a 2018 Civic, and can
I bring it in tomorrow morning?" The demo receptionist should say it is a preview, not quote a
firm price, and offer to take details. That is the correct behavior, so call it out.

## The ask

| Item | Line |
|---|---|
| Who we want | 10 shop owners willing to take a free preview number this month |
| What we want | Intros to independent shop owners and roadside operators |
| Why now | The crew can prebuild 100 shops a day, the bottleneck is honest outreach |

Team to confirm the ask (Q8).

## Fallbacks

| Live step | Fallback | Trigger to switch | Who calls it |
|---|---|---|---|
| L1 research | Pre-researched shop already in CRM | No research note by 0:55 | Aarav |
| L2 approval | Show a pre-approved Monid run | Approvals screen empty or errors | Aarav |
| L3 provision | Pre-provisioned shop (see pre-flight) | No demo_url by 1:05 | Swayam |
| L4 call | Recorded call, played from Laptop B | No answer after 3 rings, or tunnel down | Vedant |
| L4 call | `simulate_call` text transcript on screen | Recording fails too | Swayam |
| L5 slip | Screenshot of a slip from rehearsal | No slip by 1:50 | Swayam |
| L6 CRM | Screenshot of the CRM record | Dashboard gate or load error | Aarav |
| R1 board | Screenshot of the board | Studio slow or logged out | Aarav |
| R2 approvals | Screenshot of the draft | Screen empty | Aarav |
| Whole demo | 3:00 screen recording of rehearsal | Wifi down at start | Aarav |

Line for any switch: "Here is the same flow from this morning." Say it once and move on. Never
pretend a fallback is live.

## Human touches (say these out loud if asked)

| # | Where | Human | Live today? |
|---|---|---|---|
| 1 | Vedant cold-called all 10 shops himself | Vedant | Yes |
| 2 | Approve each Monid run (spends balance) | Aarav | Yes, on stage |
| 3 | Approve each Hunter email lookup (Monid run) | Aarav | Yes |
| 4 | Approve AgentMail inbox creation | Aarav | Yes |
| 5 | Review and send each outreach draft | Aarav | Yes |
| 6 | Add CAN-SPAM footer before any send | Aarav | Yes, footer is empty in code |
| 7 | Write the OPERATOR CALLED note after a real call | Vedant | Yes |
| 8 | Move a shop to proposal when it says yes | Aarav | Yes |
| 9 | Review and send onboarding questions | Aarav | Yes |
| 10 | Move a shop to active (creates its booking agent) | Aarav | Yes |
| 11 | Approve any billable Vapi number | Aarav or Swayam | Yes |
| 12 | Provision the receptionist (until #4, #5 merge) | Swayam | Yes, on stage |
| 13 | Trigger the run (`live:run`) | Aarav | Yes, on stage |
| 14 | AXL Roadside callback with the preview number | Vedant | Pending |
| 15 | Approve any change self-improvement proposes | Aarav | Not built (#6) |

Honest framing for judges: the crew does the research, the profile, the receptionist build and
the drafting. Humans approve spend, every outbound message, and every stage change a customer
would feel. Monitoring and self-improvement are placeholders today. Do not claim otherwise.

## Pre-flight, 5:00 am

| # | Check | Who | Done |
|---|---|---|---|
| 1 | autoops-voice on a stable URL, not a quick tunnel (#7) | Swayam | |
| 2 | MCP bearer token in Naive vault, crew sees voice tools (#5) | Aarav | |
| 3 | Prebuilt step merged, or Swayam provisions by hand (#4) | Aarav | |
| 4 | Dashboard opens from Studio, cookie fresh, on both laptops | Aarav | |
| 5 | Naive credits and Monid balance cover 3 full runs | Aarav | |
| 6 | Pre-provisioned fallback shop: CRM record, notes, demo_url, number | Swayam | |
| 7 | Fallback number answers on speaker, slip lands in under 60 s | Vedant | |
| 8 | Full run timed end to end, twice, on venue wifi | All | |
| 9 | Recorded call (audio) on Laptop B, volume tested | Swayam | |
| 10 | Screenshots: slip, CRM record, board, approvals draft | Aarav | |
| 11 | 3:00 screen recording of the best rehearsal | Aarav | |
| 12 | Speaker phone charged, on the free Vapi number list | Vedant | |
| 13 | 3 backup shop names ready if the judge freezes | Vedant | |
| 14 | No outreach sends queued anywhere (approvals clean) | Aarav | |
| 15 | Phone hotspot ready as wifi backup | Swayam | |
| 16 | Build freeze at 7:00 am, no deploys after | All | |

Backup shop names for item 13 (all in our call log, all real): Meissner Automotive (Palo Alto),
Stress-Free Auto Care (Mountain View), De Anza Auto Repair (Sunnyvale).

## Open questions

Items marked GUESS are places where this script assumes how the product works.

| # | Question | Owner |
|---|---|---|
| Q1 | GUESS. `live:run` creates all 6 cards and the research prompt searches by keyword and city, not by shop name. Is there a faster trigger for one named shop (a single research session)? | Aarav |
| Q2 | How long does research take for one shop, end to end, including the approval? If over 30 s, start it before the hook. | Aarav |
| Q3 | GUESS. Does the crew call `provision_receptionist` itself by demo time (#4, #5), or does Swayam? | Aarav, Swayam |
| Q4 | `attach_phone_number` is billable. Is the free Vapi number re-pointed to the judge's shop, or do we approve one paid number? | Swayam |
| Q5 | GUESS. Does a call slip appear in the Naive dashboard at all, or only in the owner portal? Monitoring is a placeholder, so nothing writes calls to the CRM today. | Aarav, Swayam |
| Q6 | GUESS. The CEO board lives in Naive Studio, not in `/app`. Can it be shown in the dashboard, or do we switch tabs? | Aarav |
| Q7 | Does the demo receptionist say it is a preview on the very first line? Judges will notice. | Swayam |
| Q8 | What is the ask: shop intros, pilot users, or funding? | All |
| Q9 | Can we say AXL Roadside's name on stage, and has Vedant called them back? | Vedant |
| Q10 | AXL is a roadside service. Is its receptionist `kind: "towing"`, and is it shown or only mentioned? | Swayam |
