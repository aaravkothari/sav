import type { ReactNode } from "react";
import { Link } from "react-router";
import { useApi } from "../api";
import { PageHeader, STAGE_LABEL } from "../components/kit";
import { kindLabel, STAGE_ORDER, TEMPLATE, TEMPLATE_NAME, type Agent, type Client, type Post } from "../data";
import { STOP_REASON, waitingOn, type PlatformSession } from "../platform";

/** `GET /api/context`: the project context (canonical-spec §31.8) plus the install's team and intake report. */
export interface ProjectContext {
  answers: { key: string; label: string; value: string | string[] }[];
  template: string | null;
  updated_at: string;
}
export interface IntakeLine {
  name: string;
  action: string;
  id?: string;
  reason?: string;
  /** The session as the server read it by id; null when it could not be read just now. */
  session: { status: string; stop_reason: string | null; waiting: boolean } | null;
}
export interface ContextReply {
  context: ProjectContext;
  /** The `agt_` ids this install left standing — every platform figure on this screen is cut to them. */
  team: { name: string; id: string }[];
  intake: IntakeLine[];
}

/** A timer as `GET /api/deployments` returns it (canonical-spec §11): the fields the crew list reads. */
export interface Deployment {
  agent_id: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
}

/** One platform list as the server relays it; `has_more` set means the rows are a page, not the whole. */
interface Listed<T> {
  data?: T[];
  has_more?: boolean;
}

const when = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "—";

/**
 * How one day-one session stands, from the server's read of it by id. A session the server could
 * not read is "unknown" — not "created", which would claim a state nobody has seen.
 */
export const dayOneLabel = (line: IntakeLine): string => {
  if (line.action !== "created") return line.reason ?? line.action;
  if (line.session === null) return "unknown";
  if (line.session.waiting) return "Waiting on you";
  if (line.session.stop_reason) return STOP_REASON[line.session.stop_reason] ?? line.session.stop_reason;
  return line.session.status === "running" ? "Running" : line.session.status;
};

function Card({ title, to, children }: { title: string; to?: string; children: ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 flex items-baseline justify-between text-sm font-medium">
        {title}
        {to ? <Link to={to} className="text-xs font-normal text-ink-2 hover:text-ink">Open →</Link> : null}
      </h2>
      {children}
    </section>
  );
}

const Absent = ({ children }: { children: ReactNode }) => <p className="text-xs text-ink-3">{children}</p>;

/** Under product-design only: how many studio deliverables wait on the operator, and the way to them. */
function StudioCard() {
  const { data: posts, error } = useApi<Post[]>("/posts");
  const pending = (posts ?? []).filter((p) => p.channel === "studio" && (p.status === "pending" || p.status === "ready"));
  return (
    <Card title="Studio" to="/studio">
      {posts === null ? (
        <Absent>{error ?? "Reading the studio…"}</Absent>
      ) : pending.length === 0 ? (
        <Absent>No studio deliverable is waiting on you.</Absent>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {pending.map((p) => (
            <li key={p.id} className="flex items-baseline justify-between gap-3">
              <span className="truncate font-medium">{p.title}</span>
              <span className="text-xs text-ink-2">{kindLabel(p.kind)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The first screen under `/app`: what this agency told the platform about itself, what the crew did
 * with it on day one, and what is waiting on the operator now.
 *
 * Every figure is the platform's or the store's own, every read is held on its own, and every
 * platform figure is cut to the install's team: a read that fails leaves its card saying why rather
 * than an empty list, and another project's agents, timers and parked sessions in the same org are
 * not counted here. Without `NAIVE_API_KEY` the platform-backed cards say so and the pipeline card
 * still counts the CRM; with the key but no applied install yet, the context card says that instead
 * of showing a blank form as if answers had been given.
 */
export function Home() {
  const { data: ctx, error: ctxError } = useApi<ContextReply>("/context");
  const approvals = useApi<Listed<PlatformSession>>("/sessions?stop_reason=awaiting_approval");
  const questions = useApi<Listed<PlatformSession>>("/sessions?stop_reason=awaiting_answer");
  const { data: roster, error: rosterError } = useApi<Listed<Agent>>("/agents");
  const { data: timers, error: timerError } = useApi<Listed<Deployment>>("/deployments");
  const { data: clients, error: clientError } = useApi<Client[]>("/clients");

  const ids = new Set((ctx?.team ?? []).map((a) => a.id));
  const names = new Map((ctx?.team ?? []).map((a) => [a.id, a.name]));
  const agents = (roster?.data ?? []).filter((a) => ids.has(a.id));
  const parkedError = approvals.error ?? questions.error;
  const parkedLoaded = approvals.data !== null && questions.data !== null;
  const partial = approvals.data?.has_more === true || questions.data?.has_more === true;
  const waiting = waitingOn(
    [...(approvals.data?.data ?? []), ...(questions.data?.data ?? [])].filter((s) => ids.has(s.agent_id)),
    names,
  );
  const nextFire = new Map<string, Deployment>();
  for (const d of timers?.data ?? []) {
    if (!d.enabled) continue;
    const held = nextFire.get(d.agent_id);
    if (!held || (d.next_run_at ?? "") < (held.next_run_at ?? "")) nextFire.set(d.agent_id, d);
  }
  const notConfigured = ctxError?.startsWith("not configured") ?? false;

  return (
    <div className="pane-in">
      <PageHeader title={TEMPLATE.words.brand} subtitle="What the team knows, what it did on day one, and what is waiting on you." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Project context">
          {ctx ? (
            <dl className="space-y-3">
              {ctx.context.answers.map((a) => (
                <div key={a.key}>
                  <dt className="text-xs text-ink-2">{a.label}</dt>
                  <dd className="text-sm">{Array.isArray(a.value) ? a.value.join(", ") : a.value}</dd>
                </div>
              ))}
              <div className="text-xs text-ink-3">Template {ctx.context.template ?? "—"} · updated {when(ctx.context.updated_at)}</div>
            </dl>
          ) : ctxError ? (
            <Absent>{notConfigured ? "Not configured — set NAIVE_API_KEY on the dashboard to read this project's setup answers." : ctxError}</Absent>
          ) : (
            <Absent>Reading the project context…</Absent>
          )}
        </Card>

        <Card title="Day one" to="/agents">
          {ctx === null ? (
            <Absent>{ctxError ? "Unknown until the project context can be read." : "Reading the install report…"}</Absent>
          ) : ctx.intake.length === 0 ? (
            <Absent>No intake sessions in this install's report.</Absent>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {ctx.intake.map((line) => (
                <li key={line.name} className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{line.name}</span>
                  <span className="text-xs text-ink-2">{dayOneLabel(line)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Approvals due" to="/approvals">
          {parkedError !== null ? (
            <Absent>{parkedError}</Absent>
          ) : !parkedLoaded || ctx === null ? (
            <Absent>{ctxError ? "Unknown until the project context can be read." : "Reading sessions…"}</Absent>
          ) : waiting.length === 0 ? (
            <Absent>{partial ? "Nothing in the first hundred parked sessions; there are more." : "Nothing is waiting on you."}</Absent>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {waiting.map((row) => (
                <li key={`${row.session.id}:${row.action.tool_call_id}`} className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{row.agent}</span>
                  <span className="font-mono text-xs text-ink-2">{row.action.name}</span>
                </li>
              ))}
              {partial ? <li className="text-xs text-ink-3">The first hundred parked sessions; there are more.</li> : null}
            </ul>
          )}
        </Card>

        <Card title="Team" to="/agents">
          {rosterError !== null ? (
            <Absent>{notConfigured ? "Not configured — the roster is the platform's." : rosterError}</Absent>
          ) : roster === null || ctx === null ? (
            <Absent>{ctxError ? "Unknown until the project context can be read." : "Reading the roster…"}</Absent>
          ) : agents.length === 0 ? (
            <Absent>None of this install's agents is standing in the organization.</Absent>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {agents.map((a) => {
                const timer = nextFire.get(a.id);
                return (
                  <li key={a.id} className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{a.name}</span>
                    <span className="text-xs text-ink-2">
                      {timerError !== null ? timerError : timers === null ? "…" : timer ? `next ${when(timer.next_run_at)}` : "no timer"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {TEMPLATE_NAME === "product-design" ? <StudioCard /> : null}

        <Card title="Pipeline" to="/crm">
          {clients === null ? (
            <Absent>{clientError ?? "Reading the CRM…"}</Absent>
          ) : (
            <dl className="grid grid-cols-4 gap-2 text-center">
              {STAGE_ORDER.map((stage) => (
                <div key={stage}>
                  <dd className="text-xl font-semibold">{clients.filter((c) => c.stage === stage).length}</dd>
                  <dt className="text-xs text-ink-2">{STAGE_LABEL[stage]}</dt>
                </div>
              ))}
            </dl>
          )}
        </Card>
      </div>
    </div>
  );
}
