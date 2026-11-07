import { AlertTriangle, Check, CheckCircle2, Circle, ExternalLink, FileText, ShieldAlert, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { apiMessage, apiSend, useApi } from "../api";
import { KindChip, PageHeader, StageChip, StatusChip } from "../components/kit";
import type { Client, Post, PostStatus } from "../data";
import { argRows, waitingOn, type PlatformSession } from "../platform";
import { dayOneLabel, type ContextReply } from "./Home";
import type { AuditSnapshot } from "./ProductAudit";

interface CrawlCheck { name: string; ok: boolean; detail: string }

const readCrawlChecks = async (): Promise<CrawlCheck[]> => {
  const checks = await Promise.all([
    fetch("/robots.txt").then(async (res) => ({ name: "robots.txt", ok: res.ok && (await res.text()).includes("Sitemap:"), detail: `${res.status} ${res.headers.get("content-type") ?? ""}` })),
    fetch("/sitemap.xml").then(async (res) => ({ name: "sitemap.xml", ok: res.ok && (await res.text()).includes("<urlset"), detail: `${res.status} ${res.headers.get("content-type") ?? ""}` })),
    fetch("/llms.txt").then(async (res) => ({ name: "llms.txt", ok: res.ok && (await res.text()).startsWith("# "), detail: `${res.status} ${res.headers.get("content-type") ?? ""}` })),
  ]);
  return checks;
};

const Card = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="panel p-4"><h2 className="text-sm font-semibold">{title}</h2><div className="mt-3">{children}</div></section>
);

const CheckRow = ({ done, children }: { done: boolean; children: ReactNode }) => (
  <div className="flex items-start gap-2 py-1.5 text-sm">
    {done ? <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-700" size={16} /> : <Circle className="mt-0.5 shrink-0 text-ink-3" size={16} />}
    <span>{children}</span>
  </div>
);

/** One launch desk: everything that still needs a human decision, with the source material beside it. */
export function LaunchReview() {
  const audit = useApi<AuditSnapshot>("/product-audit");
  const context = useApi<ContextReply>("/context");
  const clientsApi = useApi<Client[]>("/clients");
  const postsApi = useApi<Post[]>("/posts");
  const sessionsApi = useApi<{ data?: PlatformSession[] }>("/sessions?status=idle");
  const [crawl, setCrawl] = useState<CrawlCheck[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  useEffect(() => { void readCrawlChecks().then(setCrawl).catch(() => setCrawl([])); }, []);
  const prospects = (clientsApi.data ?? []).filter((client) => client.stage === "lead" || client.stage === "proposal");
  const drafts = (postsApi.data ?? []).filter((post) => post.status === "pending" || post.status === "ready");
  const names = useMemo(() => new Map((context.data?.team ?? []).map((agent) => [agent.id, agent.name])), [context.data]);
  const approvals = waitingOn(sessionsApi.data?.data ?? [], names);

  const movePost = async (post: Post, status: PostStatus) => {
    setBusy(post.id); setError(null);
    try {
      const rejectionReason = reasons[post.id]?.trim() ?? "";
      const updated = await apiSend<Post>("PATCH", `/posts/${post.id}`, {
        status,
        ...(status === "rejected" && rejectionReason ? { rejectedReason: rejectionReason } : {}),
      });
      postsApi.setData((postsApi.data ?? []).map((row) => row.id === post.id ? updated : row));
    } catch (err: unknown) { setError(apiMessage(err)); } finally { setBusy(null); }
  };

  const qualify = async (client: Client) => {
    setBusy(client.id); setError(null);
    try {
      const updated = await apiSend<Client>("POST", `/clients/${client.id}/advance`);
      clientsApi.setData((clientsApi.data ?? []).map((row) => row.id === client.id ? updated : row));
    } catch (err: unknown) { setError(apiMessage(err)); } finally { setBusy(null); }
  };

  const connections = audit.data?.identity?.connections ?? [];
  const hasSearchConsole = connections.some((row) => /search.?console/i.test(row.connector) && row.status === "connected");
  const hasAnalytics = connections.some((row) => /analytics/i.test(row.connector) && row.status === "connected");
  const deploymentReady = audit.data !== null && audit.data.agents.length === audit.data.expected_agents && audit.data.deployments.length >= 5;
  const crawlReady = crawl !== null && crawl.length === 3 && crawl.every((row) => row.ok);
  const manualCount = prospects.length + drafts.length + approvals.length + Number(!hasSearchConsole) + Number(!hasAnalytics) + Number(!crawlReady);

  return (
    <div className="pane-in">
      <PageHeader
        title="Launch review"
        subtitle="The human decisions between generated work and a running agency. Read the work here; nothing is approved by its title alone."
        actions={<span className={`chip ${manualCount === 0 ? "chip-credit" : "chip-absent"}`}>{manualCount} to review</span>}
      />
      {error ? <p className="notice-fail mb-4">{error}</p> : null}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Public site"><CheckRow done={(audit.data?.content.posted_blog_articles ?? 0) > 0}>Live article published</CheckRow><CheckRow done={crawlReady}>robots, sitemap and llms.txt valid</CheckRow></Card>
        <Card title="Agency deployment"><CheckRow done={deploymentReady}>{audit.data ? `${audit.data.agents.length}/${audit.data.expected_agents} agents · ${audit.data.deployments.length} schedules` : "Reading agents and schedules…"}</CheckRow></Card>
        <Card title="Measurement"><CheckRow done={hasSearchConsole}>Google Search Console connected</CheckRow><CheckRow done={hasAnalytics}>Google Analytics connected</CheckRow></Card>
        <Card title="Manual queue"><CheckRow done={approvals.length === 0}>{approvals.length} agent approval or question</CheckRow><CheckRow done={drafts.length === 0}>{drafts.length} content draft</CheckRow></Card>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Technical SEO verification">
          {crawl === null ? <p className="absence">Checking the public files…</p> : crawl.map((row) => <CheckRow key={row.name} done={row.ok}><span className="font-mono">/{row.name}</span> · {row.detail}</CheckRow>)}
          <a href="/" target="_blank" className="btn btn-ghost btn-sm mt-3" rel="noreferrer">Open public site <ExternalLink size={13} /></a>
        </Card>
        <Card title="Day-one deployment">
          {context.error ? <p className="text-sm text-fail">{context.error}</p> : context.data === null ? <p className="absence">Reading the install report…</p> : context.data.intake.length === 0 ? <p className="absence">No intake sessions were reported.</p> : (
            <div className="list">{context.data.intake.map((line) => <div className="flex items-center justify-between px-3 py-2 text-sm" key={line.name}><span>{line.name}</span><span className="text-xs text-ink-2">{dayOneLabel(line)}</span></div>)}</div>
          )}
          <Link to="/agents" className="btn btn-ghost btn-sm mt-3">Inspect agents and schedules</Link>
        </Card>
      </section>

      <section className="panel mt-4 overflow-hidden">
        <header className="flex items-start justify-between gap-3 border-b border-line p-4">
          <div><div className="flex items-center gap-2"><Users size={17} /><h2 className="text-sm font-semibold">Prospects and outreach drafts</h2></div><p className="mt-1 text-xs text-ink-2">This is the first prospect list. Every note is shown because agents file outreach copy and why-now evidence on the company record.</p></div>
          <Link to="/crm" className="btn btn-ghost btn-sm shrink-0">Open CRM</Link>
        </header>
        {clientsApi.data === null ? <p className="absence m-4">{clientsApi.error ?? "Reading the CRM…"}</p> : prospects.length === 0 ? <p className="absence m-4">No prospects were filed. Check the sales intake status above before rerunning it.</p> : prospects.map((client) => (
          <article className="border-b border-line p-4 last:border-b-0" key={client.id}>
            <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="font-medium">{client.name}</h3><StageChip stage={client.stage} /></div><p className="mt-1 text-xs text-ink-2">{client.domain} · {client.contact.name} · {client.contact.role} · <a className="underline" href={`mailto:${client.contact.email}`}>{client.contact.email}</a></p></div>{client.stage === "lead" ? <button disabled={busy !== null} className="btn btn-primary btn-sm" onClick={() => void qualify(client)}><Check size={14} /> Qualify for proposal</button> : null}</div>
            {client.notes.length === 0 ? <p className="absence mt-3">No why-now evidence or outreach draft was filed. Do not approve this prospect yet.</p> : <div className="mt-3 space-y-2">{client.notes.map((note, index) => <div className="whitespace-pre-wrap rounded-lg border border-line bg-ground p-3 text-sm" key={`${client.id}-${index}`}><span className="mb-1 block font-mono text-[11px] text-ink-3">NOTE {index + 1}</span>{note}</div>)}</div>}
            {client.nextAction ? <p className="mt-2 text-xs text-ink-2">Next action: {client.nextAction}</p> : null}
          </article>
        ))}
      </section>

      <section className="panel mt-4 overflow-hidden">
        <header className="border-b border-line p-4"><div className="flex items-center gap-2"><FileText size={17} /><h2 className="text-sm font-semibold">Content requiring review</h2></div><p className="mt-1 text-xs text-ink-2">Approve only after reading the complete body. Approval clears publication; it does not publish immediately.</p></header>
        {postsApi.data === null ? <p className="absence m-4">{postsApi.error ?? "Reading content…"}</p> : drafts.length === 0 ? <p className="absence m-4">No pending or ready content.</p> : drafts.map((post) => (
          <article className="border-b border-line p-4 last:border-b-0" key={post.id}>
            <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{post.title}</h3><StatusChip status={post.status} /><KindChip kind={post.kind} channel={post.channel} /></div>
            <p className="mt-2 text-sm text-ink-2">{post.summary}</p>
            {post.body ? <div className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-ground p-3 text-sm leading-6">{post.body}</div> : <p className="absence mt-3">No complete body was filed. Reject it or ask the writer to finish it.</p>}
            <label className="field-label mt-3 block" htmlFor={`reason-${post.id}`}>Rejection reason (optional)</label>
            <input id={`reason-${post.id}`} className="input" value={reasons[post.id] ?? ""} onChange={(event) => setReasons((all) => ({ ...all, [post.id]: event.target.value }))} placeholder="What the agent should fix" />
            <div className="mt-3 flex gap-2"><button className="btn btn-primary btn-sm" disabled={busy !== null || !post.body} onClick={() => void movePost(post, "approved")}><Check size={14} /> Approve</button><button className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => void movePost(post, "rejected")}><X size={14} /> Reject</button></div>
          </article>
        ))}
      </section>

      <section className="panel mt-4 overflow-hidden">
        <header className="flex items-start justify-between gap-3 border-b border-line p-4"><div><div className="flex items-center gap-2"><ShieldAlert size={17} /><h2 className="text-sm font-semibold">Agent actions requiring approval</h2></div><p className="mt-1 text-xs text-ink-2">Email sends and other outward actions appear here with their exact arguments. Decide them on the dedicated approval screen.</p></div><Link to="/approvals" className="btn btn-ghost btn-sm shrink-0">Open approvals</Link></header>
        {sessionsApi.error ? <p className="m-4 text-sm text-fail">{sessionsApi.error}</p> : sessionsApi.data === null ? <p className="absence m-4">Reading parked sessions…</p> : approvals.length === 0 ? <p className="absence m-4">Nothing is waiting for approval.</p> : approvals.map((row) => (
          <div className="border-b border-line p-4 last:border-b-0" key={`${row.session.id}:${row.action.tool_call_id}`}><p className="text-sm"><span className="font-medium">{row.agent}</span> wants to call <span className="chip chip-plain font-mono">{row.action.name}</span></p><dl className="mt-2">{argRows(row.action.args).map((arg) => <div className="flex gap-3 py-1 text-xs" key={arg.key}><dt className="w-28 shrink-0 font-mono text-ink-3">{arg.key}</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{arg.value}</dd></div>)}</dl></div>
        ))}
      </section>

      {(!hasSearchConsole || !hasAnalytics) ? <div className="notice-fail mt-4 flex items-start gap-2"><AlertTriangle className="mt-0.5 shrink-0" size={16} /><span>SEO &amp; GEO measurement is still limited. Connect {!hasSearchConsole ? "Google Search Console" : ""}{!hasSearchConsole && !hasAnalytics ? " and " : ""}{!hasAnalytics ? "Google Analytics" : ""} to the Founder Frame identity before treating ranking or traffic reports as verified.</span></div> : null}
    </div>
  );
}
