import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { useApi } from "../api";
import { PageHead, Quiet, ShopName, StatusPill, useLeads } from "../components/sav";
import type { Agent } from "../data";
import { agentLabel, ago, leadPath, mailFor, mailKind, mailToday, STATUSES, type Funnel, type Lead, type MailMessage } from "../leads";
import { stopLabel, waitingOn, type PlatformSession } from "../platform";

/**
 * The first screen: how far every shop has got, what the crew did today, and who is working now.
 * Every pipeline number is `funnelOf` (`src/leads.ts`), the same count the leads table and the
 * rail print; the inbox is read without our own test traffic. A source that cannot be read says
 * so in its own card and the rest of the page still stands.
 */

const FUNNEL: { label: string; key: keyof Funnel; reached: (typeof STATUSES)[number] }[] = [
  { label: "Leads", key: "shops", reached: "researched" },
  { label: "Emailed", key: "emailed", reached: "emailed" },
  { label: "Replied", key: "replied", reached: "replied" },
  { label: "Demos sent", key: "demo", reached: "demo" },
  { label: "Free weeks", key: "free_week", reached: "free_week" },
  { label: "Paying", key: "paying", reached: "paying" },
];

interface FeedItem {
  at: string;
  mark: "sent" | "received" | "run" | "ok" | "bad";
  title: React.ReactNode;
  detail?: string;
}

function shopFor(m: MailMessage, leads: readonly Lead[]): Lead | undefined {
  return leads.find((l) => mailFor(l.client, [m]).length > 0);
}

/** A run that finished says nothing on its own; only one still going, or one that stopped short, is news. */
export function runNews(s: PlatformSession): string | null {
  if (s.status === "running" || s.status === "queued") return "still going";
  if (!s.stop_reason || s.stop_reason === "end_turn") return null;
  return stopLabel(s);
}

export function Overview() {
  const { leads, funnel, error, mail, messages, mailError } = useLeads();
  const sessions = useApi<{ data?: PlatformSession[] }>("/sessions");
  const roster = useApi<{ data?: Agent[] }>("/agents");
  const names = useMemo(() => new Map((roster.data?.data ?? []).map((a) => [a.id, a.name])), [roster.data]);
  const all = useMemo(() => leads ?? [], [leads]);

  const today = mailToday(messages);
  const demosBuilt = all.filter((l) => l.demoReady).length;
  const replied = all.filter((l) => l.status === "replied").sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));

  const rows = useMemo(() => sessions.data?.data ?? [], [sessions.data]);
  const running = rows.filter((s) => s.status === "running" || s.status === "queued");
  const waiting = waitingOn(rows, names).length;

  const feed = useMemo<FeedItem[]>(() => {
    const out: FeedItem[] = [];
    for (const m of messages.slice(0, 40)) {
      const shop = shopFor(m, all);
      const kind = mailKind(m);
      const name = shop ? <Link to={leadPath(shop.client)}><ShopName client={shop.client} /></Link> : <span>{m.counterpart}</span>;
      if (kind === "bounce") {
        out.push({ at: m.at, mark: "bad", title: shop ? <>Email to {name} bounced</> : <>An email bounced</> });
      } else if (m.direction === "sent") {
        out.push({ at: m.at, mark: "sent", title: <>Emailed {name}</>, detail: `“${m.subject}”` });
      } else if (kind === "auto") {
        out.push({ at: m.at, mark: "received", title: <>{name} sent an automatic reply</> });
      } else {
        out.push({ at: m.at, mark: "received", title: <>{name} wrote back</>, detail: m.preview || m.subject });
      }
    }
    for (const s of rows.slice(0, 40)) {
      const news = runNews(s);
      if (!s.created_at || news === null) continue;
      const who = agentLabel(names.get(s.agent_id));
      const live = s.status === "running" || s.status === "queued";
      out.push({ at: s.created_at, mark: live ? "ok" : "run", title: <>{who} {live ? "started working" : "stopped"}</>, detail: news });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 14);
  }, [messages, rows, names, all]);

  return (
    <div className="pane-in">
      <PageHead
        title="Overview"
        sub={funnel === null ? "How far every shop has got, and what the crew is doing." : `${funnel.shops} shops in the pipeline. ${today.sent === 0 ? "No emails out yet today" : `${today.sent} ${today.sent === 1 ? "email" : "emails"} sent today`}${today.replies > 0 ? `, ${today.replies} ${today.replies === 1 ? "reply" : "replies"} in` : ""}.`}
        actions={<Link to="/leads" className="btn btn-ghost">All leads <ArrowRight size={15} strokeWidth={1.6} /></Link>}
      />

      <section className="sav-card flush mb-[18px]" aria-label="Funnel">
        {funnel === null ? (
          <p className="p-6 sav-sub">{error ? `The CRM could not be read: ${error}.` : "Counting the pipeline…"}</p>
        ) : (
          <div className="sav-funnel">
            {FUNNEL.map((step) => {
              const n = funnel[step.key];
              const top = Math.max(funnel.shops, 1);
              return (
                <Link key={step.key} to={step.key === "shops" ? "/leads" : `/leads?reached=${step.reached}`}>
                  <div className="n num">{n}</div>
                  <div className="lab">
                    {step.label}
                    {step.key === "emailed" && funnel.bounced > 0 ? <span className="text-ink-3"> · {funnel.bounced} bounced</span> : null}
                  </div>
                  <div className="bar"><i style={{ width: `${Math.max((n / top) * 100, n > 0 ? 3 : 0)}%` }} /></div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <div className="sav-stats mb-[18px]">
        <div className="sav-stat"><div className="n num">{mail?.configured === false ? "—" : today.sent}</div><div className="lab">Emails sent today</div></div>
        <div className="sav-stat"><div className="n num">{mail?.configured === false ? "—" : today.replies}</div><div className="lab">Replies today</div></div>
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
                      <Link to={leadPath(l.client)}><ShopName client={l.client} /></Link>
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
