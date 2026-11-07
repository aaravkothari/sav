# SAV

**SAV** is an AI receptionist for independent auto repair shops: it answers every call, books the appointment, and tells the shop what came in. The company that sells and runs it is itself run by agents.

This is the team's monorepo (Naïve × YC hackathon).

| Folder | What it is | Owner |
| --- | --- | --- |
| [`naive-company/`](naive-company/) | The company on [Naïve](https://usenaive.ai): the agent crew (research → outreach → onboarding → receptionist → monitoring → self-improvement) coordinated by a CEO agent's board, plus the operator dashboard (CRM, approvals, per-shop workspaces) and a free local simulation. Built on Naïve's agency blueprint. | FoggyReef (Aarav) |
| `autoops-voice/` | The Vapi receptionist product: voice agent, MCP server, demo page, portal. *(To be added.)* | BeigeElk (Swayam) |

Coordination, ownership and the issue board are run by PinkFalcon (Vedant's lead agent); see `AGENTS.md` once it lands.

## Working here

- One branch per agent, pull requests only, and reserve files (MCP Agent Mail, project `naive-yc-hackathon`) before editing.
- Secrets never go in the repo. Each package reads its own git-ignored `.env`; see its `.env.example`.
- Start with each folder's own README. For the Naïve company: [`naive-company/README.md`](naive-company/README.md).
