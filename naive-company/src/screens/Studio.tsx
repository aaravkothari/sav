import { Check, Download, X } from "lucide-react";
import { createElement, useEffect, useState } from "react";
import { apiMessage, apiSend, useApi } from "../api";
import { KindChip, PageHeader, StatusChip } from "../components/kit";
import type { Client, Post, PostStatus } from "../data";

/** What `GET /api/files/:id/meta` answers: enough to choose how a file is shown. */
export interface FileMeta {
  id: string;
  name: string;
  content_type: string;
  size_bytes: number | null;
}

export type FileShape = "image" | "model" | "video" | "download";

/** How a file is shown: an image inline, a GLB in `<model-viewer>`, a video playing, anything else (STEP, STL) as a download. */
export const shapeOf = (meta: Pick<FileMeta, "name" | "content_type">): FileShape => {
  const type = meta.content_type.toLowerCase();
  const name = meta.name.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "model/gltf-binary" || type === "model/gltf+json" || name.endsWith(".glb") || name.endsWith(".gltf")) return "model";
  if (type.startsWith("video/")) return "video";
  return "download";
};

const fileUrl = (id: string) => `/api/files/${id}`;

/** `vite.config.ts`'s literal: true only in a product-design build (and false under vitest). */
declare const __AGENCY_STUDIO__: boolean;

/**
 * `<model-viewer>` is a custom element that brings three.js with it, so it is loaded only when a
 * mesh is actually on screen — once, in its own chunk — and only a product-design build carries
 * that chunk at all: elsewhere the condition is the literal `false` and the import is dropped.
 */
let viewer: Promise<unknown> | null = null;
const loadViewer = (): Promise<unknown> =>
  (viewer ??= __AGENCY_STUDIO__ ? import("@google/model-viewer").catch(() => null) : Promise.resolve(null));

function Mesh({ id, name }: { id: string; name: string }) {
  useEffect(() => { void loadViewer(); }, []);
  // `createElement` rather than JSX: a custom element needs no React typing, and its attributes pass through as written.
  return createElement("model-viewer", {
    src: fileUrl(id),
    alt: name,
    "camera-controls": "",
    "auto-rotate": "",
    "shadow-intensity": "1",
    "data-file": id,
    style: { width: "100%", height: "280px", background: "var(--color-ground, #f4f4f2)", borderRadius: "8px" },
  });
}

function StudioFile({ id }: { id: string }) {
  const { data: meta, error } = useApi<FileMeta>(`/files/${id}/meta`);
  if (meta === null) {
    return (
      <div className="panel p-3 text-xs text-ink-3">
        {error ? <>Could not read {id}: {error}. <a className="underline" href={fileUrl(id)}>Try the download</a>.</> : `Reading ${id}…`}
      </div>
    );
  }
  const shape = shapeOf(meta);
  return (
    <figure className="panel overflow-hidden p-2">
      {shape === "image" ? (
        <img src={fileUrl(id)} alt={meta.name} className="w-full rounded-md object-contain" style={{ maxHeight: 280 }} />
      ) : shape === "model" ? (
        <Mesh id={id} name={meta.name} />
      ) : shape === "video" ? (
        <video src={fileUrl(id)} controls className="w-full rounded-md" style={{ maxHeight: 280 }} />
      ) : null}
      <figcaption className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-2">
        <span className="truncate font-mono">{meta.name}</span>
        <a href={fileUrl(id)} download={meta.name} className="btn btn-ghost btn-sm shrink-0">
          <Download size={14} strokeWidth={1.75} /> Download
        </a>
      </figcaption>
    </figure>
  );
}

/**
 * The product-design studio's queue: every deliverable filed on the `studio` channel, newest first,
 * with the files it IS — the still as an image, the concept mesh turning in `<model-viewer>`, a
 * part's STEP and STL as downloads — next to the decision. Approving one only marks it approved:
 * a studio deliverable is never posted anywhere (`server/routes.ts`), it is handed over by you.
 */
export function Studio() {
  const { data: posts, error, setData, setError } = useApi<Post[]>("/posts");
  const { data: clients } = useApi<Client[]>("/clients");
  const [why, setWhy] = useState<Record<string, string>>({});
  // The store appends, so the newest deliverable is the last row; the screen reads newest first.
  const rows = (posts ?? []).filter((p) => p.channel === "studio").reverse();
  const clientName = (id: string) => clients?.find((c) => c.id === id)?.name ?? id;

  const decide = async (id: string, status: Extract<PostStatus, "approved" | "rejected">) => {
    try {
      const reason = (why[id] ?? "").trim();
      const updated = await apiSend<Post>("PATCH", `/posts/${id}`, {
        status,
        ...(status === "rejected" && reason !== "" ? { rejectedReason: reason } : {}),
      });
      setData((posts ?? []).map((p) => (p.id === id ? updated : p)));
    } catch (err: unknown) {
      setError(apiMessage(err));
    }
  };

  return (
    <div className="pane-in">
      <PageHeader title="Studio" subtitle="Every concept, still, part and video the studio made — newest first, each waiting on your decision." />
      {error ? <p className="mb-3 text-xs text-fail">{error}</p> : null}
      {posts === null ? (
        <div className="absence">{error ? "The queue could not be read, so this is not the answer." : "Loading the studio…"}</div>
      ) : rows.length === 0 ? (
        <div className="absence">Nothing from the studio yet — the designer's first concept lands here.</div>
      ) : (
        <div className="space-y-4">
          {rows.map((p) => (
            <article key={p.id} className="card p-4" data-post={p.id}>
              <header className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-medium">{p.title}</h2>
                {/* Approving a studio deliverable posts nothing (server/routes.ts): it is done, not "pending publish". */}
                <StatusChip status={p.status} label={p.status === "approved" ? "Approved" : undefined} />
                <KindChip kind={p.kind} />
                <span className="font-mono text-xs text-ink-3">{clientName(p.clientId)} · by {p.agent}</span>
              </header>
              <p className="mt-2 text-sm text-ink-2">{p.summary}</p>
              {p.body ? <div className="mt-2 whitespace-pre-wrap break-words text-xs text-ink-2">{p.body}</div> : null}
              {(p.files ?? []).length === 0 ? (
                <p className="absence mt-3">{p.agent} filed no file with this deliverable.</p>
              ) : (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {(p.files ?? []).map((id) => <StudioFile key={id} id={id} />)}
                </div>
              )}
              {p.rejectedReason ? <p className="mt-2 text-xs text-fail">{p.rejectedReason}</p> : null}
              {p.status === "pending" || p.status === "ready" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    aria-label={`Reason for ${p.title}`}
                    className="input max-w-xs"
                    placeholder="Reason, kept if you reject it"
                    value={why[p.id] ?? ""}
                    onChange={(e) => setWhy({ ...why, [p.id]: e.target.value })}
                  />
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void decide(p.id, "approved")}>
                    <Check size={14} strokeWidth={1.75} /> Approve
                  </button>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => void decide(p.id, "rejected")}>
                    <X size={14} strokeWidth={1.75} /> Reject
                  </button>
                  <span className="text-xs text-ink-3">Approving sends nothing — hand the files over yourself.</span>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
