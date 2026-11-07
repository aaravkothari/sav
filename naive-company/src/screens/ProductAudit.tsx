import { AlertTriangle, CheckCircle2, Circle, ExternalLink, ShieldCheck } from "lucide-react";
import { useApi } from "../api";
import { PageHeader } from "../components/kit";

export interface AuditSnapshot {
  project: string;
  observed_at: string;
  expected_agents: number;
  agents: { id: string; name: string }[];
  deployments: unknown[];
  sessions: { id: string; agent_id: string; status: string; stop_reason: string | null; pending_actions?: unknown[] }[];
  context: { intake: { session: { waiting: boolean } | null }[] };
  identity: { emails: unknown[]; domains: unknown[]; connections: { connector: string; status: string }[] } | null;
  organization_domains: unknown[];
  public_site: {
    company: string;
    contact_email: string;
    placeholder_email: boolean;
    generic_company: boolean;
    pricing_without_answer: boolean;
    prices: string[];
  };
  content: {
    total: number;
    posted_blog_articles: number;
    draft_blog_articles: number;
    ad_plans: number;
    approved_ad_plans: number;
  };
  crm: {
    records: number;
    prospects: number;
    working_notes: number;
    internal_records: number;
    named_contacts: number;
    addressed_contacts: number;
  };
  setup_has_paste_artifacts: boolean;
}

const changes = [
  ["Safe first publish", "Fresh installs now show no invented price, contract, timeline, proof or placeholder inbox."],
  ["Complete setup identity", "SEO & GEO setup now collects public agency name, verified inbox and pricing posture before delivery."],
  ["Public Insights feed", "Posted blog articles have a privacy-filtered public API and render on the landing page."],
  ["Blog publishing fix", "A blog post publishes to the app feed instead of being sent to the social-post primitive."],
  ["Public-claims gate", "Articles with placeholders, unsupported client/timeline/term claims, or unsourced metrics are blocked before publication."],
  ["Paid-media planner", "An eighth, read-only agent creates evidence-backed plans and has no campaign mutation or spend authority."],
  ["Integration-aware planning", "Unavailable ad channels must be labeled recommendation-only and budgets remain operator-selectable."],
  ["Typed readiness metrics", "Prospects, named contacts, addressed contacts, drafts and approved plans are counted separately."],
  ["Concurrent store safety", "The deployed store serializes writes under a database row lock, preventing last-write-wins data loss."],
] as const;

function Card({ name, ready, evidence }: { name: string; ready: boolean; evidence: string }) {
  return (
    <article className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold">{name}</h3>
        <span className={`chip ${ready ? "chip-credit" : "chip-fail"}`}>{ready ? "READY" : "OPEN"}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-ink-2">{evidence}</p>
    </article>
  );
}

export function ProductAudit() {
  const { data, error } = useApi<AuditSnapshot>("/product-audit");
  if (error) return <div className="pane-in"><PageHeader title="Product audit" subtitle="Live release evidence." /><p className="notice-fail">{error}</p></div>;
  if (!data) return <div className="pane-in"><PageHeader title="Product audit" subtitle="Loading live release evidence…" /></div>;

  const waiting = data.sessions.filter((session) => (session.pending_actions?.length ?? 0) > 0).length +
    data.context.intake.filter((line) => line.session?.waiting).length;
  const mailbox = (data.identity?.emails.length ?? 0) > 0 && data.organization_domains.length > 0;
  const site = !data.public_site.generic_company && !data.public_site.placeholder_email && !data.public_site.pricing_without_answer;
  const landing = site && data.content.posted_blog_articles > 0;
  const sales = data.crm.prospects > 0 && data.crm.named_contacts === data.crm.prospects && data.crm.addressed_contacts === data.crm.prospects;
  const dashboard = data.agents.length === data.expected_agents && data.deployments.length > 0;
  const marketing = data.content.approved_ad_plans > 0;
  const ready = mailbox && landing && sales && dashboard && marketing && waiting === 0 && data.crm.internal_records <= 1 && !data.setup_has_paste_artifacts;

  const gaps = [
    ["Verify and personalize the public site", site, `${data.public_site.company}; ${data.public_site.contact_email || "no verified contact"}; ${data.public_site.prices.join(", ")}.`],
    ["Publish one reviewed SEO & GEO article", data.content.posted_blog_articles > 0, `${data.content.posted_blog_articles} posted; ${data.content.draft_blog_articles} drafts.`],
    ["Finish contact-ready prospect coverage", sales, `${data.crm.prospects} prospects; ${data.crm.named_contacts} named; ${data.crm.addressed_contacts} addressed.`],
    ["Approve the paid-media proposal", marketing, `${data.content.ad_plans} filed; ${data.content.approved_ad_plans} approved.`],
    ["Deduplicate internal agency records", data.crm.internal_records <= 1, `${data.crm.internal_records} name-only internal records.`],
    ["Clear operator questions and approvals", waiting === 0, `${waiting} parked action${waiting === 1 ? "" : "s"}.`],
    ["Normalize setup answers", !data.setup_has_paste_artifacts, data.setup_has_paste_artifacts ? "Pasted Markdown markers remain in project context." : "No paste artifacts detected."],
  ] as const;

  return (
    <div className="pane-in">
      <PageHeader
        title="Naive product audit"
        subtitle={`Live acceptance evidence for ${data.project}. Observed ${new Date(data.observed_at).toLocaleString()}.`}
        actions={<span className={`chip ${ready ? "chip-credit" : "chip-fail"}`}>{ready ? "READY" : "LAUNCH BLOCKED"}</span>}
      />

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card name="Landing page + blog" ready={landing} evidence={`${data.content.posted_blog_articles} public article${data.content.posted_blog_articles === 1 ? "" : "s"}; site identity ${site ? "verified" : "not accepted"}.`} />
        <Card name="Sales handoff" ready={sales} evidence={`${data.crm.prospects} companies; ${data.crm.named_contacts} named and ${data.crm.addressed_contacts} addressed contacts.`} />
        <Card name="Management dashboard" ready={dashboard} evidence={`${data.agents.length}/${data.expected_agents} agents and ${data.deployments.length} schedules observed.`} />
        <Card name="Paid-media plan" ready={marketing} evidence={`${data.content.ad_plans} plans filed; ${data.content.approved_ad_plans} operator-approved.`} />
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface">
        <div className="border-b border-line p-4">
          <div className="flex items-center gap-2"><AlertTriangle size={17} /><h2 className="text-sm font-semibold">Open acceptance gaps</h2></div>
          <p className="mt-1 text-xs text-ink-2">A row existing is not completion. Each item closes only when its live evidence passes.</p>
        </div>
        {gaps.map(([name, done, evidence], index) => (
          <div key={name} className={`flex items-start gap-3 p-4 ${index ? "border-t border-line" : ""}`}>
            {done ? <CheckCircle2 className="mt-0.5 text-emerald-700" size={18} /> : <Circle className="mt-0.5 text-ink-3" size={18} />}
            <div><p className="text-sm font-medium">{name}</p><p className="mt-1 text-xs leading-5 text-ink-2">{evidence}</p></div>
          </div>
        ))}
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-2"><ShieldCheck size={17} /><h2 className="text-sm font-semibold">Changes in this hardening release</h2></div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {changes.map(([name, detail]) => <div className="rounded-lg border border-line p-3" key={name}><p className="text-sm font-medium">{name}</p><p className="mt-1 text-xs leading-5 text-ink-2">{detail}</p></div>)}
        </div>
        <a className="mt-4 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4" href="https://github.com/usenaive/agency-blueprint" target="_blank" rel="noreferrer">Review source <ExternalLink size={12} /></a>
      </section>
    </div>
  );
}
