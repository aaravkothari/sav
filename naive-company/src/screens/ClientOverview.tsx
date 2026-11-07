import { useApi } from "../api";
import type { Post } from "../data";
import { useClient } from "./ClientWorkspace";

/** The engagement at a glance: what the client's queue is doing, the contact,
 * and the working notes the client-manager keeps. Every number is counted from
 * the client's own posts — a new engagement reads zero, three times. */
export function ClientOverview() {
  const client = useClient();
  const { data: allPosts, error } = useApi<Post[]>("/posts");
  const posts = (allPosts ?? []).filter((p) => p.clientId === client.id);
  const stats = [
    { label: "Pending review", value: posts.filter((p) => p.status === "pending").length },
    { label: "Approved", value: posts.filter((p) => p.status === "approved").length },
    { label: "Posted", value: posts.filter((p) => p.status === "posted").length },
  ];

  return (
    <div>
      {error ? <p className="mb-3 text-xs text-fail">{error}</p> : null}
      <div className="mb-6 grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="panel p-3">
            <div className="text-numeral font-mono">{allPosts === null ? "—" : s.value}</div>
            <div className="mt-0.5 text-xs text-ink-3">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-6">
        <section>
          <div className="eyebrow mb-2">Contact</div>
          <div className="panel p-3">
            <div className="font-medium">{client.contact.name}</div>
            <div className="mt-0.5 text-xs text-ink-2">{client.contact.role}</div>
            <div className="mt-1 font-mono text-xs text-ink-3">{client.contact.email}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {client.services.map((s) => (
                <span key={s} className="chip chip-plain">{s}</span>
              ))}
            </div>
          </div>
          {client.nextAction ? (
            <div className="mt-3">
              <div className="eyebrow mb-2">Next action</div>
              <div className="panel p-3 text-sm text-ink-2">{client.nextAction}</div>
            </div>
          ) : null}
        </section>

        <section>
          <div className="eyebrow mb-2">Notes</div>
          {client.notes.length === 0 ? (
            <div className="absence">No notes yet.</div>
          ) : (
            <div className="list">
              {client.notes.map((note) => (
                <p key={note} className="px-3 py-2.5 text-sm text-ink-2">{note}</p>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
