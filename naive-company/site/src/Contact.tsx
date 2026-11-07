import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { SiteProfile } from "../site.config.ts";
import { referralCode, submitLead, type ContactForm } from "./lead.ts";

const EMPTY: ContactForm = { company: "", website: "", name: "", email: "", services: [], note: "" };

/**
 * The contact form. On submit it POSTs a CRM lead to the dashboard server's
 * `/api/leads`; when the server isn't reachable (static deploy) it degrades to
 * a direct-email prompt rather than an error — the visitor is never stuck.
 */
export function Contact({ site }: { site: SiteProfile }) {
  const [form, setForm] = useState(EMPTY);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "offline">("idle");
  const serviceNames = site.services.map((s) => s.name);
  // Remember a referral link's code on arrival, so it survives the visitor reading on before writing.
  useEffect(() => void referralCode(), []);

  const set = (patch: Partial<ContactForm>) => setForm((f) => ({ ...f, ...patch }));
  const toggleService = (name: string) =>
    set({ services: form.services.includes(name) ? form.services.filter((s) => s !== name) : [...form.services, name] });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setState("sending");
    setState(await submitLead(form));
  }

  if (state === "sent") {
    return (
      <section id="contact" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <div className="card mx-auto max-w-xl p-10 text-center">
          <h2 className="h2">Thanks — we're on it.</h2>
          <p className="mt-3 text-muted">We reply within one business day with your baseline audit.</p>
        </div>
      </section>
    );
  }

  return (
    <Sectionish site={site}>
      <form onSubmit={onSubmit} className="card mx-auto mt-10 grid max-w-xl gap-4 p-8">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium">
            Company
            <input required className="field" value={form.company} onChange={(e) => set({ company: e.target.value })} />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Website
            <input required className="field" placeholder="example.com" value={form.website} onChange={(e) => set({ website: e.target.value })} />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Your name
            <input required className="field" value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Email
            <input required type="email" className="field" value={form.email} onChange={(e) => set({ email: e.target.value })} />
          </label>
        </div>
        <fieldset className="text-sm">
          <legend className="font-medium">What do you need?</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {serviceNames.map((name) => (
              <label key={name} className="flex items-center gap-2">
                <input type="checkbox" checked={form.services.includes(name)} onChange={() => toggleService(name)} />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="grid gap-1 text-sm font-medium">
          Anything else?
          <textarea rows={3} className="field" value={form.note} onChange={(e) => set({ note: e.target.value })} />
        </label>
        <button type="submit" disabled={state === "sending"} className="btn btn-accent disabled:opacity-60">
          {state === "sending" ? "Sending…" : site.hero.cta}
        </button>
        {state === "offline" ? (
          <p role="status" className="text-center text-sm text-muted">
            {site.contact.offlineNote}{" "}
            <a className="font-medium text-ink underline" href={`mailto:${site.contact.email}`}>
              {site.contact.email}
            </a>
          </p>
        ) : null}
      </form>
    </Sectionish>
  );
}

function Sectionish({ site, children }: { site: SiteProfile; children: ReactNode }) {
  return (
    <section id="contact" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
      <div className="text-center">
        <p className="eyebrow">Contact</p>
        <h2 className="h2 mt-3">{site.contact.title}</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted">{site.contact.subtitle}</p>
      </div>
      {children}
    </section>
  );
}
