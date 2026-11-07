import { ChevronDown, ChevronRight, SendHorizonal } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { apiMessage, apiSend, useApi } from "../api";
import { PageHeader } from "../components/kit";
import { TEMPLATE, type Agent } from "../data";
import { parked, stopLabel, usd, type AgentSpend, type PlatformSession } from "../platform";

/** Every agent in the organization, as the platform holds it — the pair this
 * blueprint declares plus each client's crew. Chat opens a session with the
 * client-manager and streams its events back over `/api/chat/:id/stream`.
 *
 * A row is not four grey fields any more. The platform already carries what an agency operator
 * needs to decide anything about an agent — the budget on the agent itself, the spend against it,
 * every session it has run and the reason each one stopped — and none of it was ever asked for, so
 * the screen could not say what an agent costs, what it has done, or why it went quiet. Every
 * figure below is the platform's own; nothing here is derived beyond a label. */
export function AgencyAgents() {
  const { data: page, error } = useApi<{ data?: Agent[] }>("/agents");
  const { data: sessionPage, error: sessionError } = useApi<{ data?: PlatformSession[] }>("/sessions");
  const agents = page?.data ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [turns, setTurns] = useState<{ you: string; agent: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const stream = useRef<EventSource | null>(null);

  const sessionsOf = (id: string) => (sessionPage?.data ?? []).filter((s) => s.agent_id === id);

  const send = async (message: string) => {
    setDraft("");
    setChatError(null);
    setTurns((rows) => [...rows, { you: message, agent: "" }]);
    try {
      const session = await apiSend<{ id: string }>("POST", "/chat", { message });
      stream.current?.close();
      const events = new EventSource(`/api/chat/${session.id}/stream`);
      stream.current = events;
      // Deltas and completed messages both carry the text; anything else is lifecycle noise here.
      const append = (event: MessageEvent<string>) => {
        const text = (JSON.parse(event.data) as { data?: { text?: string } }).data?.text;
        if (typeof text !== "string") return;
        setTurns((rows) => rows.map((row, i) => (i === rows.length - 1 ? { ...row, agent: row.agent + text } : row)));
      };
      events.addEventListener("message.delta", append);
      events.addEventListener("message.completed", append);
      events.addEventListener("session.idle", () => events.close());
    } catch (err: unknown) {
      setChatError(apiMessage(err));
    }
  };

  return (
    <div className="pane-in">
      <PageHeader
        title="Agents"
        subtitle={TEMPLATE.words.agentsSubtitle}
        actions={error ? <span className="text-xs text-fail">{error}</span> : null}
      />

      {page === null ? (
        <div className="absence mb-8">{error ? "The roster could not be read, so this is not the answer — retry once the error above is resolved." : "Loading the roster…"}</div>
      ) : agents.length === 0 ? (
        <div className="absence mb-8">
          No agents in this organization yet — <span className="font-mono">naive up</span> provisions them.
        </div>
      ) : (
        <div className="list mb-8">
          {agents.map((a) => {
            const runs = sessionsOf(a.id);
            const last = runs[0];
            const showing = open === a.id;
            return (
              <div key={a.id} className="px-3 py-2.5">
                <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(showing ? null : a.id)}>
                  <span className="grid size-5 shrink-0 place-items-center text-ink-3">
                    {showing ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-medium">{a.name}</span>
                      {a.model ? <span className="chip chip-plain font-mono">{a.model}</span> : null}
                      {/* The cap the agent carries, straight off the agent row — no call of its own. */}
                      {a.budget ? (
                        <span className="chip chip-plain font-mono">{usd(a.budget.cap_micro_usd)} / {a.budget.period}</span>
                      ) : null}
                    </div>
                    {a.description ? <div className="mt-0.5 text-sm text-ink-2">{a.description}</div> : null}
                    <div className="mt-1 text-xs text-ink-3">
                      {sessionPage === null
                        ? sessionError
                          ? "Its sessions could not be read."
                          : "Reading its sessions…"
                        : runs.length === 0
                          ? "No sessions yet — it has not been asked to do anything."
                          : `${runs.length} session${runs.length === 1 ? "" : "s"}${last ? ` · last: ${stopLabel(last)}` : ""}`}
                    </div>
                  </div>
                  {runs.some(parked) ? (
                    <Link to="/approvals" className="chip chip-fail shrink-0" onClick={(e) => e.stopPropagation()}>
                      Waiting on you
                    </Link>
                  ) : null}
                  <span className="shrink-0 font-mono text-xs text-ink-3">{a.id}</span>
                </button>

                {showing ? <AgentDetail agent={a} sessions={runs} loading={sessionPage === null && sessionError === null} /> : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="eyebrow mb-2">Chat</div>
      <div className="panel p-3">
        {turns.length === 0 ? (
          <p className="text-sm text-ink-2">
            Ask <span className="font-mono">client-manager</span> for anything about the agency — it works the same CRM you see
            here, through the dashboard's own tools.
          </p>
        ) : (
          <div className="space-y-2">
            {turns.map((turn, i) => (
              <div key={i} className="space-y-2">
                <div className="ml-auto w-fit max-w-[85%] bubble bubble-you text-sm">{turn.you}</div>
                {turn.agent === "" ? null : <div className="w-fit max-w-[85%] bubble bubble-agent text-sm whitespace-pre-wrap">{turn.agent}</div>}
              </div>
            ))}
          </div>
        )}
        {chatError ? <p className="mt-2 text-xs text-fail">{chatError}</p> : null}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() !== "") void send(draft.trim());
          }}
        >
          <input
            className="input flex-1"
            placeholder="Ask the client-manager what needs attention this week…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={draft.trim() === ""}>
            <SendHorizonal size={14} strokeWidth={1.75} /> Send
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * One agent, opened: what it has spent against its own cap, and what it has actually done.
 *
 * The spend call is made here rather than on the list, so an org with three hundred agents costs
 * one request instead of three hundred. It is its own read and can fail on its own — a budget with
 * no spend beside it is the honest rendering of that, not a zero.
 */
function AgentDetail({ agent, sessions, loading }: { agent: Agent; sessions: PlatformSession[]; loading: boolean }) {
  const { data: spend, error } = useApi<AgentSpend>(`/agents/${agent.id}/spend`);
  return (
    <div className="mt-3 pl-8">
      <div className="grid grid-cols-3 gap-3">
        <div className="panel p-3">
          <div className="text-numeral font-mono">{agent.budget ? usd(agent.budget.cap_micro_usd) : "—"}</div>
          <div className="mt-0.5 text-xs text-ink-3">Cap per {agent.budget?.period ?? "period"}</div>
        </div>
        <div className="panel p-3">
          <div className="text-numeral font-mono">{spend ? usd(spend.spent_micro_usd) : "—"}</div>
          <div className="mt-0.5 text-xs text-ink-3">
            {spend ? `Spent this ${spend.period}` : error ? "Spend unavailable" : "Reading spend…"}
          </div>
        </div>
        <div className="panel p-3">
          <div className="text-numeral font-mono">{agent.budget ? usd(agent.budget.max_task_micro_usd) : "—"}</div>
          <div className="mt-0.5 text-xs text-ink-3">Most one task may spend</div>
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-fail">{error}</p> : null}

      <div className="eyebrow mb-2 mt-4">Sessions</div>
      {loading ? (
        <div className="absence">Reading its sessions…</div>
      ) : sessions.length === 0 ? (
        <div className="absence">Nothing yet. Start it from the chat below, a schedule, or the API.</div>
      ) : (
        <div className="list">
          {sessions.slice(0, 8).map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm">{stopLabel(s)}</span>
              <span className="shrink-0 font-mono text-xs text-ink-3">
                {typeof s.consumed_micro_usd === "number" ? usd(s.consumed_micro_usd) : "—"}
              </span>
              <span className="shrink-0 font-mono text-xs text-ink-3">{(s.created_at ?? "").slice(0, 10)}</span>
              <span className="shrink-0 font-mono text-xs text-ink-3">{s.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
