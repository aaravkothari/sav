import { Bot, Box, Building2, ClipboardCheck, House, KanbanSquare, ListChecks, ShieldAlert, Settings2 } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { useApi } from "./api";
import { TEMPLATE, TEMPLATE_NAME, type Client } from "./data";
import { waitingOn, type PlatformSession } from "./platform";

/** The rail follows the studio's own geometry: a 56px workspace head sharing
 * the pane header's hairline, flat nav rows, then the active clients as a
 * framed roster — the list is the nav into each client's workspace. The counts
 * and the roster are the CRM's real rows; a new agency's rail is empty, and the
 * first lead the sales agent files appears in it. */
export function Shell() {
  const { data: clients } = useApi<Client[]>("/clients");
  // The one platform call the rail makes, and it earns it: an agent parked on an approval has
  // stopped working until someone answers it, and it is invisible on every other screen.
  const { data: sessions } = useApi<{ data?: PlatformSession[] }>("/sessions?status=idle");
  const active = (clients ?? []).filter((c) => c.stage === "active");
  const prospects = (clients ?? []).filter((c) => c.stage === "lead" || c.stage === "proposal");
  const nav = [
    { to: "/", label: "Home", Icon: House, count: undefined as number | undefined },
    { to: "/launch-review", label: "Launch review", Icon: ListChecks, count: undefined as number | undefined },
    { to: "/product-audit", label: "Product audit", Icon: ClipboardCheck, count: undefined as number | undefined },
    { to: "/crm", label: "CRM", Icon: KanbanSquare, count: prospects.length },
    { to: "/approvals", label: "Approvals", Icon: ShieldAlert, count: waitingOn(sessions?.data ?? [], new Map()).length },
    // Only a product-design studio files deliverables that are files; no other template has a Studio.
    ...(TEMPLATE_NAME === "product-design" ? [{ to: "/studio", label: "Studio", Icon: Box, count: undefined as number | undefined }] : []),
    // No count on Agents: the roster is the platform's, and the rail is not worth a call for it.
    { to: "/agents", label: "Agents", Icon: Bot, count: undefined as number | undefined },
    { to: "/clients", label: "Clients", Icon: Building2, count: active.length },
  ];

  return (
    <div className="flex h-dvh">
      <nav className="rail flex shrink-0 flex-col border-r border-line bg-ground">
        <div className="rail-head shrink-0 px-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-action text-[11px] font-medium text-on-action">
            {TEMPLATE.words.brand.slice(0, 1)}
          </span>
          <span className="min-w-0 truncate text-[0.8125rem] font-medium">{TEMPLATE.words.brand}</span>
          <span className="ml-auto font-mono text-[0.6875rem] tracking-[0.08em] text-ink-3">AGENCY</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-4">
          <div className="space-y-px">
            {nav.map(({ to, label, Icon, count }) => (
              <NavLink key={to} to={to} end={to === "/"} className="rail-row equip">
                {({ isActive }) => (
                  <>
                    <span className={`grid size-5 shrink-0 place-items-center ${isActive ? "text-ink" : "text-ink-2"}`}>
                      <Icon size={15} strokeWidth={1.75} />
                    </span>
                    <span className={`min-w-0 flex-1 truncate font-medium ${isActive ? "text-ink" : "text-ink-2"}`}>{label}</span>
                    {count ? <span className="rail-count">{count}</span> : null}
                  </>
                )}
              </NavLink>
            ))}
          </div>

          <section className="pt-4">
            <h2 className="rail-label">
              Clients{active.length > 0 ? <span className="rail-count">{active.length}</span> : null}
            </h2>
            {active.length === 0 ? (
              <p className="px-2.5 py-2 text-[0.6875rem] leading-relaxed text-ink-3">
                No active clients yet — a lead becomes one on the CRM.
              </p>
            ) : (
              <div className="rail-frame">
                {active.map((c) => (
                  <NavLink key={c.id} to={`/clients/${c.id}`} className="rail-row equip">
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium text-ink"
                      style={{ background: `hsl(${c.name.length * 37} 22% 86%)` }}
                    >
                      {c.name.slice(0, 2)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{c.name}</span>
                      <span className="block truncate text-[0.6875rem] text-ink-3">{c.domain}</span>
                    </span>
                  </NavLink>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="shrink-0 border-t border-line px-3 py-2.5">
          <NavLink to="/settings" className="rail-row equip">
            <span className="grid size-5 shrink-0 place-items-center text-ink-2">
              <Settings2 size={15} strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-ink-2">Agency settings</span>
          </NavLink>
          <div className="px-2.5 pt-2 text-[0.6875rem] leading-relaxed text-ink-3">
            Powered by your platform API key
          </div>
        </div>
      </nav>
      <main className="pane min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
