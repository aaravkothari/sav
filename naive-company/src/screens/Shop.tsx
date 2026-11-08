import { ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { apiMessage, apiSend, useApi } from "../api";
import { PageHead, Quiet, StatusPill, useLeads } from "../components/sav";
import { STAGE_LABEL } from "../components/kit";
import { nextStage, type Client } from "../data";
import { ago, type EventKind, type LeadEvent } from "../leads";

/**
 * One shop, start to finish: what the crew found, every email out and back, and the receptionist
 * built for it, with the exact prompt and first words callers hear. The receptionist and the
 * emails are read server-side (`server/shop-routes.ts`); this page never sees a machine id.
 */

interface ReceptionistReply {
  configured: boolean;
  receptionist?: {
    shop_name: string;
    version: number | null;
    versions: number | null;
    live: boolean;
    status: string | null;
    phone_number: string | null;
    system_prompt: string;
    first_message: string;
    hours: Record<string, string>;
    services: string[];
    policies: string[];
    demo_url: string | null;
  } | null;
  calls?: { at: string | null; duration_sec: number | null; outcome: string | null; summary: string; flags: string[]; ended_by: string | null }[];
  error?: string;
}

interface EmailsReply {
  configured: boolean;
  emails: { direction: "sent" | "received"; counterpart: string; subject: string; preview: string; text: string; at: string }[];
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

const OUTCOME: Record<string, string> = {
  appointment_request: "Asked for an appointment",
  callback: "Asked for a callback",
  info: "Asked a question",
  question: "Asked a question",
  hangup: "Hung up",
  voicemail: "Voicemail",
};
const FLAG: Record<string, string> = {
  quoted_price: "quoted a price",
  confirmed_appointment: "promised a booking",
  too_long: "ran long",
};

const STEP_KIND: Partial<Record<EventKind, string>> = {
  research: "k-step",
  demo_built: "k-step",
  emailed: "k-mail",
  reply_sent: "k-mail",
  onboarding: "k-mail",
  drafted: "",
  replied: "k-reply",
  said_yes: "k-good",
  free_week: "k-good",
  live: "k-good",
  config: "k-step",
  paid: "k-good",
  bounced: "k-bad",
  blocked: "k-bad",
};
const LETTER: ReadonlySet<EventKind> = new Set(["emailed", "drafted", "reply_sent", "replied", "said_yes"]);

const minutes = (sec: number | null) => (sec === null ? "" : sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`);

/** Links in a note, named for what they are rather than printed as URLs; owner portal links are dropped. */
function Rich({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s"')]+/g)) {
    parts.push(text.slice(last, m.index));
    const url = m[0].replace(/[.,;]+$/, "");
    if (/\/portal\//.test(url)) parts.push("(owner portal)");
    else parts.push(
      <a key={m.index} href={url} target="_blank" rel="noreferrer" className="sav-link">
        {/\/demo\//.test(url) ? (/page:\s*$/i.test(text.slice(0, m.index)) ? "open it" : "the demo page") : new URL(url).hostname.replace(/^www\./, "")}
      </a>,
    );
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function Letter({ children, meta, incoming }: { children: string; meta?: ReactNode; incoming?: boolean }) {
  const long = children.length > 650;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={`sav-letter${incoming ? " in" : ""}${long && !open ? " clamp" : ""}`}>
        {meta ? <span className="meta">{meta}</span> : null}
        <Rich text={children} />
      </div>
      {long ? <button type="button" className="sav-more" onClick={() => setOpen(!open)}>{open ? "Show less" : "Read all of it"}</button> : null}
    </>
  );
}

function Timeline({ events }: { events: LeadEvent[] }) {
  if (events.length === 0) return <Quiet>Nothing has been filed on this shop yet.</Quiet>;
  return (
    <ol className="sav-timeline">
      {events.map((e) => (
        <li key={e.index} className={STEP_KIND[e.kind] ?? ""}>
          <div className="t-head">
            <span className="t-title">{e.title}</span>
            {e.at ? <span className="t-when">{ago(e.at)}</span> : null}
          </div>
          {e.body === "" ? null : LETTER.has(e.kind) ? (
            <Letter incoming={e.kind === "replied" || e.kind === "said_yes"}>{e.body}</Letter>
          ) : (
            <div className="t-body"><Rich text={e.body} /></div>
          )}
        </li>
      ))}
    </ol>
  );
}

function Emails({ id }: { id: string }) {
  const { data, error } = useApi<EmailsReply>(`/shops/${id}/emails`);
  if (data?.configured === false) return null;
  return (
    <section className="sav-card">
      <div className="sav-card-head">
        <h2 className="sav-h2">Emails</h2>
        {data && data.emails.length > 0 ? <span className="sav-fine">{data.emails.length} in the company inbox</span> : null}
      </div>
      {data === null ? (
        <Quiet>{error ?? "Reading the inbox…"}</Quiet>
      ) : data.emails.length === 0 ? (
        <Quiet>No email to or from this shop yet.</Quiet>
      ) : (
        <div className="flex flex-col gap-4">
          {[...data.emails].reverse().map((m, i) => (
            <div key={i}>
              <Letter
                incoming={m.direction === "received"}
                meta={<>{m.direction === "sent" ? `To ${m.counterpart}` : `From ${m.counterpart}`} · {ago(m.at)}<br /><strong className="font-bold text-ink">{m.subject}</strong></>}
              >
                {(m.text || m.preview).trim()}
              </Letter>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Receptionist({ id }: { id: string }) {
  const { data, error } = useApi<ReceptionistReply>(`/shops/${id}/receptionist`);
  const [full, setFull] = useState(false);
  const r = data?.receptionist;
  return (
    <section className="sav-card">
      <div className="sav-card-head">
        <h2 className="sav-h2">Receptionist</h2>
        {r ? (
          <span className="flex items-center gap-2">
            {r.live ? <span className="sav-ok">Live</span> : <span className="sav-preview">Preview</span>}
            {r.version !== null ? <span className="sav-fine">Version {r.version}</span> : null}
          </span>
        ) : null}
      </div>
      {data === null ? (
        <Quiet>{error ?? "Asking the receptionist service…"}</Quiet>
      ) : !data.configured ? (
        <Quiet>The receptionist service is not connected on this server (set AUTOOPS_VOICE_TOKEN).</Quiet>
      ) : !r ? (
        <Quiet>{data.error ?? "No receptionist has been built for this shop yet."}</Quiet>
      ) : (
        <div className="flex flex-col gap-5">
          <p className="sav-sub">
            {r.live
              ? `Answering the shop's calls${r.phone_number ? ` on ${r.phone_number}` : ""}.`
              : "A preview the owner can call from the demo page. It says so in its first words and books nothing."}
            {r.demo_url ? <> <a className="sav-link inline-flex items-center gap-1" href={r.demo_url} target="_blank" rel="noreferrer">Open the demo page <ExternalLink size={13} /></a></> : null}
          </p>

          <div>
            <div className="sav-cap mb-2">First thing a caller hears</div>
            <div className="sav-bubble"><span className="who">Receptionist</span>{r.first_message || "—"}</div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <div className="sav-cap mb-2">Hours</div>
              <div className="sav-hours">
                {DAYS.filter((d) => r.hours[d] !== undefined).map((d) => (
                  <div key={d} className="contents">
                    <span className="text-ink-3">{DAY_LABEL[d]}</span>
                    <span className={/closed/i.test(r.hours[d]!) ? "closed" : ""}>{r.hours[d]!.replace(/-/g, " – ")}</span>
                  </div>
                ))}
                {Object.keys(r.hours).length === 0 ? <span className="sav-fine col-span-2">Not given</span> : null}
              </div>
            </div>
            <div>
              <div className="sav-cap mb-2">Services</div>
              <div className="flex flex-wrap gap-1.5">
                {r.services.length === 0 ? <span className="sav-fine">Not given</span> : r.services.map((s) => <span key={s} className="sav-tag plain">{s}</span>)}
              </div>
              <div className="sav-cap mb-2 mt-4">Rules</div>
              <ul className="list-disc space-y-1 pl-4 text-[14px]">
                {r.policies.length === 0 ? <li className="sav-fine list-none -ml-4">None</li> : r.policies.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="sav-cap">System prompt</span>
              <button type="button" className="sav-more p-0" onClick={() => setFull(!full)}>{full ? "Collapse" : "Show all of it"}</button>
            </div>
            <div className="sav-prompt" style={full ? { maxHeight: "none" } : undefined}>{r.system_prompt}</div>
          </div>

          <div>
            <div className="sav-cap mb-1">Recent calls</div>
            {(data.calls ?? []).length === 0 ? (
              <Quiet>No calls yet.</Quiet>
            ) : (
              <ul className="sav-calls">
                {(data.calls ?? []).map((c, i) => (
                  <li key={i}>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-bold">{c.outcome ? OUTCOME[c.outcome] ?? c.outcome.replace(/_/g, " ") : "Call"}</span>
                      <span className="sav-fine">{[ago(c.at), minutes(c.duration_sec), c.ended_by ? `ended by the ${c.ended_by}` : ""].filter(Boolean).join(" · ")}</span>
                    </div>
                    {c.summary ? <p className="mt-1 text-[14px] text-ink-2">{c.summary}</p> : null}
                    {c.flags.filter((f) => FLAG[f]).length > 0 ? (
                      <div className="mt-1.5 flex gap-1.5">{c.flags.filter((f) => FLAG[f]).map((f) => <span key={f} className="sav-tag sand">{FLAG[f]}</span>)}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Details({ client, city, sector, phone, rating, onAdvance, advancing }: {
  client: Client; city: string | null; sector: string; phone: string | null; rating: string | null;
  onAdvance: () => void; advancing: boolean;
}) {
  const to = nextStage(client.stage);
  const rows: [string, ReactNode][] = [
    ["Contact", client.contact.name ? <>{client.contact.name}{client.contact.role ? <span className="text-ink-3">, {client.contact.role.toLowerCase()}</span> : null}</> : <span className="text-ink-3">Not found yet</span>],
    ["Email", client.contact.email ? <a className="sav-link" href={`mailto:${client.contact.email}`}>{client.contact.email}</a> : <span className="text-ink-3">Not found yet</span>],
    ["Phone", phone ?? <span className="text-ink-3">—</span>],
    ["Website", client.domain ? <a className="sav-link" href={`https://${client.domain}`} target="_blank" rel="noreferrer">{client.domain}</a> : "—"],
    ["Where", city ?? <span className="text-ink-3">—</span>],
    ["Sector", sector],
    ...(rating ? [["Reviews", rating] as [string, ReactNode]] : []),
    ["CRM stage", STAGE_LABEL[client.stage]],
  ];
  return (
    <section className="sav-card">
      <div className="sav-card-head"><h2 className="sav-h2">The shop</h2></div>
      <dl className="sav-facts">
        {rows.map(([k, v]) => (
          <div key={k} className="contents"><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      {client.nextAction ? (
        <div className="mt-5 border-t border-[var(--edge)] pt-4">
          <div className="sav-cap mb-1">Next step</div>
          <p className="text-[14.5px]">{client.nextAction}</p>
        </div>
      ) : null}
      {to !== null ? (
        <button type="button" className="btn btn-ghost btn-sm mt-4" disabled={advancing} onClick={onAdvance}>
          <ArrowRight size={14} strokeWidth={1.6} /> Move to {STAGE_LABEL[to].toLowerCase()}
        </button>
      ) : null}
      {to === "active" ? <p className="mt-2 sav-fine">Moving a shop to active sets up its own receptionist agent.</p> : null}
    </section>
  );
}

export function Shop() {
  const { id = "" } = useParams();
  const { leads, error, clients, setClients } = useLeads();
  const [advancing, setAdvancing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const lead = leads?.find((l) => l.client.id === id);

  const advance = async () => {
    if (!lead) return;
    const to = nextStage(lead.client.stage);
    if (to === null) return;
    setAdvancing(true);
    setActionError(null);
    try {
      const updated = to === "active"
        ? (await apiSend<{ client: Client }>("POST", `/clients/${id}/onboard`)).client
        : await apiSend<Client>("POST", `/clients/${id}/advance`);
      setClients((clients ?? []).map((c) => (c.id === id ? updated : c)));
    } catch (err: unknown) {
      setActionError(apiMessage(err));
    } finally {
      setAdvancing(false);
    }
  };

  const back = <Link to="/leads" className="sav-crumb"><ArrowLeft size={15} strokeWidth={1.6} /> All leads</Link>;
  if (leads === null) return <div className="pane-in">{back}<Quiet>{error ? `The CRM could not be read: ${error}.` : "Reading the CRM…"}</Quiet></div>;
  if (!lead) return <div className="pane-in">{back}<PageHead title="No such shop" sub="It may have been removed from the CRM." /></div>;

  const c = lead.client;
  return (
    <div className="pane-in">
      <PageHead
        title={c.name}
        sub={[lead.city, lead.sector, lead.lastAt ? `last activity ${ago(lead.lastAt)}` : null].filter(Boolean).join(" · ")}
        actions={<StatusPill status={lead.status} />}
      >
        {back}
      </PageHead>
      {actionError ? <p className="mb-4 text-[14px] text-fail">{actionError}</p> : null}
      <div className="sav-grid-shop">
        <div className="sav-stack">
          <section className="sav-card">
            <div className="sav-card-head"><h2 className="sav-h2">What happened</h2></div>
            <Timeline events={lead.events} />
          </section>
          <Emails id={id} />
        </div>
        <div className="sav-stack">
          <Receptionist id={id} />
          <Details client={c} city={lead.city} sector={lead.sector} phone={lead.phone} rating={lead.rating} onAdvance={() => void advance()} advancing={advancing} />
        </div>
      </div>
    </div>
  );
}
