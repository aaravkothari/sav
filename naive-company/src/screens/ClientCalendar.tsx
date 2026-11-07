import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useApi } from "../api";
import { STATUS_LABEL } from "../components/kit";
import type { Post, PostStatus } from "../data";
import { useClient } from "./ClientWorkspace";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const DOT: Record<PostStatus, string> = {
  pending: "dot-warn",
  ready: "dot-idle",
  approved: "dot-run",
  posted: "dot-ok",
  rejected: "dot-fail",
};

const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** A month grid over the client's queue, keyed on `scheduledFor`. Opens on the
 * current month; the arrows page to whatever is scheduled elsewhere. */
export function ClientCalendar() {
  const client = useClient();
  const { data: posts, error } = useApi<Post[]>("/posts");
  const today = new Date();
  const [month, setMonth] = useState<{ y: number; m: number }>({ y: today.getFullYear(), m: today.getMonth() });
  const mine = (posts ?? []).filter((p) => p.clientId === client.id);

  const firstDay = new Date(month.y, month.m, 1);
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const lead = (firstDay.getDay() + 6) % 7; // Monday-first offset
  const cells: (number | null)[] = [...Array.from({ length: lead }, () => null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const title = firstDay.toLocaleString("en-US", { month: "long", year: "numeric" });
  const shift = (by: number) => setMonth(({ y, m }) => ({ y: y + Math.floor((m + by) / 12), m: ((m + by) % 12 + 12) % 12 }));

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="eyebrow">{title}</span>
        <div className="flex items-center gap-3">
          {error ? <span className="text-xs text-fail">{error}</span> : null}
          <div className="flex gap-1.5">
            <button type="button" className="btn btn-ghost btn-sm" aria-label="Previous month" onClick={() => shift(-1)}>
              <ChevronLeft size={14} strokeWidth={1.75} />
            </button>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="Next month" onClick={() => shift(1)}>
              <ChevronRight size={14} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="grid grid-cols-7 border-b border-line">
          {DOW.map((d) => (
            <div key={d} className="px-2 py-1.5 text-center font-mono text-[0.6875rem] tracking-[0.08em] text-ink-3 uppercase">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((day, i) => {
            const slot = day === null ? [] : mine.filter((p) => p.scheduledFor === iso(month.y, month.m, day));
            return (
              <div key={i} className={`min-h-24 border-line p-1.5 ${i % 7 !== 0 ? "border-l" : ""} ${i >= 7 ? "border-t" : ""}`}>
                {day !== null ? <div className="mb-1 font-mono text-xs text-ink-3">{day}</div> : null}
                <div className="space-y-1">
                  {slot.map((p) => (
                    <div key={p.id} className="flex items-center gap-1.5 rounded-sm bg-sunken px-1.5 py-1" title={`${p.title} — ${STATUS_LABEL[p.status]}`}>
                      <span className={`dot ${DOT[p.status]}`} aria-hidden />
                      <span className="min-w-0 truncate text-[0.6875rem] leading-tight">{p.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {posts !== null && mine.length === 0 ? (
        <div className="absence mt-3">Nothing scheduled for {client.name} yet.</div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-ink-3">
        {(Object.keys(DOT) as PostStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`dot ${DOT[s]}`} aria-hidden /> {STATUS_LABEL[s]}
          </span>
        ))}
      </div>
    </div>
  );
}
