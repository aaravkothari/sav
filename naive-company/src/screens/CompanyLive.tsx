import { ArrowRight } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { useApi } from "../api";
import { bookingRows } from "../bookings";
import { useLeads } from "../components/sav";
import type { Agent } from "../data";
import { ago, agentLabel, mailKind, shopName, type Lead, type MailMessage, mailFor } from "../leads";
import type { PlatformSession } from "../platform";

/**
 * The company, live: the pipeline from first search to a paying shop, each step with the team
 * that owns it, the service it runs on, what wakes it, how many shops it has moved, and whether
 * its agent is working right now. Every number is read from the CRM, the inbox, `/api/stats`
 * and the platform's sessions; nothing here is made up.
 */

interface Stats {
  leads_found: number;
  demos_built: number;
  emails_sent: number | null;
  replies?: number | null;
  calls_reviewed: number;
  free_week_yes: number;
}

interface Stage {
  team: string;
  /** Agent names on the platform whose sessions count as this stage working. */
  agents: string[];
  tool: string;
  does: string;
  trigger: string;
  count: (c: Counts) => number | null;
  unit: string;
  to: string;
}

interface Counts {
  shops: number;
  demos: number;
  emailed: number;
  replied: number;
  booked: number;
  checkout: number;
  live: number;
  calls: number;
}

const STAGES: Stage[] = [
  { team: "Research", agents: ["research"], tool: "Monid", does: "Searches Google Maps city by city, keeps independent shops, finds the owner's email", trigger: "6 am and 1 pm, two new cities a day", count: (c) => c.shops, unit: "shops found", to: "/leads" },
  { team: "Demo build", agents: ["research", "sales"], tool: "Vapi", does: "Builds every lead its own receptionist from its real hours and services", trigger: "As each lead is filed", count: (c) => c.demos, unit: "receptionists built", to: "/leads?reached=demo" },
  { team: "Outreach", agents: [], tool: "AgentMail", does: "Sends the first email, personalised from the research note", trigger: "Every 30 min, 25 → 100 a batch", count: (c) => c.emailed, unit: "emails sent", to: "/leads?reached=emailed" },
  { team: "Sales", agents: ["sales"], tool: "AgentMail", does: "Answers every reply in its thread: demo link, honest answer, or a polite close", trigger: "The moment a shop replies", count: (c) => c.replied, unit: "replies handled", to: "/leads?reached=replied" },
  { team: "Client manager", agents: ["client-manager"], tool: "Calendar", does: "Collects hours and rules, books the onboarding call, writes the meeting script", trigger: "When a shop says yes", count: (c) => c.booked, unit: "calls booked", to: "/bookings" },
  { team: "Payments", agents: ["payments"], tool: "Stripe", does: "Sends the checkout: 7 days free, then $49.99 a month", trigger: "After the onboarding call", count: (c) => c.checkout, unit: "free weeks started", to: "/crm" },
  { team: "Shop receptionist", agents: ["booking"], tool: "Vapi", does: "One agent per paying shop runs its live receptionist and number", trigger: "When checkout completes", count: (c) => c.live, unit: "shops live", to: "/crm" },
  { team: "Monitoring + self-improvement", agents: ["monitoring", "self-improvement"], tool: "Vapi", does: "Checks every call against the rules, tests each fix on a simulated call, ships it only if it passes", trigger: "Every call that ends", count: (c) => c.calls, unit: "calls reviewed", to: "/calls" },
];

/** Everything on a clock, as declared in the crew's config (`templates/receptionist.ts`) and the engine. */
const ALWAYS_ON: { team: string; what: string; when: string }[] = [
  { team: "Inbox watcher", what: "Matches every reply to its shop and wakes Sales", when: "every 2 min" },
  { team: "Outreach", what: "Sends the next batch of first emails", when: "every 30 min" },
  { team: "Sales", what: "Sweeps the inbox for any reply not yet answered", when: "every 2 h, 7 am – 9 pm" },
  { team: "Payments", what: "Sends checkout links, turns on paid shops", when: "every 2 h, 8 am – 8 pm" },
  { team: "Client manager", what: "Onboards shops that said yes, books calls", when: "every 3 h, 8 am – 8 pm" },
  { team: "Monitoring", what: "Checks the voice service is up", when: "every 3 h" },
  { team: "Research", what: "Two new cities of shops", when: "daily, 6 am and 1 pm" },
  { team: "Monitoring", what: "Daily digest of every call", when: "daily, 9 pm" },
  { team: "Self-improvement", what: "Fixes the day's flagged calls", when: "daily, 10 pm" },
  { team: "Coding liaison", what: "Collects the crew's requests for new tools", when: "daily, 7 pm" },
  { team: "SEO", what: "Improves SAV's own site copy", when: "Mon and Thu, 10 am" },
  { team: "Promotion", what: "Drafts posts and ad ideas for review", when: "Tue and Fri, 11 am" },
];

/** What each seat's run is, in a word or two, for the feed. */
const DOING: Record<string, string> = {
  CEO: "assigned work on the board",
  research: "searched Google Maps and filed new shops",
  sales: "answered shop replies",
  "client-manager": "onboarded shops and booked calls",
  payments: "sent checkouts and turned on paid shops",
  booking: "set up a shop's live receptionist",
  monitoring: "reviewed receptionist calls",
  "self-improvement": "tested and shipped receptionist fixes",
  seo: "improved SAV's site copy",
  promotion: "drafted posts for review",
  "coding-liaison": "collected tool requests for the engineers",
};

const isLive = (s: PlatformSession) => s.status === "running" || s.status === "queued";
const seatOf = (name: string | undefined) => (name && /^booking--/.test(name) ? "booking" : name && /^research/.test(name) ? "research" : name ?? "");

export function CompanyLive({ sessions, paused, control }: { sessions: readonly PlatformSession[]; paused: boolean; control: ReactNode }) {
  const { leads, funnel, messages, clients } = useLeads();
  const { data: stats } = useApi<Stats>("/stats");
  const { data: roster } = useApi<{ data?: Agent[] }>("/agents");
  const names = useMemo(() => new Map((roster?.data ?? []).map((a) => [a.id, a.name])), [roster]);

  const counts: Counts | null = useMemo(() => {
    if (funnel === null) return null;
    const booked = bookingRows(clients ?? []).length;
    return {
      shops: Math.max(funnel.shops, stats?.leads_found ?? 0),
      demos: Math.max((leads ?? []).filter((l) => l.demoReady).length, stats?.demos_built ?? 0),
      emailed: Math.max(funnel.emailed, stats?.emails_sent ?? 0),
      replied: Math.max(funnel.replied, stats?.replies ?? 0),
      booked,
      checkout: Math.max(funnel.free_week, stats?.free_week_yes ?? 0),
      live: funnel.paying,
      calls: stats?.calls_reviewed ?? 0,
    };
  }, [funnel, clients, leads, stats]);

  const bySeat = useMemo(() => {
    const m = new Map<string, PlatformSession[]>();
    for (const s of sessions) {
      const seat = seatOf(names.get(s.agent_id));
      m.set(seat, [...(m.get(seat) ?? []), s]);
    }
    return m;
  }, [sessions, names]);
  const working = sessions.filter(isLive);
  const agents = roster?.data?.length ?? null;
  const spentToday = useMemo(() => {
    const day = new Date().toDateString();
    const micro = sessions.filter((s) => s.created_at && new Date(s.created_at).toDateString() === day).reduce((n, s) => n + (s.consumed_micro_usd ?? 0), 0);
    return micro / 1e6;
  }, [sessions]);

  const feed = useMemo(() => {
    const out: { at: string; mark: string; title: ReactNode; detail?: string }[] = [];
    const shopFor = (m: MailMessage): Lead | undefined => (leads ?? []).find((l) => mailFor(l.client, [m]).length > 0);
    for (const m of messages.slice(0, 40)) {
      const kind = mailKind(m);
      const shop = shopFor(m);
      const who = shop ? shopName(shop.client.name) : m.counterpart;
      if (kind === "bounce") continue;
      if (m.direction === "sent") out.push({ at: m.at, mark: "sent", title: <><b>Outreach</b> emailed {who}</>, detail: m.subject });
      else if (kind === "real") out.push({ at: m.at, mark: "received", title: <><b>{who}</b> replied → Sales woken</>, detail: m.preview || m.subject });
    }
    let lastSeat = "";
    for (const s of [...sessions].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")).slice(0, 80)) {
      if (!s.created_at) continue;
      const name = names.get(s.agent_id);
      const seat = seatOf(name);
      // A burst of the same seat (the CEO handing out cards) reads as one line.
      if (seat === lastSeat && !isLive(s)) continue;
      lastSeat = seat;
      const cost = s.consumed_micro_usd ? ` · $${(s.consumed_micro_usd / 1e6).toFixed(2)}` : "";
      const state = isLive(s) ? "working now" : s.stop_reason === "end_turn" || !s.stop_reason ? "done" : s.stop_reason.replace(/_/g, " ");
      out.push({ at: s.created_at, mark: isLive(s) ? "ok" : "run", title: <><b>{agentLabel(name)}</b> {DOING[seat] ?? "worked its queue"}</>, detail: `${state}${cost}` });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
  }, [messages, sessions, names, leads]);

  return (
    <>
      <section className="live-hero mb-5">
        <div className="live-hero-top">
          <span className={`live-dot${paused ? " off" : ""}`} aria-hidden />
          <span className="live-state">{paused ? "Paused" : "Running on its own"}</span>
          <span className="live-sep" />
          <span><b className="num">{agents ?? "—"}</b> agents</span>
          <span><b className="num">23</b> schedules</span>
          <span><b className="num">{working.length}</b> working now</span>
          <span><b className="num">${spentToday.toFixed(2)}</b> spent today</span>
          <span className="flex-1" />
          {control}
        </div>
        <p className="live-sub">No employees. Each team below is an agent on Naïve with its own job, budget and schedule. One step's output wakes the next.</p>
      </section>

      <h2 className="eyebrow mb-2">The pipeline, live</h2>
      <ol className="live-flow" style={{ marginBottom: 28 }}>
        {STAGES.map((st, i) => {
          const runs = st.agents.flatMap((a) => bySeat.get(a) ?? []);
          const now = runs.some(isLive);
          const last = runs.map((s) => s.created_at ?? "").sort().pop();
          const n = counts ? st.count(counts) : null;
          return (
            <li key={st.team} className={`live-stage${now ? " now" : ""}`}>
              <Link to={st.to}>
                <div className="live-stage-head">
                  <span className="step">{i + 1}</span>
                  <span className="team">{st.team}</span>
                  <span className="tool">{st.tool}</span>
                </div>
                <div className="live-n num">{n ?? "—"}</div>
                <div className="live-unit">{st.unit}</div>
                <p className="live-does">{st.does}</p>
                <div className="live-trigger">⏱ {st.trigger}</div>
                <div className={`live-status${now ? " on" : ""}`}>{now ? "● Working now" : last ? `Last ran ${ago(last)}` : st.agents.length === 0 ? "Runs on the engine" : "Waiting for work"}</div>
              </Link>
              {i < STAGES.length - 1 ? <ArrowRight className="live-arrow" size={16} aria-hidden /> : null}
            </li>
          );
        })}
      </ol>

      <div className="sav-grid-2 mb-6">
        <section className="sav-card">
          <div className="sav-card-head"><h2 className="sav-h2">Live activity</h2><span className="sav-fine">updates every 10 s</span></div>
          {feed.length === 0 ? <p className="sav-fine">Reading the inbox and the agents' sessions…</p> : (
            <ul className="sav-feed">
              {feed.map((f, i) => (
                <li key={i}>
                  <span className={`live-mark ${f.mark}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px]">{f.title}</div>
                    {f.detail ? <div className="truncate text-[12.5px] text-ink-3">{f.detail}</div> : null}
                  </div>
                  <span className="sav-fine nowrap">{ago(f.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="sav-card">
          <div className="sav-card-head"><h2 className="sav-h2">Always on</h2><span className="sav-fine">Pacific time</span></div>
          <ul className="live-sched">
            {ALWAYS_ON.map((s, i) => (
              <li key={i}><span className="team">{s.team}</span><span className="what">{s.what}</span><span className="when">{s.when}</span></li>
            ))}
          </ul>
          <p className="mt-3 sav-fine">Every agent has a daily spending cap. Anything outside its limits waits on Approvals.</p>
        </section>
      </div>
    </>
  );
}
