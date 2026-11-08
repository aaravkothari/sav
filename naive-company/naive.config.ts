/**
 * The `agency` blueprint, declared.
 *
 * This is the file `naive up` reads. A person clones this repo, sets NAIVE_API_KEY, runs
 * `naive up`, and the platform provisions everything below into their organization: the one app
 * (public site at `/`, operator dashboard under `/app`) and the chosen template's seven agents.
 * Re-running is idempotent — resources are keyed by name.
 *
 * The blueprint is the machine and is shared: the screens, `/api/*`, `/mcp`, the store, the
 * operator bearer, the build and the approval flow do not change with the template. The template
 * is data — `templates/blank.ts` and `templates/seo-geo.ts` — and this repo carries **both**, so
 * switching is one edit in `templates/index.ts` plus `naive up`: never a re-clone, never a new app.
 *
 * Switching widens and never narrows. Agents the new template declares are created; agents only
 * the old one declared come back as `kept` and are left standing (deletion needs an explicit
 * `removed:` tombstone), and the operator's own rows — clients, posts, connections, the app, its
 * URL, its MCP token — are untouched. The per-client crew follows the same rule in
 * `server/proxy.ts`.
 *
 * The dashboard declares its MCP endpoint (`mcp: "/mcp"`), so every agent in the project is
 * offered the dashboard's CRM tools automatically on each turn — no per-agent wiring; the platform
 * mints the token and injects it into the app as `VETTA_MCP_TOKEN`.
 *
 * Standalone clones install `@usenaive-sdk/blueprints` from npm; inside the monorepo it resolves
 * via the workspace protocol.
 */
import { BLUEPRINTS, defineProject } from "@usenaive-sdk/blueprints";
import { ACTIVE_TEMPLATE, TEMPLATES } from "./templates/active.ts";
import { AGENCY_IDENTITY } from "./templates/blank.ts";
import { PROJECT, TEMPLATE } from "./templates/index.ts";
import { AGENTMAIL, AUTOOPS, MONID, PIPELINE } from "./templates/receptionist.ts";

/**
 * Every template this repo carries that the installed engine admits. `defineProject` refuses a repo
 * whose template list is not exactly its blueprint's (`BLUEPRINTS.agency.templates`), so a template
 * added here ahead of the engine — `product-design` needs `@usenaive-sdk/blueprints` 0.17.0 — is left
 * out with a warning rather than breaking every clone, test and publish on the older engine. The
 * same filter `media-blueprint`'s config has carried since its first sibling template.
 */
const carried = new Set<string>(BLUEPRINTS.agency?.templates ?? Object.keys(TEMPLATES));
const templates = Object.values(TEMPLATES).filter((one) => carried.has(one.name));
/** Said out loud, so a publish against an engine that predates a template never drops it silently. */
const skipped = Object.keys(TEMPLATES).filter((name) => !carried.has(name));
if (skipped.length > 0) {
  console.warn(`agency: the installed @usenaive-sdk/blueprints does not list ${skipped.join(", ")}; left out until an engine that lists them is installed.`);
}
if (!carried.has(TEMPLATE)) {
  throw new Error(`agency: the ${TEMPLATE} template needs @usenaive-sdk/blueprints >= 0.17.0; the installed engine lists only ${[...carried].join(", ")}.`);
}

export default defineProject({
  name: PROJECT,
  blueprint: "agency",
  /** Chosen in `templates/index.ts`, so the config, the screens and the site cannot disagree. */
  template: TEMPLATE,
  /** What the studio calls this template and says it does, and its first week on the launch card. */
  title: ACTIVE_TEMPLATE.title,
  description: ACTIVE_TEMPLATE.description,
  roadmap: ACTIVE_TEMPLATE.roadmap,
  /** Every template this repo carries that the engine lists; the chosen one's agents become this project's crew. */
  templates,
  /**
   * The ≤4 questions the studio asks before provisioning (plan §4). The answers become the project
   * context every agent reads first (`project_context`, canonical-spec §31.8); no `{ from_env }`
   * reader is needed for an answer to a declared question.
   */
  questions: ACTIVE_TEMPLATE.questions,
  /**
   * The crew the dashboard provisions per client at onboarding (`server/proxy.ts`), published so
   * the studio can show it. Names carry the client's slug at runtime, so only the shape is here.
   */
  crew_per_client: ACTIVE_TEMPLATE.crew.map(({ name, role, description }) => ({ name, role, description })),

  /**
   * The agency's persona, and the reason a connected account is reachable from an agent at all.
   *
   * Connection tools resolve `session → agent → agent_identity → identity → connected accounts`, so
   * an agent holding no identity is offered none of them — which is what every agent of this
   * blueprint was. The mailbox names in `templates/blank.ts` and the search and analytics names in
   * `templates/seo-geo.ts` were written, allow-listed and never once offered to a turn, and nothing
   * reported it: the resolver simply returned an empty list.
   *
   * Declaring the persona here and naming it on each agent (and on each schedule, which fires with
   * no operator behind it and would otherwise speak as nobody) is the grant. `up` refuses an agent
   * whose identity was not provisioned rather than creating one that runs as nobody, so a persona
   * dropped from this list fails the apply by name instead of quietly emptying every toolset.
   *
   * It is also the persona the dashboard's own connection routes act as: export its `idn_` id as
   * `NAIVE_IDENTITY_ID` and the accounts a client's Connections tab lists are exactly the accounts
   * its agents can reach.
   */
  identities: [
    {
      name: AGENCY_IDENTITY,
      description: "The agency itself — the persona its agents read, draft and connect accounts as.",
    },
  ],

  /**
   * The agency identity's credential vault: the API keys for the third-party MCP servers the crew
   * uses (AgentMail for email, Monid for lead data, autoops-voice for the receptionist). Each value is read from `.env` at apply time
   * and sealed write-once; the platform injects it as a bearer token when an agent's session
   * connects to that server URL, so no prompt, transcript or sandbox ever holds it. Rotating a key
   * is create-new, delete-old on the platform: changing `.env` and re-running `up` changes nothing.
   */
  vaults: [
    {
      name: "agency-integrations",
      identity: AGENCY_IDENTITY,
      credentials: [
        { kind: "static_bearer", key: "AgentMail", mcp_server_url: AGENTMAIL.url, value: { from_env: "AGENTMAIL_API_KEY" } },
        { kind: "static_bearer", key: "Monid", mcp_server_url: MONID.url, value: { from_env: "MONID_API_KEY" } },
        { kind: "static_bearer", key: "autoops-voice", mcp_server_url: AUTOOPS.url, value: { from_env: "AUTOOPS_VOICE_TOKEN" } },
      ],
    },
  ],

  /**
   * The company's first workflow, as cards on the CEO's board. Declaring `tasks` is what makes
   * `naive up` create the organization's CEO (the standing orchestrator), its board, and seat this
   * crew on its roster. The cards are UNASSIGNED on purpose: an assigned card starts its agent on
   * the next tick, so nothing runs (or spends) until you ask the CEO to hand them out
   * (`pnpm live:run`). Re-applying finds every card by key and leaves it alone.
   */
  tasks: PIPELINE.map(({ key, title, body, owner, ...rest }) => ({
    key,
    title,
    body: `${body}\nOwner: ${owner}.`,
    blocked_by: "blocked_by" in rest ? [...rest.blocked_by] : [],
  })),

  apps: [
    {
      name: "dashboard",
      type: "fullstack",
      description:
        "The agency's public site at / — served from the site profile the team edits — and the operator dashboard under /app: CRM pipeline, approvals, agents, per-client workspaces.",
      deploy_dir: "dist",
      mcp: "/mcp",
      /** The one app the crew files into and the site is served from; the template cannot run without it. */
      required: true,
      /**
       * The deployed dashboard calls the platform on your behalf — the agency chat, the agent
       * roster, each client's connections, and the per-client crew provisioned at onboarding — so
       * it needs the same key you run `naive up` with. `{ from_env }` reads your shell at apply
       * time, so no secret sits in this file and an unset variable refuses the apply by name. The
       * other two are literals and only when set: a base URL and an identity id are not secrets,
       * and a `{ from_env }` on an unset optional would refuse the whole apply.
       *
       * Without the key the dashboard still runs: the CRM and the deliverable queue are the app's
       * own database, so they work, and every platform-backed route answers 503 "not configured"
       * in the screen that asked for it instead of pretending.
       *
       * `DASHBOARD_TOKEN` is the operator's own bearer for `/api/*` — the CRM holds client
       * contacts and their email addresses, the roster holds system prompts, and the queue and the
       * session relay are writable, so the deployed URL cannot be open. It is `{ generate: true }`
       * (`canonical-spec §29.7`): the value is "any long random string", asking a person to invent
       * entropy was never a setup question, and a hosted install has no shell to read one out of.
       * The platform makes one, once, on the apply that creates the app, and no later apply rolls
       * it out from under the running build. It is unreadable by design — no route returns an app
       * secret — so the dashboard comes up CLOSED rather than open, and an operator who wants a
       * token they know sets their own with `POST /v1/apps/{id}/secrets`, once.
       *
       * `DASHBOARD_PASSWORD` is the one credential made to be handed to a person. Also
       * `{ generate: true }`, but for this name the platform generates a password-shaped value
       * (four groups of four, `kq7m-x2rt-8bvn-pz4h`) and keeps a copy it will show the operator
       * from the studio's Access panel (`GET /v1/apps/{id}/access`, audited) — for the browser the
       * studio cannot hand back signed in, or a colleague's. `/api/enter` trades it for the same
       * cookie a ticket earns; rotation is `POST /v1/apps/{id}/access`, never a re-apply.
       *
       * `NAIVE_API_URL` and `NAIVE_IDENTITY_ID` are deliberately NOT here. They were `process.env`
       * reads, evaluated when this declaration is BUILT — so the publisher's shell was baked into
       * the bytes every customer installs — and on a hosted apply there is no shell at all, so both
       * silently vanished and the dashboard fell back to the production base URL with no persona.
       * Declaring them with `{ from_env }` would be worse: a laptop apply would then refuse for
       * want of two variables nobody has. The platform knows both and writes them into this app
       * itself, the way it already writes `VETTA_MCP_TOKEN`.
       */
      env: {
        NAIVE_API_KEY: { from_env: "NAIVE_API_KEY" },
        DASHBOARD_TOKEN: { generate: true as const },
        DASHBOARD_PASSWORD: { generate: true as const },
        // The shop pages read each receptionist and the company inbox server-side (`server/shop-routes.ts`).
        AUTOOPS_VOICE_TOKEN: { from_env: "AUTOOPS_VOICE_TOKEN" },
        AGENTMAIL_API_KEY: { from_env: "AGENTMAIL_API_KEY" },
        // The autoops-voice tunnel as of Nov 8. Update it here (and re-apply) when the tunnel moves.
        AUTOOPS_MCP_URL: "https://loves-jewel-undergraduate-republicans.trycloudflare.com/mcp",
      },
    },
  ],

  // No `agents:` here. They are the template's — `templates/agents.ts` declares the seven every
  // agency has, `templates/seo-geo.ts` adds its focus to them, and the per-client crew
  // (`seo-writer--<slug>`, …) is provisioned at onboarding by the dashboard server, since its
  // names carry a client slug and cannot be declared statically.
});
