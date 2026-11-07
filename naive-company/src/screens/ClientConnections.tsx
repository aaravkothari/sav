import { Plus } from "lucide-react";
import { useState } from "react";
import { apiMessage, apiSend, useApi } from "../api";
import { CONNECTION_KINDS, type SocialAccount } from "../data";
import { useClient } from "./ClientWorkspace";

const title = (platform: string) => CONNECTION_KINDS.find((k) => k.kind === platform)?.title ?? platform;

/** The accounts this agency posts through, read from the platform identity the
 * dashboard runs as. Credentials never live in this dashboard: connecting opens
 * the platform's hosted portal, and what comes back is whatever it says is
 * connected — never a row this screen invented. */
export function ClientConnections() {
  const client = useClient();
  const { data: page, error } = useApi<{ data?: SocialAccount[] }>("/social/accounts");
  const [opening, setOpening] = useState<string | null>(null);
  const accounts = page?.data ?? [];

  const connect = async () => {
    setOpening(null);
    try {
      const link = await apiSend<{ url?: string }>("POST", "/social/portal", { redirect_url: window.location.href });
      if (link.url) window.open(link.url, "_blank", "noopener");
      else setOpening("the platform returned no portal link");
    } catch (err: unknown) {
      setOpening(apiMessage(err));
    }
  };

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-ink-2">
          Credentials live with the platform identity, never in this dashboard — connecting opens the hosted portal, and the
          accounts below are whatever it reports for {client.name}'s agency.
        </p>
        <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => void connect()}>
          <Plus size={14} strokeWidth={1.75} /> Connect an account
        </button>
      </div>
      {error ? <p className="mb-3 text-xs text-fail">{error}</p> : null}
      {opening ? <p className="mb-3 text-xs text-fail">{opening}</p> : null}

      {page === null ? (
        <div className="absence">{error ? "Nothing to show." : "Loading connections…"}</div>
      ) : accounts.length === 0 ? (
        <div className="absence">Nothing connected yet.</div>
      ) : (
        <div className="list">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className={`dot ${a.connected_at ? "dot-ok" : "dot-warn"}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{a.display_name ?? a.username ?? a.id}</div>
                <div className="mt-0.5 text-xs text-ink-3">
                  {title(a.platform)}
                  {a.username ? ` · @${a.username}` : ""}
                  {a.connected_at ? "" : " · reconnect in the portal to resume"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
