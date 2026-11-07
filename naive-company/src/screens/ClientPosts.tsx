import { Check, FileText, Send, X } from "lucide-react";
import { useState } from "react";
import { apiMessage, apiSend, useApi } from "../api";
import { KindChip, STATUS_LABEL, StatusChip, fmt } from "../components/kit";
import type { Post, PostStatus } from "../data";
import { useClient } from "./ClientWorkspace";

const TABS: { key: PostStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "ready", label: "Ready" },
  { key: "approved", label: "Approved" },
  { key: "posted", label: "Posted" },
  { key: "rejected", label: "Rejected" },
];

/** The content lifecycle: pending (agent proposed) → ready (person edited/ok'd
 * content) → approved (cleared to publish, awaiting slot) → posted / rejected.
 * Each move waits for the server's answer and takes the row it returns, so a
 * publish that failed upstream stays where it was and says why.
 *
 * **Approving happens in the draft, never in the list.** A row is one truncated line, and a
 * deliverable approved from one line is a deliverable nobody read — so the list opens the piece and
 * the decision lives next to the piece's own words. */
export function ClientPosts() {
  const client = useClient();
  const [tab, setTab] = useState<PostStatus>("pending");
  const [open, setOpen] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const { data: posts, error, setData, setError } = useApi<Post[]>("/posts");
  const mine = (posts ?? []).filter((p) => p.clientId === client.id);
  const rows = mine.filter((p) => p.status === tab);
  const reading = mine.find((p) => p.id === open) ?? null;

  const move = async (id: string, status: PostStatus) => {
    try {
      const updated = status === "posted"
        ? await apiSend<Post>("POST", `/posts/${id}/post-now`)
        : await apiSend<Post>("PATCH", `/posts/${id}`, {
            status,
            ...(status === "rejected" && why.trim() !== "" ? { rejectedReason: why.trim() } : {}),
          });
      setData((posts ?? []).map((p) => (p.id === id ? updated : p)));
      setOpen(null);
      setWhy("");
    } catch (err: unknown) {
      setError(apiMessage(err));
    }
  };

  return (
    <div>
      {error ? <p className="mb-3 text-xs text-fail">{error}</p> : null}
      <div className="seg mb-4 w-fit" role="tablist">
        {TABS.map(({ key, label }) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className="seg-item" onClick={() => { setTab(key); setOpen(null); }}>
            {label}
            <span className="ml-1.5 font-mono text-xs text-ink-3">{mine.filter((p) => p.status === key).length}</span>
          </button>
        ))}
      </div>

      {posts === null ? (
        <div className="absence">{error ? "The queue could not be read, so this is not the answer — retry once the error above is resolved." : "Loading the queue…"}</div>
      ) : rows.length === 0 ? (
        <div className="absence">Nothing {tab} right now.</div>
      ) : (
        <div className="list">
          {rows.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
              <span
                className="size-9 shrink-0 rounded-md border border-line"
                style={{ background: `linear-gradient(160deg, hsl(${p.hue} 18% 88%), hsl(${p.hue} 14% 74%))` }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{p.title}</span>
                  <StatusChip status={p.status} />
                </div>
                <div className="mt-0.5 truncate text-sm text-ink-2">{p.summary}</div>
                <div className="mt-1 flex items-center gap-2 text-xs text-ink-3">
                  <KindChip kind={p.kind} channel={p.channel} />
                  <span className="font-mono">by {p.agent}</span>
                  <span className="font-mono">→ {p.scheduledFor}</span>
                  {p.postedAt ? <span className="font-mono">{p.postedAt} · {fmt(p.clicks ?? 0)} clicks · {fmt(p.impressions ?? 0)} impressions</span> : null}
                </div>
                {p.rejectedReason ? <div className="mt-1 text-xs text-fail">{p.rejectedReason}</div> : null}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setOpen(p.id); setWhy(""); }}
                >
                  <FileText size={14} strokeWidth={1.75} /> {tab === "pending" || tab === "ready" ? "Read and decide" : "Read"}
                </button>
                {tab === "approved" && p.channel !== "studio" ? (
                  <button type="button" className="btn btn-ghost btn-sm" title="Publish now instead of waiting for the slot" onClick={() => void move(p.id, "posted")}>
                    <Send size={14} strokeWidth={1.75} /> Post now
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {reading === null ? null : (
        <article className="panel drawer-in mt-4 p-4">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="page-title truncate">{reading.title}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <StatusChip status={reading.status} />
                <KindChip kind={reading.kind} channel={reading.channel} />
                <span className="font-mono">by {reading.agent}</span>
                <span className="font-mono">→ {reading.scheduledFor}</span>
              </div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => setOpen(null)}>
              <X size={14} strokeWidth={1.75} /> Close
            </button>
          </header>

          <p className="mt-4 text-sm text-ink-2">{reading.summary}</p>

          <div className="eyebrow mb-2 mt-4">The draft</div>
          {reading.body ? (
            <div className="panel whitespace-pre-wrap break-words p-3 text-sm">{reading.body}</div>
          ) : (
            /* Never invented: the queue holds a body only when the agent filed one, and saying so
               is the difference between "there is nothing to read" and "we did not show it". */
            <p className="absence">
              {reading.agent} filed no draft body for this piece — only the line above. Ask it for the full draft before
              approving, or approve the line if that is genuinely all this is.
            </p>
          )}

          {reading.rejectedReason ? (
            <p className="mt-3 text-xs text-fail">{reading.rejectedReason}</p>
          ) : null}

          {reading.status === "pending" || reading.status === "ready" ? (
            <div className="mt-4">
              <label className="field-label" htmlFor="reject-why">Reason (optional)</label>
              <input
                id="reject-why"
                className="input"
                placeholder="Kept with the piece if you reject it, so the agent knows what to fix."
                value={why}
                onChange={(e) => setWhy(e.target.value)}
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void move(reading.id, "approved")}>
                  <Check size={14} strokeWidth={1.75} /> Approve — clear it to publish
                </button>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => void move(reading.id, "rejected")}>
                  <X size={14} strokeWidth={1.75} /> Reject — send it back
                </button>
                <span className="text-xs text-ink-3">
                  Approving moves it to “{STATUS_LABEL.approved}”; it still waits for its slot or for you to post it now.
                </span>
              </div>
            </div>
          ) : null}
        </article>
      )}
    </div>
  );
}
