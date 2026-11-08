import { Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { apiMessage, apiSend } from "../api";
import { PageHead, ShopName, useLeads } from "../components/sav";
import type { Client } from "../data";
import { ago, leadPath, nextStepText, shopName, STATUS_LABEL, STATUSES, type Lead, type LeadStatus } from "../leads";

/**
 * The pipeline as a board: one column per step a shop takes, from researched to paying, each shop
 * a card that says where it is, who to talk to and what happens next. The columns are derived from
 * the crew's notes (`src/leads.ts`), so a shop moves on its own the moment an agent files the next
 * step. A card opens the shop; adding a shop by hand files it as a lead.
 */

const BLANK = { name: "", domain: "", contactName: "", contactEmail: "", contactRole: "" };

/** How a lead's source reads on its card. */
const SOURCE_LABEL: Record<NonNullable<Client["source"]>, string> = {
  site: "via website",
  manual: "added by you",
  outreach: "via outreach",
  network: "via your network",
  referral: "via referral",
};

function sourceText(c: Client, clients: readonly Client[]): string | null {
  if (!c.source || c.source === "outreach") return null;
  const referrer = c.source === "referral" ? clients.find((row) => row.id === c.referredBy)?.name : undefined;
  // (display name below)
  return referrer ? `referred by ${shopName(referrer)}` : SOURCE_LABEL[c.source];
}

function Tile({ lead, clients }: { lead: Lead; clients: readonly Client[] }) {
  const c = lead.client;
  const source = sourceText(c, clients);
  const next = nextStepText(c.nextAction);
  return (
    <Link to={leadPath(c)} className="sav-tile">
      <div className="name"><ShopName client={c} /></div>
      <div className="meta">{[lead.city, lead.sector].filter(Boolean).join(" · ")}</div>
      {c.contact.name || c.contact.email ? <div className="meta">{c.contact.name || c.contact.email}</div> : null}
      {source || (lead.demoReady && lead.rank < 3) ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {source ? <span className="sav-tag slate">{source}</span> : null}
          {lead.demoReady && lead.rank < 3 ? <span className="sav-tag plain">demo ready</span> : null}
        </div>
      ) : null}
      {next ? <div className="next line-clamp-3">{next}</div> : null}
      {lead.lastAt ? <div className="mt-2 sav-fine">{ago(lead.lastAt)}</div> : null}
    </Link>
  );
}

export function Crm() {
  const { leads, clients, error, setClients } = useLeads();
  const [form, setForm] = useState<typeof BLANK | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const create = async (fields: typeof BLANK) => {
    setSaving(true);
    setFormError(null);
    try {
      const created = await apiSend<Client>("POST", "/leads", {
        name: fields.name.trim(),
        domain: fields.domain.trim(),
        contact: { name: fields.contactName.trim(), email: fields.contactEmail.trim(), role: fields.contactRole.trim() },
        // The server takes this only from a signed-in operator; the public form's leads are `site`.
        source: "manual",
      });
      setClients([...(clients ?? []), created]);
      setForm(null);
    } catch (err: unknown) {
      setFormError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const ready = form !== null
    && form.name.trim() !== "" && form.domain.trim() !== ""
    && form.contactName.trim() !== "" && form.contactEmail.trim() !== "";

  const has = (s: LeadStatus) => (leads ?? []).some((l) => l.status === s);
  const columns: LeadStatus[] = [...(has("new") ? ["new" as const] : []), ...STATUSES, ...(has("bounced") ? ["bounced" as const] : [])];
  // Every column on one laptop screen: a step with shops takes a share of the width, an empty one folds narrow.
  const boardCols = columns.map((s) => (has(s) ? "minmax(0, 1fr)" : "minmax(0, 7.5rem)")).join(" ");

  return (
    <div className="pane-in" style={{ maxWidth: "110rem" }}>
      <PageHead
        title="Pipeline"
        sub="Every shop by the step it has reached. Cards move on their own as the crew files each step."
        actions={
          <>
            {formError ? <span className="text-[13px] text-fail">{formError}</span> : null}
            <button type="button" className="btn btn-ghost" onClick={() => setForm(form === null ? BLANK : null)}>
              <Plus size={15} strokeWidth={1.6} /> {form === null ? "Add a shop" : "Cancel"}
            </button>
          </>
        }
      />

      {form !== null ? (
        <form
          className="sav-card mb-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !saving) void create(form);
          }}
        >
          <h2 className="sav-h3 mb-3">Add a shop by hand</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              ["name", "Shop", "Acme Dental"],
              ["domain", "Website", "acmedental.example"],
              ["contactName", "Contact", "Jordan Lee"],
              ["contactEmail", "Contact email", "jordan@acmedental.example"],
              ["contactRole", "Role (optional)", "Owner"],
            ] as const).map(([key, label, placeholder]) => (
              <label key={key} className="block">
                <span className="field-label">{label}</span>
                <input className="input" placeholder={placeholder} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary" disabled={!ready || saving}>{saving ? "Filing…" : "File as a lead"}</button>
            <span className="sav-fine">It starts as researched. The sales agent picks it up from there.</span>
          </div>
        </form>
      ) : null}

      {leads === null ? (
        <p className="sav-sub">{error ? `The pipeline could not be read: ${error}.` : "Loading the pipeline…"}</p>
      ) : leads.length === 0 && form === null ? (
        <div className="sav-card text-center">
          <p className="sav-h3">No shops yet.</p>
          <p className="mx-auto mt-2 max-w-md sav-sub">Research files shops here as it finds them. You can also add one you already know.</p>
          <button type="button" className="btn btn-primary mt-4" onClick={() => setForm(BLANK)}>
            <Plus size={15} strokeWidth={1.6} /> Add your first client
          </button>
        </div>
      ) : (
        <div className="sav-board" style={{ "--board-cols": boardCols } as React.CSSProperties}>
          {columns.map((status) => {
            const rows = leads.filter((l) => l.status === status).sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.client.name.localeCompare(b.client.name));
            return (
              <section key={status} className={`sav-col${rows.length === 0 ? " empty" : ""}`} aria-label={STATUS_LABEL[status]}>
                <div className="sav-col-head">
                  <h2 className="sav-h3">{STATUS_LABEL[status]}</h2>
                  <span className="n">{rows.length}</span>
                </div>
                <div className="sav-col-body max-h-[72vh] overflow-y-auto">
                  {rows.length === 0 ? <div className="sav-empty">None yet</div> : rows.map((l) => <Tile key={l.client.id} lead={l} clients={clients ?? []} />)}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
