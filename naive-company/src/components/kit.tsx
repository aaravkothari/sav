import type { ReactNode } from "react";
import { kindLabel, type PipelineStage, type Post, type PostStatus } from "../data";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-2">{subtitle}</p> : null}
      </div>
      {actions}
    </header>
  );
}

export const STATUS_LABEL: Record<PostStatus, string> = {
  pending: "Pending review",
  ready: "Ready",
  approved: "Approved — pending publish",
  posted: "Posted",
  rejected: "Rejected",
};

/** `label` overrides the word where a status means something else — an approved studio file is never published. */
export function StatusChip({ status, label }: { status: PostStatus; label?: string }) {
  const cls =
    status === "posted" ? "chip-credit" : status === "rejected" ? "chip-fail" : status === "pending" ? "chip-absent" : "chip-plain";
  return <span className={`chip ${cls}`}>{label ?? STATUS_LABEL[status]}</span>;
}

export const STAGE_LABEL: Record<PipelineStage, string> = {
  lead: "Lead",
  proposal: "Proposal",
  active: "Active",
  churned: "Churned",
};

export function StageChip({ stage }: { stage: PipelineStage }) {
  const cls = stage === "active" ? "chip-credit" : stage === "churned" ? "chip-fail" : "chip-plain";
  return <span className={`chip ${cls}`}>{STAGE_LABEL[stage]}</span>;
}

/** The kind as the active template names it; a row filed under another template keeps its own id. */
export function KindChip({ kind, channel }: { kind: Post["kind"]; channel?: Post["channel"] }) {
  return (
    <span className="chip chip-plain font-mono">
      {kindLabel(kind)}
      {channel ? <span className="text-ink-3"> · {channel}</span> : null}
    </span>
  );
}

export function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
