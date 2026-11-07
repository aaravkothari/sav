/**
 * The platform's own rows as this dashboard reads them, and the four judgements the screens make
 * about them. Pure — no DOM, no fetch — so the judgements are the part that is tested.
 *
 * Everything here is *read back* from the API and nothing is derived beyond a label: an agency
 * operator asked to approve an agent's action, or to say what an agent costs, is owed the
 * platform's numbers and not this dashboard's guess at them.
 */

/** One field of a question an agent asked (`canonical-spec §7.1`); the answer is keyed by `key`. */
export type QuestionField = { key: string; label: string; help?: string } & (
  | { type: "text"; placeholder?: string }
  | { type: "choice"; options: string[]; multiple?: boolean; other?: boolean }
);

/**
 * One row blocking a session (`packages/core/src/schema/session.ts`): a tool call held at `ask`
 * (`kind` absent or `"tool"`), or a question the agent parked on you (`kind: "question"`, and then
 * `question` is the parse of `args`). Both are addressed by the same `tool_call_id`.
 */
export interface PendingAction {
  kind?: "tool" | "question";
  tool_call_id: string;
  name: string;
  args: Record<string, unknown>;
  question?: { prompt: string; fields: QuestionField[] };
}

/** What comes back for a question: one value per field, an array only for a multiple choice. */
export type Answers = Record<string, string | string[]>;

/**
 * The answers as they will be sent: free text trimmed, a blank entry of a multiple choice dropped,
 * a listed option kept exactly as written (the platform checks a closed choice against the option
 * string, §7.2). A field that comes out empty is unanswered, and the platform refuses a partial
 * answer — so the card refuses it first.
 */
export const sendable = (fields: readonly QuestionField[], answers: Answers): Answers => {
  const clean = (field: QuestionField | undefined, value: string) =>
    field?.type === "choice" && field.options.includes(value) ? value : value.trim();
  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => {
      const field = fields.find((one) => one.key === key);
      return [key, Array.isArray(value) ? value.map((one) => clean(field, one)).filter((one) => one !== "") : clean(field, value)];
    }),
  );
};

/** A session, in the fields the screens read. `GET /api/sessions` returns these. */
export interface PlatformSession {
  id: string;
  agent_id: string;
  status: string;
  stop_reason: string | null;
  pending_actions?: PendingAction[];
  budget_micro_usd?: number;
  consumed_micro_usd?: number;
  created_at?: string;
  ended_at?: string | null;
}

/** `GET /api/agents/:id/spend` — what this agent has spent in its own budget period. */
export interface AgentSpend {
  period: string;
  period_start?: string;
  spent_micro_usd: number;
}

/**
 * A session parked on a person.
 *
 * `awaiting_approval` and `awaiting_answer` are **stop reasons and not statuses**: a tool held at `ask` stops the turn,
 * the session goes `idle`, and the blocked call sits in `pending_actions`. A screen that looked for
 * a status of that name would find nothing at all — which is exactly what the product did, so the
 * one moment it exists to create reached the operator as silence.
 */
export const parked = (session: PlatformSession): boolean =>
  (session.stop_reason === "awaiting_approval" || session.stop_reason === "awaiting_answer") &&
  (session.pending_actions?.length ?? 0) > 0;

/** One row of the approval queue: the call, the session it blocks, and the agent that proposed it. */
export interface Waiting {
  session: PlatformSession;
  action: PendingAction;
  agent: string;
}

/** Every parked call across the organization, newest session first, named by its agent. */
export function waitingOn(sessions: PlatformSession[], agentNames: Map<string, string>): Waiting[] {
  return sessions
    .filter(parked)
    .flatMap((session) =>
      (session.pending_actions ?? []).map((action) => ({
        session,
        action,
        // The name when the roster loaded, the id when it did not: an id is still true.
        agent: agentNames.get(session.agent_id) ?? session.agent_id,
      })),
    );
}

/** One argument, ready to render: `block` means it needs its own lines rather than a table cell. */
export interface ArgRow {
  key: string;
  value: string;
  block: boolean;
}

/**
 * The arguments the agent proposed, rendered to be read.
 *
 * They **are** the thing being approved, so a JSON dump is not a rendering of them: a string is
 * shown as the text it is — the message that would be sent, the address it would go to — a number
 * or a flag as itself, a list of plain values joined, and only a genuinely nested value falls back
 * to indented JSON, which is the honest rendering of a nested value.
 */
export function argRows(args: Record<string, unknown>): ArgRow[] {
  return Object.entries(args).map(([key, value]) => {
    if (typeof value === "string") return { key, value, block: value.includes("\n") || value.length > 72 };
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      return { key, value: String(value), block: false };
    }
    if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")) {
      return { key, value: value.map(String).join(", "), block: false };
    }
    return { key, value: JSON.stringify(value, null, 2), block: true };
  });
}

/** Money is integer micro-USD on the wire (`canonical-spec`); this is the only place it becomes text. */
export const usd = (microUsd: number): string =>
  `$${(microUsd / 1_000_000).toFixed(microUsd !== 0 && Math.abs(microUsd) < 10_000 ? 4 : 2)}`;

/**
 * Why a session stopped, said plainly — every value the platform's `stop_reason` can take.
 *
 * A session that stops for any reason other than finishing used to show the operator nothing: no
 * word for `budget_paused`, none for `error`, none for `max_iterations`, so an agent that ran out
 * of money and an agent that finished the job looked identical on the screen.
 */
export const STOP_REASON: Record<string, string> = {
  end_turn: "Finished",
  awaiting_input: "Waiting for a reply",
  awaiting_approval: "Waiting for your approval",
  budget_paused: "Paused — out of budget",
  interrupted: "Interrupted",
  error: "Stopped on an error",
  max_iterations: "Stopped — step limit reached",
  context_exhausted: "Stopped — the turn produced nothing",
  awaiting_delegation: "Waiting on a delegated agent",
  awaiting_answer: "Waiting for your answer",
};

/**
 * What to print for a session's outcome. A `stop_reason` the platform adds after this dashboard
 * ships prints as itself rather than vanishing, and a session that has not stopped says so.
 */
export function stopLabel(session: PlatformSession): string {
  if (session.stop_reason) return STOP_REASON[session.stop_reason] ?? session.stop_reason;
  if (session.status === "running") return "Running";
  if (session.status === "queued") return "Queued";
  return session.status;
}
