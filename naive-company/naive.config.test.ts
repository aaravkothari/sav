/** The committed config must load and validate through the real `naive up` loader. */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLUEPRINTS, loadConfig } from "@usenaive-sdk/blueprints";
import { TEMPLATES } from "./templates/active.ts";
import { AGENCY_IDENTITY, AGENCY_TIMEZONE } from "./templates/blank.ts";
import { PROJECT, TEMPLATE } from "./templates/index.ts";

/** Loaded once: jiti compiles the config cold, and every test below reads the same apply. */
const loaded = loadConfig(dirname(fileURLToPath(import.meta.url)));

/** What only `seo-geo` adds to the applied config; `templates/templates.test.ts` covers it directly for both. */
const SEO = TEMPLATE === "seo-geo";

/** The tools a connected account contributes to a turn — `<connector>.<tool>`, and never the dashboard's own. */
const connectionTools = (agent: { tools?: { configs: Record<string, unknown> } }) =>
  Object.keys(agent.tools?.configs ?? {}).filter((name) => name.includes(".") && !name.startsWith("dashboard."));

describe("naive.config.ts", () => {
  it("loads and validates via loadConfig", async () => {
    const result = await loaded;
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // The blueprint is the machine and the project is named for it; the template is the data that
    // fills it, and it is declared so the platform records which one was applied.
    expect(result.config.name).toBe(PROJECT);
    expect(result.config.blueprint).toBe("agency");
    expect(result.config.template).toBe(TEMPLATE);
    // What the studio prints: "runs the <title> template", and the launch card's Day 1 line.
    expect(result.config.title).toBe(TEMPLATES[TEMPLATE].title);
    expect(result.config.description).toBe(TEMPLATES[TEMPLATE].description);
    expect(result.config.roadmap).toEqual(TEMPLATES[TEMPLATE].roadmap);
    expect(result.config.agents.flatMap((a) => a.schedules ?? []).every((s) => (s.summary ?? "") !== "")).toBe(true);
    // One repo carries every template of its blueprint — that is what makes a switch an edit and
    // never a re-clone, and `defineProject` refuses a repo that carries only some.
    expect(Object.keys(TEMPLATES).sort()).toEqual(["blank", "product-design", "seo-geo"]);
    // One app: the public site at `/` and the operator UI under `/app` share a server, so the
    // site's read of its own copy (`/api/site`) is same-origin. The app is what the crew files into
    // and the operator approves on, so an install cannot leave it out.
    expect(result.config.apps.map((a) => [a.name, a.mcp, a.required])).toEqual([["dashboard", "/mcp", true]]);
    // The crew that a template with a per-client trio provisions per client, published for the studio.
    expect(result.config.crew_per_client?.map((a) => a.name)).toEqual(TEMPLATES[TEMPLATE].crew.map((a) => a.name));
    expect(result.config.questions.map((q) => q.key)).toEqual(TEMPLATES[TEMPLATE].questions.map((q) => q.key));
    // Without the key on the app itself the deployed process has none: the chat relay and the
    // per-client crew provisioning cannot work at all, and every platform route answers 503.
    expect(result.config.apps[0].env).toMatchObject({ NAIVE_API_KEY: { from_env: "NAIVE_API_KEY" } });
    // The `/api/*` gate. Required, not optional: the CRM holds client contacts and their email
    // addresses and the queue is writable, so an apply that cannot read a token must refuse rather
    // than deploy a dashboard anyone who finds the URL can read and mutate.
    // The `/api/*` gate, invented by the platform rather than by a person (`canonical-spec §29.7`):
    // "any long random string" was never a setup question, and a hosted install has no shell to
    // read one out of. Made once, on the apply that creates the app, and never rolled after.
    expect(result.config.apps[0].env).toEqual({
      NAIVE_API_KEY: { from_env: "NAIVE_API_KEY" },
      DASHBOARD_TOKEN: { generate: true },
      DASHBOARD_PASSWORD: { generate: true },
    });
    // And the platform's own two values are the platform's to write. As `process.env` reads they
    // baked the PUBLISHER'S shell into the declaration every customer installs, and vanished
    // entirely on a hosted apply, which has no shell — leaving the dashboard pointed at the
    // production base URL with no persona.
    expect(result.config.apps[0].env).not.toHaveProperty("NAIVE_API_URL");
    expect(result.config.apps[0].env).not.toHaveProperty("NAIVE_IDENTITY_ID");
    // The agents are the chosen template's, folded in by `defineProject` — the config declares none
    // of its own, so switching template is the only thing that changes this list.
    expect(result.config.agents.map((a) => a.name)).toEqual(TEMPLATES[TEMPLATE].agents.map((a) => a.name));
    expect(result.config.agents.map((a) => a.name)).toEqual(SEO
      ? ["site-builder", "sales", "client-manager", "content-writer", "content-reviser", "gap-researcher", "proposal-writer", "paid-media-planner"]
      : ["research", "sales", "client-manager", "monitoring", "self-improvement"]);
    for (const agent of result.config.agents) {
      expect(agent.system).toMatch(/never send or publish anything yourself/);
      expect(agent.tools?.default_config.permission).toBe("deny");
      // Deny-by-default drops unlisted tools, so the dashboard's MCP tools must be named to be usable
      // — and the approving ones are never named: approval is the operator's, on the screen.
      expect(Object.keys(agent.tools?.configs ?? {}).some((name) => name.startsWith("dashboard."))).toBe(true);
      expect(agent.tools?.configs).not.toHaveProperty("dashboard.approve_post");
      // Nothing publishes: the platform's own publishing tool is not granted, and the dashboard's
      // queue is where a deliverable waits instead. The README's "nothing publishes without you" is
      // this line, not a prompt.
      expect(agent.tools?.configs).not.toHaveProperty("social.post");
      expect(Object.keys(agent.tools?.configs ?? {}).filter((name) => name.startsWith("social."))).toEqual([]);
      // The agency mailbox is the persona's own inbox (`email.*`), not a connected Gmail account:
      // the platform offers these only to a turn whose identity owns an inbox, and deny-by-default
      // means they must still be named here. Reads run. Sending is `ask` in the SEO crew; in the
      // receptionist crew (blank) nothing asks permission, sending included (the operator's call).
      if (agent.name === "sales" || agent.name === "client-manager") {
        expect(agent.tools?.configs["email.inboxes"]).toEqual({ enabled: true, permission: "allow" });
        expect(agent.tools?.configs["email.read"]).toEqual({ enabled: true, permission: "allow" });
        expect(agent.tools?.configs["email.send"]).toEqual({ enabled: true, permission: SEO ? "ask" : "allow" });
        expect(agent.system).toMatch(/email\.read is not among your tools, request it with request_tools/);
      } else if (agent.name !== "paid-media-planner") {
        const measurement: Record<string, string[]> = {
          "content-writer": ["google_search_console.search_analytics_query"],
          "content-reviser": ["google_search_console.search_analytics_query", "google_analytics.run_report"],
          "gap-researcher": [
            "google_search_console.search_analytics_query", "google_search_console.list_sites",
            "google_search_console.inspect_url", "google_analytics.run_report",
          ],
        };
        // blank: research reaches Monid's catalogue; reads and paid runs both run, within the seat budget.
        const receptionist: Record<string, string[]> = {
          research: ["monid.monid_discover", "monid.monid_inspect", "monid.monid_get_run", "monid.monid_list_runs", "monid.monid_balance", "monid.monid_run", "autoops.provision_demo"],
          monitoring: ["autoops.get_receptionist", "autoops.list_calls", "autoops.get_call", "autoops.list_shops", "autoops.simulate_call"],
          "self-improvement": ["autoops.get_receptionist", "autoops.list_calls", "autoops.get_call", "autoops.list_shops", "autoops.simulate_call"],
        };
        expect([agent.name, connectionTools(agent)]).toEqual([agent.name, (SEO ? measurement[agent.name] : receptionist[agent.name]) || []]);
        if (!SEO && agent.name === "research") expect(agent.tools?.configs["monid.monid_run"]?.permission).toBe("allow");
      }
      expect(Object.keys(agent.tools?.configs ?? {}).filter((name) => name.startsWith("gmail."))).toEqual([]);
      // The sanctioned way to ask for a tool it lacks. `ask_operator` cannot be `allow` (the tool is
      // the pause), so it is `ask`; a prompt that says "ask the operator" without it is a dead letter.
      expect(agent.tools?.configs["ask_operator"]).toEqual({ enabled: true, permission: "ask" });
      // And the sanctioned way to be GRANTED one: `request_tools` parks a toolset change on the same
      // screen, and approving it changes what this agent holds (canonical-spec §7.4). `ask` in the SEO
      // crew; the receptionist crew asks no permission, so there it is `allow`.
      expect(agent.tools?.configs["request_tools"]).toEqual({ enabled: true, permission: SEO ? "ask" : "allow" });
      expect(agent.system).toMatch(/complete list of what you can do right now/);
      expect(agent.system).toMatch(/request it once with request_tools/);
    }
    const byName = Object.fromEntries(result.config.agents.map((a) => [a.name, a]));
    if (SEO) {
      // The daily pass files follow-ups on the client row, so the sales agent must hold the tool that does.
      expect(byName["sales"]?.tools?.configs).toHaveProperty("dashboard.create_lead");
      expect(byName["sales"]?.tools?.configs).toHaveProperty("dashboard.add_client_note");
      expect(byName["sales"]?.schedules?.map((s) => s.cron)).toEqual(["30 8 * * 1-5"]);
      expect(byName["client-manager"]?.tools?.configs).toHaveProperty("dashboard.get_calendar");
      expect(byName["client-manager"]?.schedules?.map((s) => s.cron)).toEqual(["0 8 * * 1"]);
      // The site is edited through the store and only through approval.
      expect(byName["site-builder"]?.tools?.configs["dashboard.get_site"]).toEqual({ enabled: true, permission: "allow" });
      expect(byName["site-builder"]?.tools?.configs["dashboard.update_site"]).toEqual({ enabled: true, permission: "ask" });
    } else {
      // The receptionist crew is all placeholders: the apply opens no session and arms no timer.
      for (const agent of result.config.agents) expect([agent.name, agent.intake, agent.schedules]).toEqual([agent.name, undefined, []]);
      // The CEO's board is seeded with the pipeline, every card unassigned, so nothing starts on its own.
      expect(result.config.tasks.map((t) => t.key)).toEqual(["research", "outreach", "onboarding", "test-call", "monitoring", "self-improvement"]);
      expect(result.config.tasks.every((t) => t.assignee === undefined)).toBe(true);
    }
    // `blank` and `seo-geo` declare the same seven, so between them a switch narrows nothing. What
    // `kept` holds is every seat only a sibling template declares — on an engine that lists
    // `product-design`, its four studio seats: a switch away from the studio leaves them standing
    // rather than deleting them. On an engine that does not list it, nothing. The per-client crew is
    // `server/proxy.ts`'s, because its names carry a client slug and cannot be declared statically.
    const listed = BLUEPRINTS.agency?.templates ?? [];
    const mine = new Set(TEMPLATES[TEMPLATE].agents.map((a) => a.name));
    const siblingsOnly = [...new Set(Object.values(TEMPLATES)
      .filter((t) => listed.includes(t.name) && t.name !== TEMPLATE)
      .flatMap((t) => t.agents.map((a) => a.name)))].filter((name) => !mine.has(name));
    expect(result.config.kept.agents).toEqual(siblingsOnly);
    // Pinned for seo-geo: blank also keeps seo-geo's paid-media planner, so its list differs.
    if (TEMPLATE === "seo-geo") {
      expect(siblingsOnly).toEqual(listed.includes("product-design") ? ["account-manager", "designer", "engineer", "visualizer"] : []);
    }
    // jiti compiles the config cold on a fresh CI runner; the default 5s is not enough.
  }, 30_000);
});

/**
 * The persona, read out of the applied config rather than the template module — this is what `naive
 * up` provisions, and the loader is where a persona named but not declared is refused.
 *
 * Deleting the `identities:` block does not weaken these assertions, it fails the load: an agent
 * naming an undeclared identity is a define-time refusal. Deleting the block *and* every
 * `identity:` on the agents loads cleanly and fails here instead — which is the state this
 * blueprint shipped in, and the reason a fully-written mailbox allow-list reached nothing.
 */
describe("the agency persona", () => {
  it("is declared once, and held by every agent that names a connector tool", async () => {
    const result = await loaded;
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.config.identities.map((one) => one.name)).toEqual([AGENCY_IDENTITY]);
    for (const agent of result.config.agents) {
      // Every agent of this blueprint speaks as the agency, so every one holds the persona:
      // connection tools resolve `session → agent → identity → connected accounts`, and an agent
      // holding none is offered none of the mailbox names however they are permissioned.
      expect([agent.name, agent.identity]).toEqual([agent.name, AGENCY_IDENTITY]);
    }
    expect(result.config.agents.filter((agent) => connectionTools(agent).length > 0).map((a) => a.name)).toEqual([
      ...(SEO ? [] : ["research"]), "sales", "client-manager", ...(SEO ? ["content-writer", "content-reviser", "gap-researcher", "paid-media-planner"] : ["monitoring", "self-improvement"]),
    ]);
  }, 30_000);

  it("speaks for every scheduled fire, in a zone the platform will accept", async () => {
    const result = await loaded;
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const schedules = result.config.agents.flatMap((agent) =>
      (agent.schedules ?? []).map((schedule) => [agent.name, schedule] as const));
    // The receptionist crew declares no timers yet; every one it adds is held to the rule below.
    for (const [agent, schedule] of schedules) {
      const at = `${agent} @ ${schedule.cron}`;
      // A fire has no operator behind it, so an identity-less deployment runs as nobody and
      // resolves no connected account — the same bug as an identity-less agent, by another road.
      expect([at, schedule.identity]).toEqual([at, AGENCY_IDENTITY]);
      // `POST /v1/deployments` defaults an absent `timezone` to UTC, which the operator never
      // chose: 08:00 in the declaration is then 08:00 nowhere in particular.
      expect([at, schedule.timezone]).toEqual([at, AGENCY_TIMEZONE]);
      // And the zone must be one the API's own `assertTimezone` accepts — it validates through
      // `Intl`, so a typo'd zone is a deployment that cannot be scheduled at all.
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone })).not.toThrow();
    }
  }, 30_000);
});

/**
 * `product-design` is carried ahead of the engine that lists it (`@usenaive-sdk/blueprints` 0.17.0):
 * `defineProject` refuses a repo whose list is not exactly the engine's, so the config filters to the
 * installed engine's list and says what it left out. On the committed engine (0.11.4) it is skipped
 * with a warning and choosing it is a clear error; on 0.17.0 it is carried and installs its four.
 */
describe("the installed engine's template list", () => {
  const listed = BLUEPRINTS.agency?.templates ?? [];
  const original = process.env["NAIVE_TEMPLATE"];
  afterEach(() => {
    if (original === undefined) delete process.env["NAIVE_TEMPLATE"];
    else process.env["NAIVE_TEMPLATE"] = original;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("carries product-design exactly when the engine lists it, and says so out loud when it does not", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await import("./naive.config.ts");
    const said = warn.mock.calls.map((call) => String(call[0])).join("\n");
    if (listed.includes("product-design")) expect(said).not.toMatch(/does not list/);
    else expect(said).toMatch(/does not list product-design; left out until an engine that lists them is installed/);
  }, 30_000);

  it("installs the studio of four on an engine that lists it, and refuses by name on one that does not", async () => {
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env["NAIVE_TEMPLATE"] = "product-design";
    const load = import("./naive.config.ts");
    if (listed.includes("product-design")) {
      const config = (await load).default;
      expect(config.template).toBe("product-design");
      expect(config.agents.map((a) => a.name)).toEqual(["account-manager", "designer", "engineer", "visualizer"]);
      expect(config.questions.map((q) => q.key)).toEqual(["products", "audience", "manufacturable", "done"]);
      expect(config.crew_per_client ?? []).toEqual([]);
    } else {
      await expect(load).rejects.toThrow(/product-design template needs @usenaive-sdk\/blueprints >= 0\.16\.0/);
    }
  }, 30_000);
});
