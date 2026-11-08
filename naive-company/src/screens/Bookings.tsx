import { ArrowLeft, Check, Copy, ExternalLink, Sparkles } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { apiMessage, apiSend, useApi } from "../api";
import {
  bookingRows, buildPrepScript, CALL_STATUS_LABEL, callsOf, callTimeLabel, FEEDBACK_FIELDS, formatScriptNote, scriptNoteOf, scriptText,
  type BookingRow, type CallFeedback, type CallStatus, type OnboardingCall, type ScriptReceptionist, type ScriptSection,
} from "../bookings";
import { PageHead, Quiet, useLeads } from "../components/sav";
import type { Client } from "../data";
import { ago, findLead, leadPath, mailKind, shopName, type Lead, type MailMessage } from "../leads";

/**
 * Bookings, both ends of them.
 *
 *   Onboarding calls: calls between SAV and a shop, read from the CRM notes sales and onboarding
 *   file (`CALL REQUESTED:`, `CALL BOOKED:`). Each one opens a prep script and, once it is over, a
 *   form for what was learned (`src/bookings.ts`, `server/feedback.ts`).
 *
 *   Appointment requests: bookings the shops' receptionists took from callers, read server-side
 *   from the voice server (`server/booking-routes.ts`). First names and masked numbers only.
 */

type Tab = "calls" | "requests";

export function Bookings() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "requests" ? "requests" : "calls";
  const pick = (t: Tab) => {
    const next = new URLSearchParams();
    if (t === "requests") next.set("tab", "requests");
    setParams(next, { replace: true });
  };
  return (
    <div className="pane-in">
      <PageHead
        title="Bookings"
        sub={tab === "calls"
          ? "Onboarding calls between us and a shop. Open one for a prep script, and file what you learned when it is over."
          : "Appointments callers asked the shops' receptionists for. Shops confirm or decline them in their own portal."}
      />
      <div className="sav-tabbar" role="tablist" aria-label="Bookings">
        <button type="button" role="tab" aria-selected={tab === "calls"} onClick={() => pick("calls")}>Onboarding calls</button>
        <button type="button" role="tab" aria-selected={tab === "requests"} onClick={() => pick("requests")}>Appointment requests</button>
      </div>
      {tab === "calls" ? <OnboardingCalls /> : <AppointmentRequests />}
    </div>
  );
}

// ── Onboarding calls ─────────────────────────────────────────────────────────

const callPath = (c: Pick<Client, "id" | "slug">, n: number) => `/bookings/${encodeURIComponent(c.slug || c.id)}/${n}`;

/** When a note says "Tuesday", it most likely meant the Tuesday after the shop's latest dated activity. */
const refFor = (leads: readonly Lead[], now: Date) => {
  const byId = new Map(leads.map((l) => [l.client.id, l.lastAt]));
  return (c: Client) => {
    const at = byId.get(c.id);
    return at ? new Date(at) : now;
  };
};

export function CallStatusPill({ status }: { status: CallStatus }) {
  return <span className={`sav-status b-${status}`}>{CALL_STATUS_LABEL[status]}</span>;
}

const owner = (c: Client) => c.contact.name.trim() || "Owner not named yet";

function OnboardingCalls() {
  const { leads, error } = useLeads();
  const navigate = useNavigate();
  const rows = useMemo(() => {
    if (leads === null) return null;
    const now = new Date();
    return bookingRows(leads.map((l) => l.client), now, refFor(leads, now));
  }, [leads]);

  if (rows === null) return <section className="sav-card"><Quiet>{error ? `The CRM could not be read: ${error}.` : "Reading the CRM…"}</Quiet></section>;
  if (rows.length === 0) {
    return (
      <section className="sav-card">
        <p className="sav-sub">No onboarding calls yet. When a shop asks for one, sales files it and it shows up here; once a time is agreed, onboarding books it.</p>
      </section>
    );
  }
  const upcoming = rows.filter((r) => r.upcoming);
  const past = rows.filter((r) => !r.upcoming);
  const group = (title: string, list: BookingRow[], empty: string) => (
    <section className="sav-card flush mb-5">
      <div className="sav-card-head px-5 pt-5"><h2 className="sav-h2">{title}</h2><span className="sav-fine">{list.length}</span></div>
      {list.length === 0 ? <p className="px-5 pb-5 sav-sub">{empty}</p> : (
        <>
          <div className="sav-table-wrap overflow-x-auto">
            <table className="sav-table">
              <thead><tr><th>Shop</th><th>Owner</th><th>When</th><th>Status</th><th>Script</th></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={`${r.client.id}-${r.call.n}`} onClick={() => navigate(callPath(r.client, r.call.n))}>
                    <td className="shop"><Link to={callPath(r.client, r.call.n)} onClick={(e) => e.stopPropagation()}><span title={r.client.name}>{shopName(r.client.name)}</span></Link></td>
                    <td className={r.client.contact.name ? "" : "muted"}>{owner(r.client)}</td>
                    <td className="nowrap">{callTimeLabel(r.call)}</td>
                    <td className="nowrap"><CallStatusPill status={r.call.status} />{!r.upcoming && r.call.status !== "done" ? <span className="sav-tag sand ml-1.5">notes due</span> : null}</td>
                    <td className="muted nowrap">{r.scriptReady ? "Written by onboarding" : "Prep script ready"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sav-rows">
            {list.map((r) => (
              <Link key={`${r.client.id}-${r.call.n}`} to={callPath(r.client, r.call.n)}>
                <div className="top">
                  <span className="name">{shopName(r.client.name)}</span>
                  <CallStatusPill status={r.call.status} />
                </div>
                <div className="mt-1 text-[13.5px] text-ink-2">{callTimeLabel(r.call)} · {owner(r.client)}</div>
                <div className="mt-1 text-[13px] text-ink-3">{r.scriptReady ? "Script written by onboarding" : "Prep script ready"}{!r.upcoming && r.call.status !== "done" ? " · notes due" : ""}</div>
              </Link>
            ))}
          </div>
        </>
      )}
    </section>
  );
  return (
    <>
      {group("Upcoming", upcoming, "Nothing on the calendar.")}
      {past.length > 0 ? group("Past", past, "") : null}
    </>
  );
}

// ── One call: the script and the feedback ────────────────────────────────────

interface ReceptionistReply {
  configured: boolean;
  receptionist?: (ScriptReceptionist & { demo_url: string | null }) | null;
  calls?: unknown[];
  error?: string;
}
interface EmailsReply {
  configured: boolean;
  emails: (MailMessage & { text: string })[];
}

export function BookingDetail() {
  const { id: param = "", n: nParam } = useParams();
  const { leads, error, clients, setClients } = useLeads();
  const back = <Link to="/bookings" className="sav-crumb"><ArrowLeft size={15} strokeWidth={1.6} /> All bookings</Link>;
  const lead = leads ? findLead(leads, param) : undefined;
  if (leads === null) return <div className="pane-in">{back}<Quiet>{error ? `The CRM could not be read: ${error}.` : "Reading the CRM…"}</Quiet></div>;
  if (!lead) return <div className="pane-in">{back}<PageHead title="No such shop" sub="It may have been removed from the CRM." /></div>;
  const calls = callsOf(lead.client, lead.lastAt ? new Date(lead.lastAt) : new Date());
  const n = nParam === undefined ? calls.length - 1 : Number(nParam);
  const call = calls[n];
  if (!call) return <div className="pane-in">{back}<PageHead title={shopName(lead.client.name)} sub="No onboarding call is on file for this shop." /></div>;
  const onFiled = (updated: Client) => setClients((clients ?? []).map((c) => (c.id === updated.id ? updated : c)));
  return <CallPage key={`${lead.client.id}-${n}`} lead={lead} call={call} back={back} onFiled={onFiled} />;
}

function CallPage({ lead, call, back, onFiled }: { lead: Lead; call: OnboardingCall; back: ReactNode; onFiled: (c: Client) => void }) {
  const c = lead.client;
  const receptionist = useApi<ReceptionistReply>(`/shops/${c.id}/receptionist`);
  const emails = useApi<EmailsReply>(`/shops/${c.id}/emails`);
  const note = scriptNoteOf(c);

  const built = useMemo<ScriptSection[]>(() => {
    const r = receptionist.data;
    const rec: ScriptReceptionist | null | undefined = r === null || !r.configured ? undefined : r.receptionist === null || r.receptionist === undefined ? (r.error ? undefined : null) : r.receptionist;
    const replies = (emails.data?.emails ?? [])
      .filter((m) => m.direction === "received" && mailKind(m) === "real")
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((m) => m.text || m.preview);
    return buildPrepScript({
      client: c, city: lead.city, sector: lead.sector, phone: lead.phone, rating: lead.rating, call,
      inboxReplies: replies, receptionist: rec, demoCalls: rec ? r?.calls?.length : undefined, receptionistError: r?.error,
    });
  }, [c, lead, call, receptionist.data, emails.data]);

  const sub = [callTimeLabel(call), owner(c), lead.city].filter(Boolean).join(" · ");
  return (
    <div className="pane-in">
      <PageHead
        title={<span title={c.name}>{shopName(c.name)}</span>}
        sub={`Onboarding call · ${sub}`}
        actions={<><CallStatusPill status={call.status} /><Link to={leadPath(c)} className="btn btn-ghost btn-sm">Open the shop</Link></>}
      >
        {back}
      </PageHead>
      <div className="sav-grid-shop">
        <div className="sav-stack">
          <ScriptCard client={c} note={note} built={built} loading={receptionist.data === null && receptionist.error === null} />
        </div>
        <div className="sav-stack">
          <AfterCall client={c} call={call} onFiled={onFiled} />
          {receptionist.data?.receptionist?.demo_url ? (
            <section className="sav-card">
              <div className="sav-card-head"><h2 className="sav-h2">Their demo</h2></div>
              <p className="sav-sub">Call it together during the meeting, so they hear their own shop answered.</p>
              <a className="sav-link mt-2 inline-flex items-center gap-1" href={receptionist.data.receptionist.demo_url} target="_blank" rel="noreferrer">Open the demo page <ExternalLink size={13} /></a>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ScriptView({ sections }: { sections: readonly ScriptSection[] }) {
  return (
    <div className="sav-script">
      {sections.map((s, i) => (
        <section key={i}>
          {s.heading ? <h3 className="sav-h3">{s.heading}</h3> : null}
          {(s.quotes ?? []).map((q, j) => <blockquote key={j} className="sav-letter in">{q}</blockquote>)}
          {s.items.length > 0 ? <ul>{s.items.map((item, j) => <li key={j}>{item}</li>)}</ul> : null}
        </section>
      ))}
    </div>
  );
}

function ScriptCard({ client, note, built, loading }: { client: Client; note: string | null; built: ScriptSection[]; loading: boolean }) {
  const sections = useMemo(() => (note ? formatScriptNote(note) : built), [note, built]);
  const [asked, setAsked] = useState<"idle" | "asking" | "requested">("idle");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ask = async () => {
    setAsked("asking");
    setError(null);
    try {
      await apiSend("POST", `/bookings/${client.id}/script`);
      setAsked("requested");
    } catch (err: unknown) {
      setError(apiMessage(err));
      setAsked("idle");
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(scriptText(sections));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* no clipboard: nothing to say */ }
  };
  return (
    <section className="sav-card">
      <div className="sav-card-head">
        <h2 className="sav-h2">Meeting script</h2>
        <button type="button" className="sav-more inline-flex items-center gap-1 p-0" onClick={() => void copy()}>
          {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
        </button>
      </div>
      <p className="sav-fine mb-4">
        {note ? "Written by the onboarding agent from the shop's notes and emails." : `Put together from what we know${loading ? " (still asking the receptionist service)" : ""}. Nothing here is generated: the same facts give the same script.`}
      </p>
      <ScriptView sections={sections} />
      <div className="mt-5 border-t border-[var(--edge)] pt-4">
        {asked === "requested" ? (
          <p className="sav-fine">Requested. The onboarding agent files its script on the shop, and it shows here once it lands.</p>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" disabled={asked === "asking"} onClick={() => void ask()}>
            <Sparkles size={14} strokeWidth={1.6} /> {note ? "Have the onboarding agent write it again" : "Have the onboarding agent write a fuller script"}
          </button>
        )}
        {error ? <p className="mt-2 text-[14px] text-fail">{error}</p> : null}
      </div>
    </section>
  );
}

function AfterCall({ client, call, onFiled }: { client: Client; call: OnboardingCall; onFiled: (c: Client) => void }) {
  const [form, setForm] = useState<CallFeedback>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ onboarding: string; reason?: string; voice?: string } | null>(null);
  const filed = call.feedbackIndex !== null ? client.notes[call.feedbackIndex] ?? null : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const reply = await apiSend<{ client: Client; onboarding: string; onboarding_reason?: string; voice?: string }>("POST", `/bookings/${client.id}/feedback`, form);
      setSent({ onboarding: reply.onboarding, reason: reply.onboarding_reason, voice: reply.voice });
      onFiled(reply.client);
    } catch (err: unknown) {
      setError(apiMessage(err));
    } finally {
      setSending(false);
    }
  };

  if (filed) {
    const lines = filed.split("\n").slice(1);
    return (
      <section className="sav-card">
        <div className="sav-card-head"><h2 className="sav-h2">After the call</h2><span className="sav-ok">Done</span></div>
        <p className="sav-sub mb-3">
          {sent === null || sent.onboarding === "woken"
            ? "Feedback sent to onboarding. It turns this into the receptionist's setup."
            : `Filed on the shop. Onboarding was not woken (${sent.reason ?? "unknown"}); it picks this up on its next pass.`}
          {sent?.voice === "sent" ? " The receptionist now follows these instructions on its next call." : sent?.voice === "failed" ? " The receptionist could not be updated just now; onboarding will carry it over." : ""}
        </p>
        <ul className="sav-fb-lines">
          {lines.map((l, i) => {
            const m = /^([^:]{2,60}):\s*(.*)$/.exec(l);
            return <li key={i}>{m ? <><span className="k">{m[1]}</span><span>{m[2]}</span></> : l}</li>;
          })}
        </ul>
      </section>
    );
  }

  const empty = FEEDBACK_FIELDS.every(({ key }) => !(form[key] ?? "").trim());
  return (
    <section className="sav-card">
      <div className="sav-card-head"><h2 className="sav-h2">After the call</h2></div>
      <p className="sav-sub mb-4">What you learned. Onboarding turns it into the receptionist's setup, so it says what the owner asked for. Leave out anything that did not come up.</p>
      <form className="sav-form" onSubmit={(e) => void submit(e)}>
        {FEEDBACK_FIELDS.map(({ key, label, hint }) => (
          <label key={key}>
            <span>{label}</span>
            <textarea
              rows={key === "notes" || key === "fixes" ? 3 : 2}
              placeholder={hint}
              value={form[key] ?? ""}
              maxLength={2000}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </label>
        ))}
        {error ? <p className="text-[14px] text-fail">{error}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary btn-sm" disabled={sending || empty}>{sending ? "Sending…" : "Send to onboarding"}</button>
          {call.status === "requested" ? <span className="sav-fine">This call is not booked yet; file notes once it has happened.</span> : null}
        </div>
      </form>
    </section>
  );
}

// ── Appointment requests ─────────────────────────────────────────────────────

type RequestStatus = "pending" | "confirmed" | "declined";
interface AppointmentRow {
  key: string;
  shop: string;
  lead: string | null;
  demo: boolean;
  caller: string | null;
  callback: string | null;
  vehicle: string | null;
  service: string | null;
  preferred_time: string | null;
  notes: string | null;
  status: RequestStatus;
  flags: string[];
  created_at: string | null;
  call: { at: string | null; duration_sec: number | null; outcome: string | null; ended_by: string | null; summary: string } | null;
}
interface RequestsReply {
  configured: boolean;
  requests: AppointmentRow[];
  missing: number;
  error?: string;
}

const REQUEST_LABEL: Record<RequestStatus, string> = { pending: "Pending", confirmed: "Confirmed", declined: "Declined" };
const minutes = (sec: number | null) => (sec === null ? "" : sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`);

function AppointmentRequests() {
  const { data, error } = useApi<RequestsReply>("/bookings/requests");
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const status = (params.get("status") ?? "") as RequestStatus | "";
  const shop = params.get("shop") ?? "";
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const all = data?.requests ?? [];
  const shops = useMemo(() => [...new Set(all.map((r) => r.shop))].sort(), [all]);
  const counts = useMemo(() => {
    const out: Record<RequestStatus, number> = { pending: 0, confirmed: 0, declined: 0 };
    for (const r of all) if (shop === "" || r.shop === shop) out[r.status] += 1;
    return out;
  }, [all, shop]);
  const rows = all.filter((r) => (status === "" || r.status === status) && (shop === "" || r.shop === shop));

  if (data === null) return <section className="sav-card"><Quiet>{error ?? "Asking the receptionist service…"}</Quiet></section>;
  if (!data.configured) return <section className="sav-card"><Quiet>The receptionist service is not connected on this server (set AUTOOPS_VOICE_TOKEN).</Quiet></section>;
  return (
    <>
      <div className="sav-filters">
        <select className="sav-select" value={shop} onChange={(e) => set("shop", e.target.value)} aria-label="Shop">
          <option value="">All shops</option>
          {shops.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="sav-chips" role="group" aria-label="Status">
        <button type="button" className="sav-chip" aria-pressed={status === ""} onClick={() => set("status", "")}>
          All<span className="n">{counts.pending + counts.confirmed + counts.declined}</span>
        </button>
        {(["pending", "confirmed", "declined"] as const).map((s) => (
          <button key={s} type="button" className="sav-chip" aria-pressed={status === s} onClick={() => set("status", status === s ? "" : s)}>
            {REQUEST_LABEL[s]}<span className="n">{counts[s]}</span>
          </button>
        ))}
      </div>
      {data.error ? <p className="mb-3 text-[14px] text-fail">{data.error}</p> : null}
      <section className="sav-card flush">
        {rows.length === 0 ? (
          <p className="p-6 sav-sub">{all.length === 0 ? "No caller has asked any shop's receptionist for an appointment yet." : "No request matches these filters."}</p>
        ) : (
          <ul className="sav-reqs">
            {rows.map((r) => {
              const isOpen = open === r.key;
              const what = [r.vehicle, r.service].filter(Boolean).join(", ");
              return (
                <li key={r.key}>
                  <button type="button" className="row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.key)}>
                    <span className="who">
                      <span className="name">{r.caller ?? "A caller"}</span>
                      <span className="shop">{r.shop}{r.demo ? " · preview" : ""}</span>
                    </span>
                    <span className="what">{what || "Vehicle and service not given"}</span>
                    <span className="time">{r.preferred_time ?? "No time given"}</span>
                    <span className="state">
                      <span className={`sav-status r-${r.status}`}>{REQUEST_LABEL[r.status]}</span>
                      {r.flags.map((f) => <span key={f} className="sav-tag sand">{f}</span>)}
                    </span>
                    <span className="when">{ago(r.created_at)}</span>
                  </button>
                  {isOpen ? (
                    <div className="detail">
                      <dl className="sav-facts">
                        <dt>Caller</dt><dd>{r.caller ?? "Not given"}{r.callback ? <span className="text-ink-3"> · callback {r.callback}</span> : null}</dd>
                        <dt>Vehicle</dt><dd>{r.vehicle ?? "Not given"}</dd>
                        <dt>Service</dt><dd>{r.service ?? "Not given"}</dd>
                        <dt>Asked for</dt><dd>{r.preferred_time ?? "No time given"}</dd>
                        {r.notes ? <><dt>Notes</dt><dd>{r.notes}</dd></> : null}
                      </dl>
                      <div className="sav-cap mb-1 mt-4">The call</div>
                      {r.call ? (
                        <>
                          <p className="sav-fine">{[ago(r.call.at), minutes(r.call.duration_sec), r.call.ended_by ? `ended by the ${r.call.ended_by}` : ""].filter(Boolean).join(" · ")}</p>
                          <p className="mt-1 text-[14px] text-ink-2">{r.call.summary || "No summary was written for this call."}</p>
                        </>
                      ) : <p className="sav-fine">The call is not on record.</p>}
                      {r.lead ? <Link to={`/leads/${encodeURIComponent(r.lead)}`} className="sav-link mt-3 inline-block text-[14px]">Open the shop</Link> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {data.missing > 0 ? <p className="mt-3 sav-fine">{data.missing} shop{data.missing === 1 ? "" : "s"} could not be read just now; their requests are missing.</p> : null}
    </>
  );
}
