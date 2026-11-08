import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { useApi } from "../api";
import { PageHead, Quiet, StatusPill, useLeads } from "../components/sav";
import type { Agent } from "../data";
import { agentLabel, ago, mailFor, STATUSES, type Lead, type MailMessage } from "../leads";
import { waitingOn, type PlatformSession } from "../platform";

/**
 * The first screen: how far every shop has got, what the crew did today, and who is working now.
 * Everything is counted from the CRM's notes, the company inbox and the platform's sessions; a
 * source that cannot be read says so in its own card and the rest of the page still stands.
 */

const FUNNEL: { label: string; reached: (typeof STATUSES)[number] }[] = [
  { label: "Leads", reached: "researched" },
  { label: "Emailed", reached: "emailed" },
  { label: "Replied", reached: "replied" },
  { label: "Demos sent", reached: "demo" },
  { label: "Free weeks", reached: "free_week" },
  { label: "Paying", reached: "paying" },
];

const sameDay = (iso: string, now = new Date()) => new Date(iso).toDateString() === now.toDateString();

interface FeedItem {
  at: string;
  mark: "sent" | "received" | "run" | "ok";
  title: React.ReactNode;
  detail?: string;
}

function shopFor(m: MailMessage, leads: readonly Lead[]): Lead | undefined {
  return leads.find((l) => mailFor(l.client, [m]).length > 0);
}

export function Overview() {
  const { leads, error, mail, mailError } = useLeads();
  const sessions = useApi<{ data?: PlatformSession[] }>("/sessions");
  const roster = useApi<{ data?: Agent[] }>("/agents");
  const names = useMemo(() => new Map((roster.data?.data ?? []).map((a) => [a.id, a.name])), [roster.data]);
  const messages = mail?.messages ?? [];
  const all = leads ?? [];

  const reached = (i: number) => all.filter((l) => l.rank >= i && l.status !== "bounced").length;
  const sentToday = messages.filter((m) => m.direction === "sent" && sameDay(m.at)).length;
  const repliesToday = messages.filter((m) => m.direction === "received" && sameDay(m.at)).length;
  const demosBuilt = all.filter((l) => l.demoReady).length;
  const replied = all.filter((l) => l.status === "replied").sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));

  const rows = sessions.data?.data ?? [];
  const running = rows.filter((s) => s.status === "running" || s.status === "queued");
  const waiting = waitingOn(rows, names).length;

  const feed = useMemo<FeedItem[]>(() => {
    const out: FeedItem[] = [];
    for (const m of messages.slice(0, 40)) {
      const shop = shopFor(m, all);
      const name = shop ? <Link to={`/leads/${shop.client.id}`}>{shop.client.name}</Link> : <span>{m.counterpart}</span>;
      out.push(m.direction === "sent"
        ? { at: m.at, mark: "sent", title: <>Emailed {name}</>, detail: m.subject }
        : { at: m.at, mark: "received", title: <>{name} wrote back</>, detail: m.preview || m.subject });
    }
    for (const s of rows.slice(0, 40)) {
      const at = s.created_at;
      if (!at) continue;
      const who = agentLabel(names.get(s.agent_id));
      const live = s.status === "running" || s.status === "queued";
      out.push({ at, mark: live ? "ok" : "run", title: <>{who} {live ? "started working" : "ran"}</>, detail: live ? "still going" : undefined });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 14);
  }, [messages, rows, names, all]);

  return (
    <div className="pane-in">
      <PageHead
        title="Overview"
        sub={leads === null ? "How far every shop has got, and what the crew is doing." : `${all.length} shops in the pipeline. ${sentToday === 0 ? "No emails out yet today" : `${sentToday} ${sentToday === 1 ? "email" : "emails"} sent today`}${repliesToday > 0 ? `, ${repliesToday} ${repliesToday === 1 ? "reply" : "replies"} in` : ""}.`}
        actions={<Link to="/leads" className="btn btn-ghost">All leads <ArrowRight size={15} strokeWidth={1.6} /></Link>}
      />

      <section className="sav-card flush mb-[18px]" aria-label="Funnel">
        {leads === null ? (
          <p className="p-6 sav-sub">{error ? `The CRM could not be read: ${error}.` : "Counting the pipeline…"}</p>
        ) : (
          <div className="sav-funnel">
            {FUNNEL.map((step, i) => {
              const n = reached(i);
              const top = Math.max(reached(0), 1);
              return (
                <Link key={step.reached} to={`/leads?reached=${step.reached}`}>
                  <div className="n num">{n}</div>
                  <div className="lab">{step.label}</div>
                  <div className="bar"><i style={{ width: `${Math.max((n / top) * 100, n > 0 ? 3 : 0)}%` }} /></div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <div className="sav-stats mb-[18px]">
        <div className="sav-stat"><div className="n num">{mail?.configured === false ? "—" : sentToday}</div><div className="lab">Emails sent today</div></div>
        <div className="sav-stat"><div className="n num">{mail?.configured === false ? "—" : repliesToday}</div><div className="lab">Replies today</div></div>
        <div className="sav-stat"><div className="n num">{leads === null ? "—" : demosBuilt}</div><div className="lab">Demo receptionists built</div></div>
      </div>

      <div className="sav-grid-2">
        <section className="sav-card">
          <div className="sav-card-head"><h2 className="sav-h2">Latest activity</h2></div>
          {feed.length === 0 ? (
            <Quiet>
              {mailError ?? sessions.error ?? (mail === null && sessions.data === null ? "Reading the inbox and the crew's runs…" : "Nothing has happened yet.")}
            </Quiet>
          ) : (
            <ul className="sav-feed">
              {feed.map((f, i) => (
                <li key={i}>
                  <span className={`sav-mark ${f.mark}`} aria-hidden="true" />
                  <span className="what">
                    {f.title}
                    {f.detail ? <small>{f.detail}</small> : null}
                  </span>
                  <span className="when">{ago(f.at)}</span>
                </li>
              ))}
            </ul>
          )}
          {mail?.configured === false ? <p className="mt-3 sav-fine">The company inbox is not connected on this server, so emails are not listed.</p> : null}
        </section>

        <div className="sav-stack">
          <section className="sav-card">
            <div className="sav-card-head">
              <h2 className="sav-h2">Working now</h2>
              {waiting > 0 ? <Link to="/approvals" className="sav-link text-[14px]">{waiting} waiting on you</Link> : null}
            </div>
            {sessions.data === null ? (
              <Quiet>{sessions.error ? (sessions.error.startsWith("not configured") ? "The platform key is not set on this server." : sessions.error) : "Asking the platform…"}</Quiet>
            ) : running.length === 0 ? (
              <div className="sav-working">
                <span className="sav-pulse idle" aria-hidden="true" />
                <span className="sav-sub">
                  Nobody is mid-task.
                  {rows[0]?.created_at ? ` ${agentLabel(names.get(rows[0].agent_id))} last ran ${ago(rows[0].created_at)}.` : ""}
                </span>
              </div>
            ) : (
              running.map((s) => (
                <div key={s.id} className="sav-working">
                  <span className="sav-pulse" aria-hidden="true" />
                  <span className="font-bold">{agentLabel(names.get(s.agent_id))}</span>
                  <span className="ml-auto sav-fine">{s.created_at ? `started ${ago(s.created_at)}` : "working"}</span>
                </div>
              ))
            )}
          </section>

          <section className="sav-card">
            <div className="sav-card-head">
              <h2 className="sav-h2">Wrote back</h2>
              {replied.length > 0 ? <Link to="/leads?status=replied" className="sav-link text-[14px]">See all</Link> : null}
            </div>
            {leads === null ? (
              <Quiet>Reading the CRM…</Quiet>
            ) : replied.length === 0 ? (
              <Quiet>No shop is waiting on an answer from us.</Quiet>
            ) : (
              <ul className="sav-feed">
                {replied.slice(0, 6).map((l) => (
                  <li key={l.client.id}>
                    <span className="what">
                      <Link to={`/leads/${l.client.id}`}>{l.client.name}</Link>
                      <small>{l.client.contact.name || l.client.contact.email}</small>
                    </span>
                    <span className="when"><StatusPill status={l.status} /></span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
