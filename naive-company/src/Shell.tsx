import { Bot, Box, CalendarClock, PhoneCall, ChevronRight, ClipboardCheck, Columns3, LayoutDashboard, ListChecks, Rocket, Rows3, ShieldCheck, Settings2, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { apiSend, useApi } from "./api";
import { leadRows, ShopName } from "./components/sav";
import { TEMPLATE_NAME, type Client } from "./data";
import { bookingRows } from "./bookings";
import { leadPath } from "./leads";
import { waitingOn, type PlatformSession } from "./platform";

/**
 * Every open screen approves held calls every 2 s (`POST /api/approvals/auto`, which approves
 * every tool call; see `server/autoapprove.ts`). One sweep at a time; when the platform is
 * rate-limiting, the next one waits longer, up to 30 s, and goes back to 2 s once it answers.
 */
export const APPROVE_EVERY_MS = 2_000;
const APPROVE_BACKOFF_MAX_MS = 30_000;

function useApproveEverything() {
  useEffect(() => {
    let live = true;
    let delay = APPROVE_EVERY_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const result = await apiSend<{ rate_limited?: boolean }>("POST", "/approvals/auto");
        delay = result.rate_limited ? Math.min(delay * 2, APPROVE_BACKOFF_MAX_MS) : APPROVE_EVERY_MS;
      } catch {
        delay = Math.min(delay * 2, APPROVE_BACKOFF_MAX_MS);
      }
      if (live) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
}

/**
 * The phone's row of tabs. It scrolls sideways, so it says when there is more: the edge that has
 * more tabs past it fades, the active tab is scrolled into view, and the arrow scrolls the rest in.
 */
function PhoneTabs({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const { pathname } = useLocation();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 4;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      setMore((was) => (was.left === left && was.right === right ? was : { left, right }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>("a.active");
    if (el && active) el.scrollLeft = active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2;
  }, [pathname]);
  return (
    <div className={`sav-tabs${more.left ? " more-left" : ""}${more.right ? " more-right" : ""}`}>
      <nav ref={ref} aria-label="Sections">{children}</nav>
      {more.right ? (
        <button type="button" className="sav-tabs-more" aria-label="More sections" onClick={() => ref.current?.scrollBy({ left: 200, behavior: "smooth" })}>
          <ChevronRight size={16} strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );
}

/** The SAV mark, as the landing page draws it. */
export const Logo = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="10.5" stroke="#1f3a3d" strokeWidth="2" />
    <circle cx="12" cy="12" r="4" fill="#1f3a3d" />
  </svg>
);

/**
 * The frame every screen sits in, dressed like the public site: a quiet paper sidebar on a laptop,
 * a sticky bar with a scrolling row of tabs on a phone. The nav is the operator's day in order —
 * what is happening, every lead, the pipeline — then the company's machinery. Live shops (the
 * CRM's active rows) are listed under it and open their shop page.
 */
export function Shell() {
  useApproveEverything();
  const { data: clients } = useApi<Client[]>("/clients");
  // The one platform call the rail makes, and it earns it: an agent parked on an approval has
  // stopped working until someone answers it, and it is invisible on every other screen.
  const { data: sessions } = useApi<{ data?: PlatformSession[] }>("/sessions?status=idle");
  const active = (clients ?? []).filter((c) => c.stage === "active");
  const waiting = waitingOn(sessions?.data ?? [], new Map()).length;
  const upcomingCalls = useMemo(() => bookingRows(clients ?? []).filter((r) => r.upcoming).length, [clients]);
  type Item = { to: string; label: string; Icon: typeof Bot; count?: number; hot?: boolean };
  const nav: Item[] = [
    { to: "/", label: "Overview", Icon: LayoutDashboard },
    { to: "/leads", label: "Leads", Icon: Rows3, count: clients ? leadRows(clients).length : undefined },
    // Sales calls with shop owners (`src/screens/Bookings.tsx`).
    { to: "/bookings", label: "Bookings", Icon: CalendarClock, count: upcomingCalls || undefined },
    // What callers asked the shops' receptionists for (`src/screens/Calls.tsx`).
    { to: "/calls", label: "Calls", Icon: PhoneCall },
    { to: "/crm", label: "Pipeline", Icon: Columns3 },
    { to: "/approvals", label: "Approvals", Icon: ShieldCheck, count: waiting, hot: waiting > 0 },
    // Where the company is started, paused and watched (`src/screens/Runs.tsx`).
    { to: "/runs", label: "Runs", Icon: Rocket },
    { to: "/agents", label: "Agents", Icon: Bot },
    // The agency blueprint's launch checks are about an agency's own site; the receptionist company (blank) has no use for them.
    ...(TEMPLATE_NAME === "blank" ? [] : [
      { to: "/launch-review", label: "Launch review", Icon: ListChecks },
      { to: "/product-audit", label: "Product audit", Icon: ClipboardCheck },
    ]),
    // Only a product-design studio files deliverables that are files; no other template has a Studio.
    ...(TEMPLATE_NAME === "product-design" ? [{ to: "/studio", label: "Studio", Icon: Box }] : []),
  ];
  const foot: Item[] = [
    { to: "/setup", label: "Project setup", Icon: SlidersHorizontal },
    { to: "/settings", label: "Settings", Icon: Settings2 },
  ];
  const link = ({ to, label, Icon, count, hot }: Item, icons = true) => (
    <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
      {icons ? <Icon size={16} strokeWidth={1.6} /> : null}
      <span>{label}</span>
      {count ? <span className={`count${hot ? " hot" : ""}`}>{count}</span> : null}
    </NavLink>
  );

  return (
    <div className="sav-shell">
      <header className="sav-top">
        <NavLink to="/" className="sav-brand"><Logo />sav<small>operations</small></NavLink>
        <PhoneTabs>{[...nav, ...foot].map((item) => link(item, false))}</PhoneTabs>
      </header>
      <aside className="sav-side">
        <NavLink to="/" className="sav-brand"><Logo />sav<small>operations</small></NavLink>
        <div className="sav-side-scroll">
          <nav className="sav-nav" aria-label="Sections">{nav.map((item) => link(item))}</nav>
          <div className="sav-side-label">Live shops</div>
          {active.length === 0 ? (
            <p className="px-[22px] text-[13px] leading-relaxed text-ink-3">None yet. A shop shows up here once it is on its free week.</p>
          ) : (
            <nav className="sav-nav sav-roster" aria-label="Live shops">
              {active.map((c) => (
                <NavLink key={c.id} to={leadPath(c)} className={({ isActive }) => (isActive ? "active" : "")}>
                  <span className="dot" /><ShopName client={c} />
                </NavLink>
              ))}
            </nav>
          )}
        </div>
        <div className="sav-side-foot">
          <nav className="sav-nav" aria-label="Settings">{foot.map((item) => link(item))}</nav>
        </div>
      </aside>
      <main className="sav-main">
        <Outlet />
      </main>
    </div>
  );
}
