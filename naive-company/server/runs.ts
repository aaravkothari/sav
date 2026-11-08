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

export interface Run {
  run: string;
  goal: string;
  created_at: string;
  steps: RunStep[];
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

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return (await res.json()) as T;
}

/** Cards on the CEO's board, then the CEO told to assign them. Nothing else starts work. */
export async function startRun(
  config: ProxyConfig,
  ceoId: string,
  goal: string,
  now: Date,
  fetchImpl: Fetch = fetch,
): Promise<{ run: string; session_id: string; cards: number }> {
  const run = runId(now);
  const send = (method: string, path: string, body: unknown) =>
    proxyFetch(config, { method, path }, JSON.stringify(body), fetchImpl);

  const board = await json<{ id: string }>(await send("POST", "/v1/boards", { agent_id: ceoId }));
  const ids = new Map<string, string>();
  for (const step of PIPELINE) {
    const blockers = "blocked_by" in step ? step.blocked_by : [];
    const card = await json<{ id: string }>(await send("POST", `/v1/boards/${encodeURIComponent(board.id)}/cards`, {
      key: `${run}:${step.key}`,
      title: `${step.title} (${run})`,
      body: `Goal: ${goal}\n${step.body}\nOwner: ${step.owner}.`,
      blocked_by: blockers.map((key) => ids.get(key)!),
    }));
    ids.set(step.key, card.id);
  }
  const session = await json<{ id: string }>(await send("POST", "/v1/sessions", {
    agent_id: ceoId,
    message: [
      `New run ${run}. Goal: ${goal}`,
      `Read your board with board_read and assign each unassigned card whose title ends in (${run}) to its owner with board_write (op assign), and do nothing else:`,
      ...PIPELINE.map((step) => `- "${step.title} (${run})" → ${step.owner}`),
      'The "test-call" card belongs to the shop\'s own receptionist (booking--<shop-slug>). If no such agent exists yet, leave that card unassigned and say so.',
      "Then report which cards you assigned. You will be told as each card is done or blocked.",
    ].join("\n"),
  }));
  return { run, session_id: session.id, cards: ids.size };
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
    };
    const base = card.title.slice(0, match.index);
    const step = run.steps.find((s) => s.title === base);
    if (step) step.card = card;
    if (card.created_at < run.created_at) run.created_at = card.created_at;
    runs.set(id, run);
  }
  return [...runs.values()].sort((a, b) => b.run.localeCompare(a.run));
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
    const page = await json<{ data?: { id: string }[] }>(res);
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
