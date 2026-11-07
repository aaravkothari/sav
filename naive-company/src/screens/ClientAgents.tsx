import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { apiGet, apiMessage, apiSend, useApi } from "../api";
import { TEMPLATE, type Agent } from "../data";
import { useClient } from "./ClientWorkspace";

/** One line of the server's provision report (`ProvisionReport`, `server/proxy.ts`). */
interface CrewReport {
  name: string;
  action: "created" | "updated" | "unchanged" | "kept" | "failed";
}

/** What each report line means to an operator, who has not read `provisionClientAgents`. */
const SAID: Record<CrewReport["action"], string> = {
  created: "created — this seat was missing",
  updated: "updated to the template",
  unchanged: "already matched the template",
  kept: "kept — the active template no longer declares it, so it was left exactly as it is",
  failed: "failed — the platform refused it, so nothing about this seat is settled",
};

/**
 * The client's own crew, provisioned on the platform at onboarding with names suffixed by the
 * client slug (`<agent>--acme-dental`), which is how one organization hosts many clients'
 * agents. Which crew — or none at all — is the active template's; the roster is the platform's,
 * and it lists every agent this client has, including one a previous template provisioned and the
 * switch kept. Nothing here is a placeholder for one.
 *
 * THE ONE PLACE A STANDING CREW CAN BE BROUGHT UP TO THE TEMPLATE, AND WHY IT IS A BUTTON HERE.
 *
 * `provisionClientAgents` is an upsert: it creates the seats that are missing and patches the
 * declaration onto the ones that are already there. Its only caller was the lead→active move on the
 * CRM board — and that move is offered only while a client is *not yet* active, so once a client is
 * active nothing in this dashboard could reach the upsert again. Every crew provisioned before the
 * template gained a seat, a tool or a `handoffs` chain therefore stayed exactly as it was, and the
 * operator's only route to it was to POST `/api/clients/<id>/onboard` by hand — which is to say, to
 * read a release note first.
 *
 * So the crew's own screen offers it, next to the crew it changes and the empty state that used to
 * dead-end. The onboard route is already idempotent for an active client (the store keeps the stage
 * and the original `onboardedAt`, and the provision runs again), so this needs no second route and
 * no second code path: it is that route, run again, printing what it found. The control is shown
 * only for an active client, because for a lead the same route is the graduation, and
 * "re-provision" must never be how a prospect silently becomes a customer.
 */
export function ClientAgents() {
  const client = useClient();
  const { data: page, error, setData } = useApi<{ data?: Agent[] }>("/agents");
  const [report, setReport] = useState<CrewReport[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const crew = (page?.data ?? []).filter((a) => a.name.endsWith(`--${client.slug}`));

  /**
   * The report is the point of the press, not a toast: `unchanged` on every line is the honest
   * answer that there was nothing to do, and that is a different sentence from "done". The roster
   * is re-read afterwards rather than patched from the report, because a seat this just created is
   * the platform's row and only the platform knows its id, model and description.
   */
  const reprovision = async () => {
    setRunning(true);
    setFailed(null);
    try {
      const { agents } = await apiSend<{ agents: CrewReport[] | null }>("POST", `/clients/${client.id}/onboard`);
      // `null` is the server saying it holds no platform key, so the crew was never its to write.
      if (agents === null) setFailed("not configured — the platform key is unset, so there is no crew to reconcile");
      else setReport(agents);
      setData(await apiGet<{ data?: Agent[] }>("/agents"));
    } catch (err: unknown) {
      setFailed(apiMessage(err));
    } finally {
      setRunning(false);
    }
  };

  if (error) return <p className="text-sm text-fail">{error}</p>;
  if (page === null) return <div className="absence">Loading the crew…</div>;

  return (
    <div>
      {client.stage === "active" ? (
        <div className="panel mb-3 flex items-start justify-between gap-4 p-3">
          <p className="field-hint max-w-2xl">
            This crew was provisioned from the active template when the client was onboarded, and it does not
            change on its own afterwards. Re-provision it to bring it up to the template as it stands now: a
            seat the template has since gained is created, one whose prompt, tools or handoffs have moved is
            patched, and one that already matches is left alone. Nothing here deletes an agent.
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-sm shrink-0"
            disabled={running}
            onClick={() => void reprovision()}
          >
            <RefreshCw size={14} strokeWidth={1.75} /> {running ? "Re-provisioning…" : "Re-provision crew"}
          </button>
        </div>
      ) : null}

      {failed !== null ? <p className="mb-3 text-xs text-fail">{failed}</p> : null}

      {report !== null ? (
        <div className="panel mb-3 p-3">
          <div className="eyebrow mb-2">What the re-provision did</div>
          {report.length === 0 ? (
            <p className="text-xs text-ink-2">The active template declares no crew, so there was nothing to provision.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {report.map((line) => (
                <li key={line.name} className={line.action === "failed" ? "text-fail" : "text-ink-2"}>
                  <span className="font-mono">{line.name}</span> — {SAID[line.action] ?? line.action}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {crew.length === 0 ? (
        <div className="absence">{TEMPLATE.words.noCrew}</div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {crew.map((a) => (
            <div key={a.id} className="panel p-3">
              <div className="truncate font-mono font-medium">{a.name}</div>
              {a.description ? <p className="mt-2 text-sm text-ink-2">{a.description}</p> : null}
              <div className="mt-3 truncate font-mono text-xs text-ink-3">{a.model ?? a.id}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
