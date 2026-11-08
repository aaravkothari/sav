/**
 * Running the company from the dashboard: start a run, see every run's cards, pause and resume.
 *
 * A run is what `scripts/live-run.ts` used to be the only door to. It puts one card per `PIPELINE`
 * step on the CEO's board, keyed to the run and chained by `blocked_by`, then asks the CEO to hand
 * each card to its owner. Assigning a card is what wakes an agent, so this is the whole of starting
 * the company's work: everything after it runs on the board.
 *
 * Pausing is the company's off switch. The platform has no "pause an agent", so pausing interrupts
 * every session that is queued or running (an interrupted session goes idle and keeps its context)
 * and pauses every timer; the store remembers which, so resuming sends each interrupted session one
 * message to carry on and resumes those timers. While paused, `sweepPaused` interrupts anything new
 * that starts (a card finishing wakes the CEO; autoops-voice opens sessions on calls and sign-ups).
 * That sweep runs whenever the dashboard asks for the company's state, so it holds while the
 * dashboard is open, not while it is closed. The screen says so.
 */
import { PIPELINE } from "../templates/receptionist.ts";
import { collect, proxyFetch, type ProxyConfig } from "./proxy.ts";
import type { CompanyState, Store } from "./store.ts";

interface AgentRow {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
}

export interface Card {
  id: string;
  title: string;
  body: string;
  note: string | null;
  status: "todo" | "doing" | "blocked" | "done";
  assignee: string | null;
  blocked_by: string[];
  woken_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunStep {
  key: string;
  title: string;
  owner: string;
  card: Card | null;
}

export type RunState = "active" | "stopped" | "done" | "cancelled";

export interface Run {
  run: string;
  goal: string;
  created_at: string;
  steps: RunStep[];
  /**
   * `active`: a step is being worked, or is assigned and free to start. `stopped`: nothing is
   * moving and not everything is done (e.g. the test call waits for a shop to go active).
   * `done`: every card is done. `cancelled`: the operator cancelled it (`CANCELLED_NOTE`).
   */
  state: RunState;
}

/** The note a cancelled card closes with; how the dashboard tells a cancelled run from a finished one. */
export const CANCELLED_NOTE = "CANCELLED by the operator from the dashboard.";

export function runState(steps: readonly RunStep[]): RunState {
  const cards = steps.map((s) => s.card).filter((c): c is Card => c !== null);
  if (cards.some((c) => c.note?.startsWith("CANCELLED"))) return "cancelled";
  if (cards.length > 0 && cards.every((c) => c.status === "done")) return "done";
  // Working, or assigned and free to start. A blocked card waits on another; if nothing ahead of
  // it is moving, the run has stopped (the test call waits for a shop to go active).
  if (cards.some((c) => c.status === "doing" || (c.status === "todo" && c.assignee !== null))) return "active";
  return "stopped";
}

type Fetch = typeof fetch;

/** The organization's CEO: the agent `naive up` created when the config declared `tasks`. */
export async function findCeo(config: ProxyConfig, fetchImpl: Fetch = fetch): Promise<AgentRow | null | "unavailable"> {
  const agents = await collect<AgentRow>(config, "/v1/agents", fetchImpl);
  if (agents === null) return "unavailable";
  return agents.find((agent) => agent.metadata?.["role"] === "orchestrator") ?? null;
}

/** `run-YYYYMMDDHHMM`, the suffix every card of one run carries in its title. */
export const runId = (now: Date): string => `run-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;

const RUN_SUFFIX = / \((run-\d{12})\)$/;

/** A platform refusal, carried to the operator as the platform worded it (never a key: the platform never echoes one). */
export class UpstreamError extends Error {
  // Plain fields, not constructor parameter properties: `pnpm serve` runs this file with Node's
  // type stripping, which refuses parameter properties.
  readonly status: number;
  readonly step: string;
  constructor(status: number, step: string, message: string) {
    super(`${step}: the platform answered ${status}${message ? ` (${message})` : ""}`);
    this.name = "UpstreamError";
    this.status = status;
    this.step = step;
  }
}

async function json<T>(res: Response, step = "platform call"): Promise<T> {
  if (!res.ok) {
    let message = "";
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } | string };
      message = typeof body.error === "string" ? body.error : [body.error?.code, body.error?.message].filter(Boolean).join(": ");
    } catch {
      // Not JSON: the status alone says it.
    }
    throw new UpstreamError(res.status, step, message.slice(0, 300));
  }
  return (await res.json()) as T;
}

/** Cards on the CEO's board, then the CEO told to assign them. Nothing else starts work. */
export async function startRun(
  config: ProxyConfig,
  ceoId: string,
  goal: string,
  now: Date,
  fetchImpl: Fetch = fetch,
): Promise<{ run: string; session_id: string; cards: number; closed_before: number }> {
  const run = runId(now);
  const send = (method: string, path: string, body: unknown) =>
    proxyFetch(config, { method, path }, JSON.stringify(body), fetchImpl);

  // One run at a time on a clean board: every older open card is closed first, so the CEO and the
  // crew have nothing old to pick back up.
  const cleaned = await cleanBoard(config, ceoId, fetchImpl);

  const board = await json<{ id: string }>(await send("POST", "/v1/boards", { agent_id: ceoId }), "opening the CEO's board");
  const ids = new Map<string, string>();
  for (const step of PIPELINE) {
    const blockers = "blocked_by" in step ? step.blocked_by : [];
    const card = await json<{ id: string }>(await send("POST", `/v1/boards/${encodeURIComponent(board.id)}/cards`, {
      key: `${run}:${step.key}`,
      title: `${step.title} (${run})`,
      body: `Goal: ${goal}\n${step.body}\nOwner: ${step.owner}.`,
      blocked_by: blockers.map((key) => ids.get(key)!),
    }), `adding the "${step.key}" card`);
    ids.set(step.key, card.id);
  }
  const session = await json<{ id: string }>(await send("POST", "/v1/sessions", {
    agent_id: ceoId,
    message: [
      `New run ${run}. Goal: ${goal}`,
      `Read your board with board_read and assign each unassigned card whose title ends in (${run}) to its owner with board_write (op assign), and do nothing else:`,
      "Every other card on the board is closed. Do not reopen, reassign or comment on any card that is not in this run.",
      ...PIPELINE.map((step) => `- "${step.title} (${run})" → ${step.owner}`),
      'The "test-call" card belongs to the shop\'s own receptionist (booking--<shop-slug>). If no such agent exists yet, leave that card unassigned and say so.',
      "Then report which cards you assigned. You will be told as each card is done or blocked.",
    ].join("\n"),
  }), "starting the CEO");
  return { run, session_id: session.id, cards: ids.size, closed_before: cleaned.closed };
}

/** Every run on the CEO's board, newest first, each as its six steps in `PIPELINE` order. */
export function groupRuns(cards: readonly Card[]): Run[] {
  const runs = new Map<string, Run>();
  for (const card of cards) {
    const match = RUN_SUFFIX.exec(card.title);
    if (!match) continue;
    const id = match[1]!;
    const run = runs.get(id) ?? {
      run: id,
      goal: /^Goal: (.*)$/m.exec(card.body)?.[1] ?? "",
      created_at: card.created_at,
      steps: PIPELINE.map((step) => ({ key: step.key, title: step.title, owner: step.owner, card: null as Card | null })),
      state: "stopped" as RunState,
    };
    const base = card.title.slice(0, match.index);
    const step = run.steps.find((s) => s.title === base);
    if (step) step.card = card;
    if (card.created_at < run.created_at) run.created_at = card.created_at;
    runs.set(id, run);
  }
  for (const run of runs.values()) run.state = runState(run.steps);
  return [...runs.values()].sort((a, b) => b.run.localeCompare(a.run));
}

/**
 * Closes cards so nothing wakes on them again: unassigned, `done`, with `CANCELLED_NOTE`, and any
 * session a card woke is cancelled. Later steps first, so closing a step never unblocks (and wakes)
 * the one after it.
 */
async function closeCards(config: ProxyConfig, boardId: string, cards: readonly Card[], fetchImpl: Fetch): Promise<number> {
  let closed = 0;
  for (const card of [...cards].reverse()) {
    if (card.status === "done") continue;
    if (card.woken_session_id) {
      await proxyFetch(config, { method: "POST", path: `/v1/sessions/${encodeURIComponent(card.woken_session_id)}/cancel` }, "{}", fetchImpl);
    }
    const res = await proxyFetch(config, { method: "PATCH", path: `/v1/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(card.id)}` },
      JSON.stringify({ assignee: null, status: "done", note: CANCELLED_NOTE }), fetchImpl);
    if (res.ok) closed += 1;
  }
  return closed;
}

async function boardOf(config: ProxyConfig, ceoId: string, fetchImpl: Fetch): Promise<{ boardId: string; cards: Card[] }> {
  const board = await json<{ id: string }>(await proxyFetch(config, { method: "POST", path: "/v1/boards" }, JSON.stringify({ agent_id: ceoId }), fetchImpl), "opening the CEO's board");
  const cards = await collect<Card>(config, `/v1/agents/${encodeURIComponent(ceoId)}/board`, fetchImpl);
  if (cards === null) throw new UpstreamError(502, "reading the CEO's board", "");
  return { boardId: board.id, cards };
}

/** Cancels one run: its open cards closed, the sessions they woke cancelled. */
export async function cancelRun(config: ProxyConfig, ceoId: string, run: string, fetchImpl: Fetch = fetch): Promise<{ run: string; closed: number }> {
  const { boardId, cards } = await boardOf(config, ceoId, fetchImpl);
  const mine = groupRuns(cards).find((r) => r.run === run);
  if (!mine) return { run, closed: 0 };
  const ordered = mine.steps.map((s) => s.card).filter((c): c is Card => c !== null);
  return { run, closed: await closeCards(config, boardId, ordered, fetchImpl) };
}

/**
 * Closes every open card on the CEO's board: unfinished runs, the setup tasks `naive up` seeded,
 * and anything the Studio left there. A clean board is what stops a new run from waking old work.
 */
export async function cleanBoard(config: ProxyConfig, ceoId: string, fetchImpl: Fetch = fetch): Promise<{ closed: number }> {
  const { boardId, cards } = await boardOf(config, ceoId, fetchImpl);
  const runs = groupRuns(cards);
  // Run cards in pipeline order (so closeCards can close them last step first), then the rest.
  const runCards = runs.flatMap((r) => r.steps.map((s) => s.card).filter((c): c is Card => c !== null));
  const inRuns = new Set(runCards.map((c) => c.id));
  let closed = 0;
  for (const r of runs) closed += await closeCards(config, boardId, r.steps.map((s) => s.card).filter((c): c is Card => c !== null), fetchImpl);
  closed += await closeCards(config, boardId, cards.filter((c) => !inRuns.has(c.id)), fetchImpl);
  return { closed };
}

export async function listRuns(config: ProxyConfig, ceoId: string, fetchImpl: Fetch = fetch): Promise<Run[] | null> {
  const cards = await collect<Card>(config, `/v1/agents/${encodeURIComponent(ceoId)}/board`, fetchImpl);
  return cards === null ? null : groupRuns(cards);
}

/** Sessions that are doing something right now: the ones a pause has to stop. */
async function activeSessions(config: ProxyConfig, fetchImpl: Fetch): Promise<string[]> {
  const ids: string[] = [];
  for (const status of ["queued", "running"]) {
    const res = await proxyFetch(config, { method: "GET", path: `/v1/sessions?status=${status}&limit=100` }, null, fetchImpl);
    const page = await json<{ data?: { id: string }[] }>(res, "listing running sessions");
    for (const row of page.data ?? []) ids.push(row.id);
  }
  return ids;
}

async function interrupt(config: ProxyConfig, ids: readonly string[], fetchImpl: Fetch): Promise<string[]> {
  const done: string[] = [];
  for (const id of ids) {
    const res = await proxyFetch(config, { method: "POST", path: `/v1/sessions/${encodeURIComponent(id)}/interrupt` }, "{}", fetchImpl);
    if (res.ok) done.push(id);
  }
  return done;
}

/** Stops everything that is running and every timer, and remembers both. */
export async function pauseCompany(config: ProxyConfig, store: Store, now: Date, fetchImpl: Fetch = fetch): Promise<CompanyState> {
  const current = store.company();
  const stopped = await interrupt(config, await activeSessions(config, fetchImpl), fetchImpl);
  const timers = (await collect<{ id: string; status?: string }>(config, "/v1/deployments", fetchImpl)) ?? [];
  const paused: string[] = [];
  for (const timer of timers) {
    if (timer.status === "paused") continue;
    const res = await proxyFetch(config, { method: "POST", path: `/v1/deployments/${encodeURIComponent(timer.id)}/pause` }, "{}", fetchImpl);
    if (res.ok) paused.push(timer.id);
  }
  return store.setCompany({
    paused: true,
    changed_at: now.toISOString(),
    interrupted: [...new Set([...(current.paused ? current.interrupted : []), ...stopped])],
    deployments: [...new Set([...(current.paused ? current.deployments : []), ...paused])],
  });
}

/** While paused, anything that started since is interrupted too, and remembered for resume. */
export async function sweepPaused(config: ProxyConfig, store: Store, fetchImpl: Fetch = fetch): Promise<CompanyState> {
  const current = store.company();
  if (!current.paused) return current;
  const stopped = await interrupt(config, await activeSessions(config, fetchImpl), fetchImpl);
  if (stopped.length === 0) return current;
  return store.setCompany({ ...current, interrupted: [...new Set([...current.interrupted, ...stopped])] });
}

export const RESUME_MESSAGE = "The operator resumed the company. Carry on exactly where you left off.";

/** Wakes every session the pause interrupted and resumes its timers. */
export async function resumeCompany(config: ProxyConfig, store: Store, now: Date, fetchImpl: Fetch = fetch): Promise<CompanyState> {
  const current = store.company();
  for (const id of current.interrupted) {
    await proxyFetch(config, { method: "POST", path: `/v1/sessions/${encodeURIComponent(id)}/messages` },
      JSON.stringify({ message: RESUME_MESSAGE }), fetchImpl);
  }
  for (const id of current.deployments) {
    await proxyFetch(config, { method: "POST", path: `/v1/deployments/${encodeURIComponent(id)}/resume` }, "{}", fetchImpl);
  }
  return store.setCompany({ paused: false, changed_at: now.toISOString(), interrupted: [], deployments: [] });
}
