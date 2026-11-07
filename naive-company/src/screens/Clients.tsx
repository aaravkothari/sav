import { Link } from "react-router";
import { useApi } from "../api";
import { PageHeader, StageChip } from "../components/kit";
import { TEMPLATE, type Client, type Post } from "../data";

/** Active clients — each row opens that client's workspace. Prospects live on
 * the CRM until they graduate. */
export function Clients() {
  const { data: clients, error } = useApi<Client[]>("/clients");
  const { data: posts } = useApi<Post[]>("/posts");
  const rows = (clients ?? []).filter((c) => c.stage === "active");

  return (
    <div className="pane-in">
      <PageHeader
        title="Clients"
        subtitle={TEMPLATE.words.clientsSubtitle}
        actions={error ? <span className="text-xs text-fail">{error}</span> : null}
      />

      {clients === null ? (
        <div className="absence">{error ? "Nothing to show." : "Loading clients…"}</div>
      ) : rows.length === 0 ? (
        <div className="absence">{TEMPLATE.words.noActiveClients}</div>
      ) : (
        <div className="list">
          {rows.map((c) => {
            const mine = (posts ?? []).filter((p) => p.clientId === c.id);
            const pending = mine.filter((p) => p.status === "pending").length;
            return (
              <Link key={c.id} to={`/clients/${c.id}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-hover">
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium text-ink"
                  style={{ background: `hsl(${c.name.length * 37} 22% 86%)` }}
                >
                  {c.name.slice(0, 2)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{c.name}</span>
                    <StageChip stage={c.stage} />
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    <span className="font-mono">{c.domain}</span>
                    {c.services.length > 0 ? ` · ${c.services.join(" · ")}` : null}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-xs text-ink-3">
                  {posts === null ? "" : pending > 0 ? `${pending} pending review` : `${mine.length} posts`}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
