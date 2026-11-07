/**
 * A tiny in-memory stand-in for the CEO's board on Naïve, so the company's wiring can be
 * exercised locally for free. The plan is `PIPELINE` and the permissions are the crew's own
 * declarations from `templates/receptionist.ts` — the same data `naive up` applies. It copies the platform's rules on purpose, so moving to `naive up` changes nothing
 * about how the crew behaves:
 *
 *  - The CEO owns one board. Cards are `todo | doing | blocked | done`; order rides in `blocked_by`.
 *  - Assigning a `todo` card with no open blocker wakes that teammate on it.
 *  - Only the assignee claims (`doing`) and closes (`done`) its card; `done` requires a note.
 *  - When a card reaches `done` or `blocked`, the CEO is told (a "digest").
 *  - A tool with permission `ask` parks the work until a person allows or denies it.
 *
 * Nothing here talks to the network.
 */
import { PIPELINE, receptionistCrew, receptionistRoster, type Owner } from "../templates/receptionist.ts";

/** The organization's CEO, as `naive up` names it (the standing orchestrator). */
export const CEO = { name: "CEO" } as const;
export type MemberName = Owner;

/** Each seat's tool permissions, read from the same declarations `naive up` applies. */
const SEATS = Object.fromEntries([...receptionistRoster, ...receptionistCrew].map((a) => [a.name, a]));
const permissionOf = (agent: MemberName, tool: string) => {
  const tools = SEATS[agent]?.tools;
  return tools?.configs[tool]?.permission ?? tools?.default_config.permission ?? "deny";
};

/** The CEO's plan is the board `naive up` seeds: `PIPELINE`, each card handed to its owner. */
export const planFromPipeline = (goal: string): PlanStep[] =>
  PIPELINE.map((step) => ({
    key: step.key,
    title: step.title,
    body: `Goal: ${goal}\n${step.body}`,
    assignee: step.owner,
    blocked_by: "blocked_by" in step ? [...step.blocked_by] : [],
  }));

export type CardStatus = "todo" | "doing" | "blocked" | "done";

export interface Card {
  id: string;
  key: string;
  title: string;
  body: string;
  status: CardStatus;
  assignee: MemberName;
  blocked_by: string[];
  note: string | null;
  result: unknown;
  comments: { author: string; body: string }[];
}

export interface CompanyEvent {
  seq: number;
  type:
    | "goal.received"
    | "card.created"
    | "card.assigned"
    | "card.claimed"
    | "card.done"
    | "card.blocked"
    | "approval.requested"
    | "approval.resolved"
    | "ceo.digest"
    | "ceo.report";
  from: string;
  to?: string;
  text: string;
  card_id?: string;
}

export interface Approval {
  id: string;
  card_id: string;
  agent: MemberName;
  tool: string;
  args: unknown;
  status: "pending" | "allowed" | "denied";
}

/** What a specialist gets when the board wakes it. */
export interface WorkContext {
  card: Card;
  /** Results of the cards this one was blocked by, keyed by card key. */
  inputs: Record<string, unknown>;
  /**
   * Call an external tool. Tools the seat holds at `ask` go through operator approval first;
   * the first call parks the card, and the work re-runs once a person decides.
   * Returns `{ allowed }` so the handler can finish either way. Always mocked locally.
   */
  tool(name: string, args: unknown): { allowed: boolean };
}

export interface WorkResult {
  note: string;
  result?: unknown;
}

export type Handler = (ctx: WorkContext) => WorkResult;

export interface PlanStep {
  key: string;
  title: string;
  body: string;
  assignee: MemberName;
  blocked_by?: string[];
}

export interface CeoBrain {
  plan(goal: string): PlanStep[];
  report(cards: Card[]): string;
}

class AwaitingApproval extends Error {}

export class LocalCompany {
  readonly cards: Card[] = [];
  readonly events: CompanyEvent[] = [];
  readonly approvals: Approval[] = [];
  private listeners: ((e: CompanyEvent) => void)[] = [];
  private seq = 0;

  private ceo: CeoBrain;
  private handlers: Record<MemberName, Handler>;

  constructor(ceo: CeoBrain, handlers: Record<MemberName, Handler>) {
    this.ceo = ceo;
    this.handlers = handlers;
  }

  onEvent(fn: (e: CompanyEvent) => void) {
    this.listeners.push(fn);
  }

  /** Trigger a workflow: the CEO plans the goal onto the board and hands out every card. */
  start(goal: string) {
    this.emit({ type: "goal.received", from: "operator", to: CEO.name, text: goal });
    for (const step of this.ceo.plan(goal)) {
      const card: Card = {
        id: `crd_${String(this.cards.length + 1).padStart(3, "0")}`,
        key: step.key,
        title: step.title,
        body: step.body,
        status: "todo",
        assignee: step.assignee,
        blocked_by: (step.blocked_by ?? []).map((k) => this.byKey(k).id),
        note: null,
        result: null,
        comments: [],
      };
      this.cards.push(card);
      this.emit({ type: "card.created", from: CEO.name, text: card.title, card_id: card.id });
      this.emit({ type: "card.assigned", from: CEO.name, to: card.assignee, text: card.title, card_id: card.id });
    }
    return this.runUntilIdle();
  }

  /** The operator answers a parked `ask` tool call, and the board picks the card back up. */
  confirm(approvalId: string, decision: "allow" | "deny") {
    const a = this.approvals.find((x) => x.id === approvalId);
    if (!a || a.status !== "pending") throw new Error(`no pending approval ${approvalId}`);
    a.status = decision === "allow" ? "allowed" : "denied";
    this.emit({
      type: "approval.resolved",
      from: "operator",
      to: a.agent,
      text: `${a.tool} ${a.status}`,
      card_id: a.card_id,
    });
    const card = this.get(a.card_id);
    card.status = "todo"; // unblocked; the assignee is woken again on the next tick
    return this.runUntilIdle();
  }

  pendingApprovals() {
    return this.approvals.filter((a) => a.status === "pending");
  }

  progress() {
    const count = (s: CardStatus) => this.cards.filter((c) => c.status === s).length;
    const done = count("done");
    return {
      todo: count("todo"),
      doing: count("doing"),
      blocked: count("blocked"),
      done,
      total: this.cards.length,
      percent: this.cards.length ? Math.round((done / this.cards.length) * 100) : 0,
    };
  }

  get(id: string) {
    const c = this.cards.find((x) => x.id === id);
    if (!c) throw new Error(`no card ${id}`);
    return c;
  }

  byKey(key: string) {
    const c = this.cards.find((x) => x.key === key);
    if (!c) throw new Error(`no card with key ${key}`);
    return c;
  }

  // ── the board's clock ──────────────────────────────────────────────────────

  private runUntilIdle() {
    let woke = true;
    while (woke) {
      woke = false;
      for (const card of this.cards) {
        if (card.status !== "todo") continue;
        if (card.blocked_by.some((id) => this.get(id).status !== "done")) continue;
        this.wake(card);
        woke = true;
      }
    }
    if (this.cards.length && this.cards.every((c) => c.status === "done")) {
      this.emit({ type: "ceo.report", from: CEO.name, to: "operator", text: this.ceo.report(this.cards) });
    }
    return this.progress();
  }

  private wake(card: Card) {
    card.status = "doing";
    this.emit({ type: "card.claimed", from: card.assignee, text: card.title, card_id: card.id });

    const inputs = Object.fromEntries(
      card.blocked_by.map((id) => this.get(id)).map((c) => [c.key, c.result]),
    );
    const ctx: WorkContext = { card, inputs, tool: (name, args) => this.callTool(card, name, args) };

    try {
      const out = this.handlers[card.assignee](ctx);
      if (!out.note) throw new Error("a card cannot be done without a note");
      card.note = out.note;
      card.result = out.result ?? null;
      card.status = "done";
      this.emit({ type: "card.done", from: card.assignee, to: CEO.name, text: out.note, card_id: card.id });
      this.digest(card);
    } catch (err) {
      if (!(err instanceof AwaitingApproval)) throw err;
      card.status = "blocked";
      card.comments.push({ author: card.assignee, body: err.message });
      this.emit({ type: "card.blocked", from: card.assignee, to: CEO.name, text: err.message, card_id: card.id });
      this.digest(card);
    }
  }

  private callTool(card: Card, name: string, args: unknown): { allowed: boolean } {
    const permission = permissionOf(card.assignee, name);
    if (permission === "deny") throw new Error(`${card.assignee} may not use ${name}`);
    if (permission === "allow") return { allowed: true };

    // `ask`: reuse a decision already made for this card+tool, otherwise park for a person.
    const decided = this.approvals.find((a) => a.card_id === card.id && a.tool === name && a.status !== "pending");
    if (decided) return { allowed: decided.status === "allowed" };

    const approval: Approval = {
      id: `apr_${String(this.approvals.length + 1).padStart(3, "0")}`,
      card_id: card.id,
      agent: card.assignee,
      tool: name,
      args,
      status: "pending",
    };
    this.approvals.push(approval);
    this.emit({
      type: "approval.requested",
      from: card.assignee,
      to: "operator",
      text: `${name} needs approval (${approval.id})`,
      card_id: card.id,
    });
    throw new AwaitingApproval(`awaiting_approval: ${name} (${approval.id})`);
  }

  private digest(card: Card) {
    const p = this.progress();
    this.emit({
      type: "ceo.digest",
      from: "board",
      to: CEO.name,
      text: `${card.key} is ${card.status} — board ${p.done}/${p.total} done (${p.percent}%)`,
      card_id: card.id,
    });
  }

  private emit(e: Omit<CompanyEvent, "seq">) {
    const event = { seq: ++this.seq, ...e };
    this.events.push(event);
    for (const fn of this.listeners) fn(event);
  }
}
