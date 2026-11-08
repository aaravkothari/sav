# SAV

**SAV** is an AI receptionist for independent auto repair shops: it answers every call, books the appointment, and tells the shop what came in. The company that sells and runs it is itself run by agents.

This is the team's monorepo (Naïve × YC hackathon).

| Folder | What it is | Owner |
| --- | --- | --- |
| [`naive-company/`](naive-company/) | The company on [Naïve](https://usenaive.ai): the agent crew (research → outreach → onboarding → receptionist → monitoring → self-improvement) coordinated by a CEO agent's board, plus the operator dashboard (CRM, approvals, per-shop workspaces) and a free local simulation. Built on Naïve's agency blueprint. | FoggyReef (Aarav) |
| [swayambshah/autoops-voice](https://github.com/swayambshah/autoops-voice) *(own repo)* | The Vapi receptionist product: voice agent, MCP server, demo page, shop portal. `naive-company/` reaches it over its MCP server. | BeigeElk (Swayam) |

Coordination, ownership and the issue board: see [`AGENTS.md`](AGENTS.md) and [`AGENT-CONVENTIONS.md`](AGENT-CONVENTIONS.md). Seed leads live in [`leads/`](leads/).

## Working here

- One branch per agent, pull requests only, and reserve files (MCP Agent Mail, project `naive-yc-hackathon`) before editing.
- Secrets never go in the repo. Each package reads its own git-ignored `.env`; see its `.env.example`.
- Start with each folder's own README. For the Naïve company: [`naive-company/README.md`](naive-company/README.md).
