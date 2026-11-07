import { ArrowRight, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { apiMessage, apiSend, useApi } from "../api";
import { PageHeader, STAGE_LABEL } from "../components/kit";
import { STAGE_ORDER, TEMPLATE, nextStage, type Client } from "../data";

/** The pipeline: lead → proposal → active → churned. Every column is the CRM's own rows — the
 * same rows the sales agent writes over MCP — so a board with nothing on it means nobody has
 * filed a lead yet. Advancing waits for the server and takes the row it answers with; a refused
 * move says so instead of moving on screen and reverting on the next load. */

const BLANK = { name: "", domain: "", contactName: "", contactEmail: "", contactRole: "" };

/** How a lead's source reads on its row: the provenance chip, as `via email` does elsewhere. */
const SOURCE_LABEL: Record<NonNullable<Client["source"]>, string> = {
  site: "via website",
  manual: "added by you",
  outreach: "via outreach",
  network: "via your network",
  referral: "via referral",
};

function sourceText(c: Client, clients: readonly Client[]): string | null {
  if (!c.source) return null;
  const referrer = c.source === "referral" ? clients.find((row) => row.id === c.referredBy)?.name : undefined;
  return referrer ? `referred by ${referrer}` : SOURCE_LABEL[c.source];
}

export function Crm() {
  const { data: clients, error, setData, setError } = useApi<Client[]>("/clients");
  const [form, setForm] = useState<typeof BLANK | null>(null);
  const [saving, setSaving] = useState(false);

  const advance = async (c: Client) => {
    const to = nextStage(c.stage);
    if (to === null) return;
    try {
      // Graduating into active is onboarding: the server also provisions the client's agents.
      const updated = to === "active"
        ? (await apiSend<{ client: Client }>("POST", `/clients/${c.id}/onboard`)).client
        : await apiSend<Client>("POST", `/clients/${c.id}/advance`);
      setData((clients ?? []).map((row) => (row.id === c.id ? updated : row)));
    } catch (err: unknown) {
      setError(apiMessage(err));
    }
  };

  /**
   * The door into an empty CRM.
   *
   * The route has always existed — it is the one the public site's contact form posts a lead
   * through — and no screen an operator could reach ever offered it, so a new agency opened on an
   * empty board with nothing to press: the first client could only be created by an agent that had
   * no reason to run yet, or by hand over HTTP.
   */
  const create = async (fields: typeof BLANK) => {
    setSaving(true);
    setError(null);
    try {
      const created = await apiSend<Client>("POST", "/leads", {
        name: fields.name.trim(),
        domain: fields.domain.trim(),
        contact: {
          name: fields.contactName.trim(),
          email: fields.contactEmail.trim(),
          role: fields.contactRole.trim(),
        },
        // The server takes this only from a signed-in operator; the public form's leads are `site`.
        source: "manual",
      });
      setData([...(clients ?? []), created]);
      setForm(null);
    } catch (err: unknown) {
      setError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const ready = form !== null
    && form.name.trim() !== "" && form.domain.trim() !== ""
    && form.contactName.trim() !== "" && form.contactEmail.trim() !== "";

  return (
    <div className="pane-in">
      <PageHeader
        title="CRM"
        subtitle={TEMPLATE.words.crmSubtitle}
        actions={
          <div className="flex items-center gap-3">
            {error ? <span className="text-xs text-fail">{error}</span> : null}
            <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={() => setForm(form === null ? BLANK : null)}>
              <Plus size={14} strokeWidth={1.75} /> {form === null ? "Add a client" : "Cancel"}
            </button>
          </div>
        }
      />

      {form !== null ? (
        <form
          className="panel mb-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !saving) void create(form);
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            {([
              ["name", "Company", "Acme Dental"],
              ["domain", "Domain", "acmedental.example"],
              ["contactName", "Contact", "Jordan Lee"],
              ["contactEmail", "Contact email", "jordan@acmedental.example"],
              ["contactRole", "Role (optional)", "Owner"],
            ] as const).map(([key, label, placeholder]) => (
              <label key={key} className="block">
                <span className="field-label">{label}</span>
                <input
                  className="input"
                  placeholder={placeholder}
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || saving}>
              {saving ? "Filing…" : "File as a lead"}
            </button>
            <span className="field-hint">
              They start as a lead. Move them along the board yourself, or let the sales agent work them.
            </span>
          </div>
        </form>
      ) : null}

      <p className="absence mb-4">{TEMPLATE.words.onboarding}</p>

      {clients === null ? (
        <div className="absence">{error ? "The pipeline could not be read, so this is not the answer — retry once the error above is resolved." : "Loading the pipeline…"}</div>
      ) : clients.length === 0 && form === null ? (
        <div className="panel p-6 text-center">
          <p className="font-medium">No clients yet.</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-2">
            Nothing has been filed here — not by you, not by the public site's contact form, not by the sales agent. Add the
            first one and the rest of the agency has something to work on.
          </p>
          <button type="button" className="btn btn-primary btn-sm mt-4" onClick={() => setForm(BLANK)}>
            <Plus size={14} strokeWidth={1.75} /> Add your first client
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          {STAGE_ORDER.map((stage) => {
            const rows = clients.filter((c) => c.stage === stage);
            return (
              <section key={stage}>
                <div className="eyebrow mb-2">
                  {STAGE_LABEL[stage]}
                  <span className="eyebrow-aside">{rows.length}</span>
                </div>
                {rows.length === 0 ? (
                  <div className="absence">Nobody here.</div>
                ) : (
                  <div className="space-y-2">
                    {rows.map((c) => (
                      <div key={c.id} className="panel p-3">
                        <div className="flex items-center justify-between gap-2">
                          {c.stage === "active" ? (
                            <Link to={`/clients/${c.id}`} className="truncate font-medium underline-offset-2 hover:underline">{c.name}</Link>
                          ) : (
                            <span className="truncate font-medium">{c.name}</span>
                          )}
                          <span className="font-mono text-xs text-ink-3">{c.domain}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-ink-2">
                          {c.contact.name} · {c.contact.role} · <span className="font-mono">{c.contact.email}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {sourceText(c, clients) ? <span className="chip chip-via">{sourceText(c, clients)}</span> : null}
                          {c.services.map((s) => (
                            <span key={s} className="chip chip-plain">{s}</span>
                          ))}
                        </div>
                        {c.notes.length > 0 ? <p className="mt-2 text-xs text-ink-2">{c.notes[0]}</p> : null}
                        {c.nextAction ? <p className="mt-1 text-xs text-ink-3">Next: {c.nextAction}</p> : null}
                        {nextStage(c.stage) !== null ? (
                          <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => void advance(c)}>
                            <ArrowRight size={14} strokeWidth={1.75} /> Move to {STAGE_LABEL[nextStage(c.stage)!].toLowerCase()}
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
