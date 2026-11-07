import { Check, X } from "lucide-react";
import { useState } from "react";
import { apiMessage, apiSend, useApi } from "../api";
import { PageHeader } from "../components/kit";
import type { Agent } from "../data";
import { argRows, sendable, usd, waitingOn, type Answers, type PlatformSession, type QuestionField, type Waiting } from "../platform";

/**
 * Every agent in this organization that has stopped and is waiting on you.
 *
 * An agency agent holds its outward tools at `ask`: the call stops the turn, the session parks with
 * `stop_reason: "awaiting_approval"`, and the blocked call waits in `pending_actions`
 * (`canonical-spec §6, §7`). Nothing in this product showed one, so the exact moment the approval
 * gate exists for arrived as silence and could only be resolved from a terminal. This screen is
 * that moment. A question the agent asked you (`ask_operator`, `stop_reason: "awaiting_answer"`,
 * a `kind: "question"` row — §7.1) parks the same way and lands here too, answered through
 * `/answers` rather than approved: a question has no "run this call".
 *
 * Three rules it does not bend:
 *   * **The arguments are the decision.** What is being approved is not "email.send", it is
 *     *this message to this address*, so the arguments are rendered to be read.
 *   * **Nothing is claimed that the platform did not confirm.** A decision is reported from the
 *     session the platform answers with — if the call is still pending in that answer, it says so.
 *   * **A failed read is never an empty queue.** "Nothing is waiting on you" is a statement about
 *     the organization, and printing it over a request that failed would be a lie.
 */
export function Approvals() {
  const { data: page, error, setError } = useApi<{ data?: PlatformSession[] }>("/sessions?status=idle");
  const { data: roster } = useApi<{ data?: Agent[] }>("/agents");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [decided, setDecided] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, Answers>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const names = new Map((roster?.data ?? []).map((a) => [a.id, a.name]));
  const rows = waitingOn(page?.data ?? [], names);

  // Per-card state is keyed by session AND call: `tool_call_id` is derived from the tool name and
  // its arguments (§7.1), so two sessions holding the same call share it.
  const keyOf = (row: Waiting) => `${row.session.id}:${row.action.tool_call_id}`;

  const decide = async (row: Waiting, decision: "allow" | "deny") => {
    const id = row.action.tool_call_id;
    const key = keyOf(row);
    setBusy(key);
    setError(null);
    try {
      const reason = (reasons[key] ?? "").trim();
      const after = await apiSend<PlatformSession>("POST", `/sessions/${row.session.id}/tool_confirmations`, {
        tool_call_id: id,
        decision,
        ...(reason === "" ? {} : { reason }),
      });
      // The platform's answer, not our optimism: it returns the session with the resolved call
      // removed. If the call is still there, the decision did not land and saying otherwise would
      // be inventing an outcome.
      const stillHeld = (after.pending_actions ?? []).some((a) => a.tool_call_id === id);
      // The card stays, carrying what happened to it. Dropping it the moment the platform answered
      // is what the queue used to do to a decision: the row vanished and the operator was never
      // told which way it went.
      setDecided((all) => ({
        ...all,
        [key]: stillHeld
          ? `The platform still reports ${row.action.name} as waiting — nothing was decided.`
          : decision === "allow"
            ? `Approved. ${row.action.name} is running and ${row.agent} has carried on.`
            : `Rejected. ${row.action.name} did not run; ${row.agent} was told and has carried on.`,
      }));
    } catch (err: unknown) {
      setError(apiMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const answer = async (row: Waiting) => {
    const id = row.action.tool_call_id;
    const key = keyOf(row);
    const fields = row.action.question?.fields ?? [];
    const given = sendable(fields, answers[key] ?? {});
    const missing = fields.filter((f) => (given[f.key] ?? "").length === 0).map((f) => f.label);
    if (missing.length > 0) {
      setError(`Answer every field before sending: ${missing.join(", ")}.`);
      return;
    }
    setBusy(key);
    setError(null);
    try {
      const after = await apiSend<PlatformSession>("POST", `/sessions/${row.session.id}/answers`, {
        tool_call_id: id,
        answers: given,
      });
      const stillHeld = (after.pending_actions ?? []).some((a) => a.tool_call_id === id);
      setDecided((all) => ({
        ...all,
        [key]: stillHeld
          ? `The platform still reports the question as waiting — nothing was answered.`
          : `Answered. ${row.agent} has your answer and has carried on.`,
      }));
    } catch (err: unknown) {
      setError(apiMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const setAnswer = (card: string, field: string, value: string | string[]) =>
    setAnswers((all) => ({ ...all, [card]: { ...(all[card] ?? {}), [field]: value } }));

  return (
    <div className="pane-in">
      <PageHeader
        title="Approvals"
        subtitle="Agents stop here before doing anything you cannot take back. Nothing on this screen has happened yet."
        actions={error ? <span className="text-xs text-fail">{error}</span> : null}
      />

      {page === null ? (
        <div className="absence">
          {error ? "The approval queue could not be read, so this list is not the answer — retry once the error above is resolved." : "Reading what is waiting…"}
        </div>
      ) : rows.length === 0 ? (
        <div className="absence">No agent is waiting on you. Every session in this organization is either running or finished.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const id = keyOf(row);
            const outcome = decided[id];
            const question = row.action.kind === "question" ? row.action.question : undefined;
            if (question) {
              return (
                <article key={id} className="panel p-4">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-mono font-medium">{row.agent}</span>
                    <span className="text-sm text-ink-2">asks you</span>
                  </div>
                  <div className="mt-1 font-mono text-xs text-ink-3">{row.session.id}</div>
                  <p className="mt-4 whitespace-pre-wrap break-words text-sm">{question.prompt}</p>
                  {outcome ? (
                    <p className="mt-4 text-sm text-ink-2">{outcome}</p>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {question.fields.map((field) => (
                        <AnswerField
                          key={field.key}
                          id={`${id}-${field.key}`}
                          field={field}
                          value={answers[id]?.[field.key] ?? ""}
                          onChange={(value) => setAnswer(id, field.key, value)}
                        />
                      ))}
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busy !== null}
                          onClick={() => void answer(row)}
                        >
                          <Check size={14} strokeWidth={1.75} /> Answer — wake the agent
                        </button>
                        <span className="text-xs text-ink-3">
                          {busy === id ? "Sending your answer…" : "Your answer goes back to the agent as the result of its question, and its turn resumes."}
                        </span>
                      </div>
                    </div>
                  )}
                </article>
              );
            }
            return (
              <article key={id} className="panel p-4">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-mono font-medium">{row.agent}</span>
                  <span className="text-sm text-ink-2">{row.action.name === "request_tools" ? "asks to be granted tools via" : "wants to call"}</span>
                  <span className="chip chip-plain font-mono">{row.action.name}</span>
                </div>
                <div className="mt-1 font-mono text-xs text-ink-3">
                  {row.session.id}
                  {typeof row.session.consumed_micro_usd === "number"
                    ? ` · ${usd(row.session.consumed_micro_usd)} spent so far`
                    : null}
                </div>

                <div className="eyebrow mb-2 mt-4">
                  {row.action.name === "request_tools" ? "What it asks to hold — approving changes this agent's toolset from its next turn" : "What it would do"}
                </div>
                {argRows(row.action.args).length === 0 ? (
                  <p className="absence">The agent proposed this call with no arguments.</p>
                ) : (
                  <dl className="list">
                    {argRows(row.action.args).map((arg) => (
                      <div key={arg.key} className={arg.block ? "px-3 py-2.5" : "flex gap-3 px-3 py-2.5"}>
                        <dt className={`font-mono text-xs text-ink-3 ${arg.block ? "mb-1" : "w-32 shrink-0 pt-0.5"}`}>{arg.key}</dt>
                        <dd className={`min-w-0 flex-1 text-sm ${arg.block ? "whitespace-pre-wrap break-words" : "truncate"}`}>
                          {arg.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}

                {outcome ? (
                  <p className="mt-4 text-sm text-ink-2">{outcome}</p>
                ) : (
                  <div className="mt-4">
                    <label className="field-label" htmlFor={`why-${id}`}>
                      Reason (optional)
                    </label>
                    <input
                      id={`why-${id}`}
                      className="input"
                      placeholder="Recorded with your decision and passed to the agent."
                      value={reasons[id] ?? ""}
                      onChange={(e) => setReasons((all) => ({ ...all, [id]: e.target.value }))}
                    />
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy !== null}
                        onClick={() => void decide(row, "allow")}
                      >
                        <Check size={14} strokeWidth={1.75} /> Approve — run this call
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={busy !== null}
                        onClick={() => void decide(row, "deny")}
                      >
                        <X size={14} strokeWidth={1.75} /> Reject — do not run it
                      </button>
                      <span className="text-xs text-ink-3">
                        {busy === id ? "Sending your decision…" : "Approving runs the call as it stands. Rejecting drops it and the agent carries on without it."}
                      </span>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * One field of a question. `text` is an input; `choice` is the options as buttons (the words are
 * the value — §7.1) plus, when the agent left `other` on (the default), a free-text escape, because
 * the agent wrote the options and is the one who does not know the answer.
 */
function AnswerField({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: QuestionField;
  value: string | string[];
  onChange: (value: string | string[]) => void;
}) {
  const chosen = Array.isArray(value) ? value : value === "" ? [] : [value];
  const pick = (option: string) => {
    if (field.type !== "choice") return;
    if (!field.multiple) return onChange(chosen[0] === option ? "" : option);
    onChange(chosen.includes(option) ? chosen.filter((c) => c !== option) : [...chosen, option]);
  };
  const other = field.type === "choice" ? chosen.find((c) => !field.options.includes(c)) ?? "" : "";
  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {field.label}
      </label>
      {field.help ? <p className="mb-1 text-xs text-ink-3">{field.help}</p> : null}
      {field.type === "text" ? (
        <input
          id={id}
          className="input"
          placeholder={field.placeholder ?? ""}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {field.options.map((option) => (
            <button
              key={option}
              type="button"
              className={`chip ${chosen.includes(option) ? "chip-chosen" : "chip-plain"}`}
              aria-pressed={chosen.includes(option)}
              onClick={() => pick(option)}
            >
              {option}
            </button>
          ))}
          {field.other !== false ? (
            <input
              id={id}
              className="input"
              placeholder="Something else…"
              value={other}
              onChange={(e) => {
                const listed = chosen.filter((c) => field.options.includes(c));
                const text = e.target.value;
                onChange(field.multiple ? (text === "" ? listed : [...listed, text]) : text);
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
