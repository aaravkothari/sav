import { Brush, Pause, Play, Rocket, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { apiGet, apiMessage, apiSend, useApi } from "../api";
import { PageHeader } from "../components/kit";
import type { Client } from "../data";
import { agentLabel, scrub, shopName } from "../leads";
import { stopLabel, waitingOn, type PlatformSession } from "../platform";
import { CompanyLive } from "./CompanyLive";

/** `GET /api/company`: the company's on/off switch (`server/runs.ts`). */
export interface CompanyState {
  paused: boolean;
  changed_at: string;
  interrupted: string[];
  deployments: string[];
}

export interface RunCard {
  id: string;
  title: string;
  note: string | null;
  status: "todo" | "doing" | "blocked" | "done";
  assignee: string | null;
  woken_session_id: string | null;
  updated_at: string;
}

export interface RunStep {
  key: string;
  title: string;
  owner: string;
  card: RunCard | null;
}

export type RunState = "active" | "stopped" | "done" | "cancelled";

export interface Run {
  run: string;
  goal: string;
  created_at: string;
  steps: RunStep[];
  state: RunState;
}

export const RUN_STATE: Record<RunState, { label: string; cls: string }> = {
  active: { label: "Running", cls: "chip-plain" },
  stopped: { label: "Stopped", cls: "chip-absent" },
  done: { label: "Done", cls: "chip-credit" },
  cancelled: { label: "Cancelled", cls: "chip-fail" },
};

/** Where a run that is not moving stopped: its first step not done. */
export const stoppedAt = (run: Run): RunStep | undefined => run.steps.find((s) => s.card?.status !== "done");

const POLL_MS = 10_000;

export const STEP_STATUS: Record<RunCard["status"] | "missing", { label: string; cls: string }> = {
  todo: { label: "Waiting", cls: "chip-absent" },
  doing: { label: "Working", cls: "chip-plain" },
  blocked: { label: "Blocked", cls: "chip-fail" },
  done: { label: "Done", cls: "chip-credit" },
  missing: { label: "Not on the board", cls: "chip-absent" },
};

/** `run-202611080130` → "Nov 8, 1:30 AM" in the viewer's own zone; the id is UTC. */
export function runWhen(run: string): string {
  const m = /^run-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(run);
  if (!m) return run;
  const at = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!));
  return at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * A card's note or a run's goal as a person reads it. Agents write them for each other: escaped
 * `\n`s, `cli_…` ids, shop slugs, `booking--<shop>` seats and session ids. Ids and slugs of known
 * shops become their names, an agent seat its role, and any other machine id is dropped.
 */
export function readable(text: string | null | undefined, clients: readonly Pick<Client, "id" | "slug" | "name">[] = []): string {
  if (!text) return "";
  const byId = new Map(clients.map((c) => [c.id, shopName(c.name)]));
  const bySlug = new Map(clients.filter((c) => c.slug).map((c) => [c.slug, shopName(c.name)]));
  let out = text
    .replace(/(?:\\r)?\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\b(?:booking|receptionist)--([a-z0-9-]+)\b/g, (seat) => agentLabel(seat))
    .replace(/\bcli_[A-Za-z0-9]+\b/g, (id) => byId.get(id) ?? "a shop");
  for (const [slug, name] of bySlug) {
    if (slug.length >= 4 && slug.includes("-")) out = out.replace(new RegExp(`\\b${slug.replace(/[-]/g, "\\-")}\\b`, "g"), name);
  }
  return scrub(out).replace(/\n{3,}/g, "\n\n");
}

/** What the company's badge says: paused, or what its current run is doing, or that none is going. */
export function companyBadge(company: CompanyState | null, current: readonly Run[]): { label: string; cls: string } {
  if (company === null) return { label: "Reading…", cls: "chip-absent" };
  if (company.paused) return { label: "Paused", cls: "chip-fail" };
  const run = current[0];
  if (!run) return { label: "No run going", cls: "chip-absent" };
  return run.state === "active" ? { label: "Running", cls: "chip-credit" } : RUN_STATE[run.state];
}

/**
 * The company's control room: switch it on and off, start a run, and watch every run's six steps
 * as the agents work them. Everything the terminal and the Naïve Studio were needed for.
 */
export function Runs() {
  const [company, setCompany] = useState<CompanyState | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [sessions, setSessions] = useState<PlatformSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [goal, setGoal] = useState("Find and sign up busy independent auto repair shops in Palo Alto, California");
  const [confirmed, setConfirmed] = useState(false);
  // Only to name the shops a card's note mentions by id or slug.
  const { data: clientRows } = useApi<Client[]>("/clients");
  const clients = clientRows ?? [];

  const refresh = useCallback(async () => {
    try {
      const [state, board, live] = await Promise.all([
        apiGet<CompanyState>("/company"),
        apiGet<{ runs: Run[] }>("/runs"),
        apiGet<{ data?: PlatformSession[] }>("/sessions"),
      ]);
      setCompany(state);
      setRuns(board.runs);
      setSessions(live.data ?? []);
      setError(null);
    } catch (err: unknown) {
      setError(apiMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (kind: "start" | "pause" | "resume" | "cleanup" | `cancel:${string}`) => {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === "start") {
        const started = await apiSend<{ run: string; closed_before: number }>("POST", "/runs", { goal, confirm_spend: true });
        setConfirmed(false);
        setNotice(`Started ${runWhen(started.run)}.${started.closed_before ? ` Closed ${started.closed_before} old open card(s) first.` : ""}`);
      } else if (kind === "cleanup") {
        const done = await apiSend<{ closed: number }>("POST", "/runs/cleanup");
        setNotice(done.closed ? `Closed ${done.closed} old open card(s). The board is clean.` : "The board was already clean.");
      } else if (kind.startsWith("cancel:")) {
        const run = kind.slice("cancel:".length);
        const done = await apiSend<{ closed: number }>("POST", `/runs/${run}/cancel`);
        setNotice(`Cancelled ${runWhen(run)}: ${done.closed} card(s) closed and their agents stopped.`);
      } else {
        setCompany(await apiSend<CompanyState>("POST", `/company/${kind}`));
      }
      await refresh();
    } catch (err: unknown) {
      setError(apiMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const waiting = waitingOn(sessions, new Map()).length;
  const paused = company?.paused === true;
  const current = (runs ?? []).filter((r) => r.state === "active" || r.state === "stopped");
  const history = (runs ?? []).filter((r) => r.state === "done" || r.state === "cancelled");
  const badge = companyBadge(company, current);

  const runCard = (run: Run, live: boolean) => {
    const state = RUN_STATE[run.state];
    const at = run.state === "stopped" ? stoppedAt(run) : undefined;
    return (
      <article key={run.run} className="panel p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className={`chip ${state.cls}`}>{state.label}</span>
          <span className="min-w-0 flex-1 font-medium">{readable(run.goal, clients) || runWhen(run.run)}</span>
          <span className="text-xs text-ink-3">{runWhen(run.run)}</span>
          {live ? (
            <button type="button" className="btn btn-quiet btn-sm" disabled={busy !== null} onClick={() => void act(`cancel:${run.run}`)}>
              <X size={14} strokeWidth={1.75} /> {busy === `cancel:${run.run}` ? "Cancelling…" : "Cancel run"}
            </button>
          ) : null}
        </div>
        {at ? <p className="mt-2 text-xs text-ink-2">Stopped at step {run.steps.indexOf(at) + 1}, {at.title.toLowerCase()}: nothing is assigned to it.{at.key === "test-call" ? " It waits for a shop to be moved to Active in the CRM." : ""}</p> : null}
        <ol className="mt-4 grid gap-2 md:grid-cols-3 xl:grid-cols-6">
          {run.steps.map((step, i) => {
            const cancelled = step.card?.note?.startsWith("CANCELLED") === true;
            const status = cancelled ? { label: "Cancelled", cls: "chip-fail" } : STEP_STATUS[step.card?.status ?? "missing"];
            const session = step.card?.woken_session_id ? byId.get(step.card.woken_session_id) : undefined;
            return (
              <li key={step.key} className="rounded-md border border-line p-3">
                <div className="text-[0.6875rem] text-ink-3">{i + 1}. {agentLabel(step.owner)}</div>
                <div className="mt-1 text-sm font-medium">{step.title}</div>
                <span className={`chip ${status.cls} mt-2`}>{status.label}</span>
                {session && live ? <div className="mt-2 text-xs text-ink-2">Agent: {session.status === "running" ? "working now" : stopLabel(session)}</div> : null}
                {step.card?.note && !cancelled ? <p className="mt-2 line-clamp-6 whitespace-pre-wrap break-words text-xs text-ink-2">{readable(step.card.note, clients)}</p> : null}
              </li>
            );
          })}
        </ol>
      </article>
    );
  };

  const control = paused ? (
    <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void act("resume")}>
      <Play size={15} strokeWidth={1.75} /> {busy === "resume" ? "Resuming…" : "Resume company"}
    </button>
  ) : (
    <button type="button" className="btn btn-danger" disabled={busy !== null || company === null} onClick={() => void act("pause")}>
      <Pause size={15} strokeWidth={1.75} /> {busy === "pause" ? "Pausing…" : "Pause company"}
    </button>
  );

  return (
    <div className="pane-in">
      <PageHeader
        title="The company, live"
        subtitle="Every team, what wakes it, and what it has done, from the first Google Maps search to a paying shop."
        actions={error ? <span className="text-xs text-fail">{error}</span> : null}
      />

      {notice ? <p className="mb-4 text-sm text-ink-2">{notice}</p> : null}
      {paused ? <p className="mb-4 text-sm text-ink-2">Paused {company.changed_at ? new Date(company.changed_at).toLocaleString() : ""}. {company.interrupted.length} agent session(s) stopped.</p> : null}

      {waiting > 0 ? (
        <Link to="/approvals" className="panel mb-4 flex items-center gap-2 p-3 text-sm">
          <ShieldAlert size={15} strokeWidth={1.75} />
          <span className="font-medium">{waiting} waiting on you</span>
          <span className="text-ink-2">— open Approvals</span>
        </Link>
      ) : null}

      <CompanyLive sessions={sessions} paused={paused} control={control} />

      <details className="live-manual">
        <summary className="eyebrow mb-3 cursor-pointer">Start a run by hand ({badge.label.toLowerCase()})</summary>
        <div className="mb-3 flex justify-end">
          <button type="button" className="btn btn-quiet btn-sm" disabled={busy !== null} onClick={() => void act("cleanup")}
            title="Close every open card on the CEO's board: old runs and leftover setup tasks">
            <Brush size={14} strokeWidth={1.75} /> {busy === "cleanup" ? "Cleaning…" : "Clean up board"}
          </button>
        </div>
      <section className="panel mb-6 space-y-3 p-4">
        <label className="field-label" htmlFor="run-goal">Start a run</label>
        <input id="run-goal" className="input w-full" value={goal} maxLength={500} onChange={(e) => setGoal(e.target.value)} />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            This spends Naïve credits and Monid balance
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null || !confirmed || paused || goal.trim() === ""}
            onClick={() => void act("start")}
          >
            <Rocket size={15} strokeWidth={1.75} /> {busy === "start" ? "Starting…" : "Start run"}
          </button>
          <span className="text-xs text-ink-3">{paused ? "Resume the company to start a run." : "Starting closes any run still open, so only the new one runs."}</span>
        </div>
      </section>

      {runs === null ? (
        <div className="absence">{error ? "The runs could not be read." : "Reading the CEO's board…"}</div>
      ) : (
        <>
          <h2 className="eyebrow mb-2">Current</h2>
          {current.length === 0 ? (
            <div className="absence mb-6">No run is going. Start one above.</div>
          ) : (
            <div className="mb-6 space-y-4">{current.map((run) => runCard(run, true))}</div>
          )}
          {history.length > 0 ? (
            <details>
              <summary className="eyebrow mb-2 cursor-pointer">History ({history.length})</summary>
              <div className="space-y-4">{history.map((run) => runCard(run, false))}</div>
            </details>
          ) : null}
        </>
      )}
      </details>
    </div>
  );
}
