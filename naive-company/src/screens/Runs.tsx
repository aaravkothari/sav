import { Pause, Play, Rocket, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { apiGet, apiMessage, apiSend } from "../api";
import { PageHeader } from "../components/kit";
import { stopLabel, waitingOn, type PlatformSession } from "../platform";

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

export interface Run {
  run: string;
  goal: string;
  created_at: string;
  steps: RunStep[];
}

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
 * The company's control room: switch it on and off, start a run, and watch every run's six steps
 * as the agents work them. Everything the terminal and the Naïve Studio were needed for.
 */
export function Runs() {
  const [company, setCompany] = useState<CompanyState | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [sessions, setSessions] = useState<PlatformSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "pause" | "resume" | null>(null);
  const [goal, setGoal] = useState("Find and sign up busy independent auto repair shops in Palo Alto, California");
  const [confirmed, setConfirmed] = useState(false);

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

  const act = async (kind: "start" | "pause" | "resume") => {
    setBusy(kind);
    try {
      if (kind === "start") {
        await apiSend("POST", "/runs", { goal, confirm_spend: true });
        setConfirmed(false);
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

  return (
    <div className="pane-in">
      <PageHeader
        title="Runs"
        subtitle="Switch the company on and off, start a run, and watch the agents work it. Emails still wait for you on Approvals."
        actions={error ? <span className="text-xs text-fail">{error}</span> : null}
      />

      <section className="panel mb-4 flex flex-wrap items-center gap-3 p-4">
        <span className={`chip ${company === null ? "chip-absent" : paused ? "chip-fail" : "chip-credit"}`}>
          {company === null ? "Reading…" : paused ? "Paused" : "Running"}
        </span>
        <p className="min-w-0 flex-1 text-sm text-ink-2">
          {paused
            ? `Paused ${company.changed_at ? new Date(company.changed_at).toLocaleString() : ""}. ${company.interrupted.length} agent session(s) stopped. While this page is open, anything that starts is stopped too.`
            : "Agents work their cards on their own. Pausing stops every running agent; resuming tells each one to carry on where it left off."}
        </p>
        {paused ? (
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void act("resume")}>
            <Play size={15} strokeWidth={1.75} /> {busy === "resume" ? "Resuming…" : "Resume company"}
          </button>
        ) : (
          <button type="button" className="btn btn-danger" disabled={busy !== null || company === null} onClick={() => void act("pause")}>
            <Pause size={15} strokeWidth={1.75} /> {busy === "pause" ? "Pausing…" : "Pause company"}
          </button>
        )}
      </section>

      {waiting > 0 ? (
        <Link to="/approvals" className="panel mb-4 flex items-center gap-2 p-3 text-sm">
          <ShieldAlert size={15} strokeWidth={1.75} />
          <span className="font-medium">{waiting} waiting on you</span>
          <span className="text-ink-2">— open Approvals</span>
        </Link>
      ) : null}

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
          {paused ? <span className="text-xs text-ink-3">Resume the company to start a run.</span> : null}
        </div>
      </section>

      {runs === null ? (
        <div className="absence">{error ? "The runs could not be read." : "Reading the CEO's board…"}</div>
      ) : runs.length === 0 ? (
        <div className="absence">No runs yet. Start one above.</div>
      ) : (
        <div className="space-y-4">
          {runs.map((run) => (
            <article key={run.run} className="panel p-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium">{run.goal || run.run}</span>
                <span className="font-mono text-xs text-ink-3">{runWhen(run.run)}</span>
              </div>
              <ol className="mt-4 grid gap-2 md:grid-cols-3 xl:grid-cols-6">
                {run.steps.map((step, i) => {
                  const status = STEP_STATUS[step.card?.status ?? "missing"];
                  const session = step.card?.woken_session_id ? byId.get(step.card.woken_session_id) : undefined;
                  return (
                    <li key={step.key} className="rounded-md border border-line p-3">
                      <div className="font-mono text-[0.6875rem] text-ink-3">{i + 1}. {step.owner}</div>
                      <div className="mt-1 text-sm font-medium">{step.title}</div>
                      <span className={`chip ${status.cls} mt-2`}>{status.label}</span>
                      {session ? <div className="mt-2 text-xs text-ink-2">Agent: {session.status === "running" ? "working now" : stopLabel(session)}</div> : null}
                      {step.card?.note ? <p className="mt-2 line-clamp-6 whitespace-pre-wrap break-words text-xs text-ink-2">{step.card.note}</p> : null}
                    </li>
                  );
                })}
              </ol>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
