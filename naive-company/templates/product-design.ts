/**
 * `product-design` — the agency machine run as a studio for physical products.
 *
 * It is NOT a delta on `blank` the way `seo-geo` is. A product studio does not need a site writer,
 * a sales seat or a content calendar; it needs four seats that turn a brief into files:
 *
 *   * `account-manager` — the studio lead. Day one it writes the STUDIO NOTE from the four setup
 *     answers, before any other seat makes anything, then hands ONE first brief to the designer.
 *     Every later brief is read against that note and routed: millimetres to the engineer, a look to
 *     the designer, a video to the visualizer once the look or part exists.
 *   * `designer` — one `generate_3d_model` per look (a textured GLB, no units). Never `build_3d`.
 *   * `engineer` — `build_3d` with `engine: "cad"`, only for a brief that names millimetres, and only
 *     a watertight solid within 0.5 mm of the brief is filed. Never `generate_3d_model`.
 *   * `visualizer` — one studio still per look, rendered from the GLB itself with `build_3d`
 *     (`engine: "blender"`), so the still is the mesh being filed and never a text-to-image guess;
 *     the product video only when the brief asks (`generate_video` stays at `ask`).
 *
 * Every file is filed as ONE pending deliverable on the `studio` channel with its `fil_` ids
 * (`create_draft_post`'s `files`), which the dashboard's Studio screen shows and the operator
 * approves. Approving a studio deliverable posts nothing anywhere (`server/routes.ts`); nothing here
 * holds an outward tool at `allow`.
 *
 * The machinery — model, budget, deny-by-default `tools()`, `crm()`, the persona, the timer helper,
 * the gate every prompt carries — is `templates/agents.ts`'s, shared with the other two templates.
 */
import type { AgentDecl } from "@usenaive-sdk/blueprints";
import type { Client } from "../seed/clients.ts";
import type { Post } from "../seed/posts.ts";
import {
  AGENCY_IDENTITY, budget, CONTEXT, crm, DAY_ONE, gate, HANDOFF, MAILBOX_READ, MAILBOX_SEND, model, OPERATOR, OWN_RECORD, PREAMBLE,
  timer, tools, type AgencyTemplate,
} from "./blank.ts";
import { VOCABULARY } from "./index.ts";

/** The catalogue skill every seat reads first: which file a brief is allowed to ask for. */
export const PRODUCT_SKILL = "naive/product-design";

/** Where the four answers are written, and what every seat reads before it makes anything. */
export const STUDIO_NOTE = "STUDIO NOTE";

const system = (role: string): string => `${PREAMBLE} ${gate} ${OWN_RECORD} ${role}`;

/**
 * How a seat finds the note: it is a note on the agency's own CRM record, never a file and never
 * a guess.
 */
const READ_NOTE =
  `First, every session, even when the message names a cli_ id: read the note titled ${STUDIO_NOTE} on the agency's own record (list_clients, get_client). ` +
  "If there is none yet, make nothing and stop.";

/** How a seat files a file: one pending deliverable on the studio channel, carrying its `fil_` ids. */
const FILE_IT =
  "File it with create_draft_post on the brief's client: channel studio, scheduled_for today (YYYY-MM-DD), files the fil_ ids, body what was asked and what came back.";

const accountManager: AgentDecl = {
  name: "account-manager",
  role: "Studio lead",
  model,
  budget,
  description:
    "Runs the studio: writes the studio note from your four answers on day one, then reads every brief against it and routes it to the designer, the engineer or the visualizer. Never emails a client before you approve the work.",
  system: system(
    `You are the account manager and studio lead. Read every brief against the ${STUDIO_NOTE} on the agency's own record before routing it. ` +
      "A brief that names sizes in millimetres is a part: hand it to engineer. Any other object brief is a look: hand it to designer. A product video goes to visualizer only once its look or part exists. " +
      "A client not yet on the CRM: create_lead with the domain or contact_email the brief gives — a name alone files the agency's own record — and with neither, ask_operator once for one; never invent one. " +
      "Hand off with send_to_agent, wait false, one brief per session, naming the client's cli_ id, the brief in the operator's words and what done means. " +
      "A brief that contradicts the note stops: ask_operator once, then wait. " +
      "Never email a client before the deliverable is approved.",
  ),
  tools: tools(
    [...CONTEXT, "web_fetch", ...crm("list_clients", "get_client", "create_lead", "add_client_note", "list_posts", "schedule_post"), ...MAILBOX_READ, ...HANDOFF],
    [...MAILBOX_SEND, ...OPERATOR],
  ),
  handoffs: ["designer", "engineer", "visualizer"],
  skills: [PRODUCT_SKILL, "naive/client-onboarding"],
  identity: AGENCY_IDENTITY,
  schedules: [
    timer(
      "0 9 * * 1",
      "Studio check-in",
      `Read project_context and the ${STUDIO_NOTE}. List every pending studio deliverable (list_posts for each active client and the agency's own record) and note on each client any brief that has waited more than three days with no file, with what it waits on. Propose nothing outward, make nothing, and send nothing.`,
      5_000_000,
    ),
  ],
  intake: {
    message:
      `Read project_context. Before any other tool: write the ${STUDIO_NOTE} — the four answers in the operator's words, then one line each: what counts as a look, what counts as a part, what done means here — as a note titled ${STUDIO_NOTE} on the agency's own record (list_clients; create it with create_lead from the project name if missing). ` +
      "A missing answer: ask_operator once after the note is filed. " +
      "Then hand ONE first brief to designer (send_to_agent, wait false): the product the answers name, as a look, or the skill's pour-over carafe brief if they name none — the message names the agency record's cli_ id, the brief and what done means.",
    budget_micro_usd: DAY_ONE,
  },
};

const designer: AgentDecl = {
  name: "designer",
  role: "Concept meshes",
  model,
  budget,
  description:
    "Turns a look brief into one textured 3D concept mesh. Hands the mesh to the visualizer for a studio still; it never claims units or sizes.",
  system: system(
    `You are the designer: concept meshes for looks. ${READ_NOTE} ` +
      "The message names the client's cli_ id and the brief. Make ONE generate_3d_model per brief from the brief and the note, texture true, no logo or text. " +
      "It runs as a job: end the turn and wait for the GLB; never poll, never start a second. On failure retry once, then ask_operator. " +
      "Then send_to_agent visualizer, wait false: the cli_ id, the GLB fil_ id and the brief: the visualizer renders the GLB itself. " +
      "A mesh has no units: never claim a size or that it can be manufactured. Never call build_3d, not even for the mesh clean-up naive/3d-modeling describes: file the GLB as it comes.",
  ),
  tools: tools(
    [...CONTEXT, "generate_3d_model", "view_image", "fetch_file", "publish_file", ...crm("list_clients", "get_client", "list_posts", "add_client_note"), ...HANDOFF],
    OPERATOR,
  ),
  handoffs: ["visualizer"],
  skills: [PRODUCT_SKILL, "naive/3d-modeling"],
  identity: AGENCY_IDENTITY,
  schedules: [],
};

const engineer: AgentDecl = {
  name: "engineer",
  role: "Dimensioned parts",
  model,
  budget,
  description:
    "Builds a part to the millimetres a brief names, checks it is a watertight solid of the right size, and files STEP and STL for your approval. Works only on briefs that give sizes.",
  system: system(
    `You are the engineer: dimensioned parts. ${READ_NOTE} ` +
      "The message names the client's cli_ id and a brief in millimetres. Call build_3d ONCE with engine cad and render iso: it already exports STEP and STL, so never call it again just to export. " +
      "Accept it only when watertight is true and every bbox_mm edge is within 0.5 mm of the brief; else one correction pass, then file nothing; add_client_note STOPPED with both sizes. " +
      `${FILE_IT} Kind part, files the STEP, the STL and the preview; the summary carries bbox_mm and volume_cm3. ` +
      "For a video, send_to_agent visualizer, wait false, with the cli_ id and preview fil_. Never call generate_3d_model.",
  ),
  tools: tools(
    [...CONTEXT, "build_3d", "view_image", "fetch_file", "publish_file", ...crm("list_clients", "get_client", "list_posts", "create_draft_post", "add_client_note"), ...HANDOFF],
    OPERATOR,
  ),
  handoffs: ["visualizer"],
  skills: [PRODUCT_SKILL, "naive/cad-parts"],
  identity: AGENCY_IDENTITY,
  schedules: [],
};

const visualizer: AgentDecl = {
  name: "visualizer",
  role: "Stills & video",
  model,
  budget,
  description:
    "Makes one studio still for each look and files the mesh and still together for your approval. Makes a product video only when the brief asks, and only after you approve the call.",
  system: system(
    `You are the visualizer. ${READ_NOTE} ` +
      "The message names the client's cli_ id, the brief and the GLB or preview fil_ id. The still is a render of THAT mesh, never a picture drawn from the brief's words: " +
      "fetch_file the GLB, then ONE build_3d call — engine blender, render false, publish false, timeout_s 300 — whose script imports it (bpy.ops.import_scene.gltf), frames it three-quarter under the skill's studio lights on light grey, and renders with Cycles (device CPU, 32 samples, denoise; never EEVEE) at 1024x1024 to still.png in the GLB's folder; publish_file that still.png, view_image it; a cut-off mesh gets one corrected render. " +
      `${FILE_IT} For a look: ONE pending deliverable, kind concept, files the GLB then the still. ` +
      "A product video only when the brief asks: generate_video from the still, filed as kind product-video. " +
      "Skip the skill's turntable step.",
  ),
  tools: tools(
    [...CONTEXT, "build_3d", "view_image", "fetch_file", "publish_file", ...crm("list_clients", "get_client", "list_posts", "create_draft_post", "add_client_note")],
    ["generate_video", ...OPERATOR],
  ),
  handoffs: false,
  skills: [PRODUCT_SKILL, "naive/product-video-3d"],
  identity: AGENCY_IDENTITY,
  schedules: [],
};

/** The four, in the order the studio lists them. */
export const studio: AgentDecl[] = [accountManager, designer, engineer, visualizer];

/**
 * The four studio questions ARE the setup questions (engine cap: four). The account manager's
 * intake turns them into the studio note; nobody makes a file before it exists.
 */
export const studioQuestions: AgencyTemplate["questions"] = [
  {
    key: "products",
    type: "text",
    label: "What physical products does this studio design?",
    help: "The account manager writes it into the studio note on day one, and the designer's first look is one of these.",
    placeholder: "Kitchen and desk objects: carafes, lamps, small brackets.",
  },
  {
    key: "audience",
    type: "text",
    label: "Who is the work for?",
    help: "The account manager reads every brief against it; the visualizer styles stills for these buyers.",
    placeholder: "Independent homeware brands.",
  },
  {
    key: "manufacturable",
    type: "text",
    label: "Which materials, sizes and features must be manufacturable, and which are looks only?",
    help: "Decides which seat a brief goes to: the engineer builds parts to millimetres, the designer makes looks with no units.",
    placeholder: "Brackets and mounts to millimetre tolerances; carafes and lamps are looks only.",
  },
  {
    key: "done",
    type: "text",
    label: "What does done mean for a typical brief — a concept mesh, studio renders, dimensioned parts, or a short product video?",
    help: "The account manager writes it into the studio note; the visualizer makes a product video only when this or the brief asks.",
    placeholder: "A concept mesh and one studio still; a dimensioned part when the brief gives millimetres.",
  },
];

const clients: Client[] = [
  {
    id: "cli_pd01", slug: "demo-homeware", name: "Demo Homeware Co", domain: "demo-homeware.example", stage: "active",
    services: ["Concept", "Visuals"],
    contact: { name: "Sample Contact", email: "contact@demo-homeware.example", role: "Founder" },
    notes: ["Demo row — replace it with a client of your own.", "Wants a concept and one studio still per product."],
    nextAction: "Approve the carafe concept on Studio",
  },
  {
    id: "cli_pd02", slug: "demo-fixtures", name: "Demo Fixtures", domain: "demo-fixtures.example", stage: "active",
    services: ["Engineering"],
    contact: { name: "Sample Contact", email: "contact@demo-fixtures.example", role: "Product lead" },
    notes: ["Demo row — replace it with a client of your own.", "Briefs give sizes in millimetres."],
    nextAction: "Review the bracket part",
  },
  {
    id: "cli_pd03", slug: "demo-lighting", name: "Demo Lighting", domain: "demo-lighting.example", stage: "lead",
    services: [],
    contact: { name: "Sample Contact", email: "contact@demo-lighting.example", role: "Design director" },
    notes: ["Demo row — inbound from the site's contact form."],
    nextAction: "Ask for a first brief",
  },
];

// No `files` on a demo row: a seeded `fil_` id would be a file that does not exist in the operator's
// organization, and the Studio screen would show it as a broken image.
const posts: Post[] = [
  { id: "post_pd101", clientId: "cli_pd01", title: "Pour-over carafe — concept", summary: "Demo row — a sand ceramic carafe with a walnut lid, mesh and one still.", kind: "concept", channel: "studio", status: "pending", agent: "visualizer", scheduledFor: "2025-03-04", hue: 35 },
  { id: "post_pd102", clientId: "cli_pd01", title: "Desk lamp — studio still", summary: "Demo row — brushed aluminium on a seamless grey background.", kind: "still", channel: "studio", status: "approved", agent: "visualizer", scheduledFor: "2025-03-06", hue: 210 },
  { id: "post_pd201", clientId: "cli_pd02", title: "Rod bracket — 60 × 40 × 5 mm base", summary: "Demo row — STEP + STL, watertight, bbox within 0.5 mm.", kind: "part", channel: "studio", status: "pending", agent: "engineer", scheduledFor: "2025-03-05", hue: 160 },
  { id: "post_pd202", clientId: "cli_pd02", title: "Bracket turntable", summary: "Demo row — rejected so you can see what that looks like.", kind: "product-video", channel: "studio", status: "rejected", agent: "visualizer", scheduledFor: "2025-03-10", rejectedReason: "Demo row — rejected so you can see what that looks like.", hue: 0 },
];

export const productDesign: AgencyTemplate = {
  name: "product-design",
  title: "Product design studio",
  description: VOCABULARY["product-design"].description,
  roadmap: { day_one: "Write the studio note and make the first concept look" },
  kinds: VOCABULARY["product-design"].kinds,
  words: { ...VOCABULARY["product-design"].words },
  seed: { clients, posts },
  questions: studioQuestions,
  crew: [],
  agents: studio,
};
